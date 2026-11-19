/**
 * Outbox-Verarbeitung: holt fällige Mails, rendert sie zum Versandzeitpunkt
 * und verschickt sie über den passenden Weg.
 *
 * - Aufruf per Cron (/api/cron/outbox) und direkt nach Buchung/Einladung (after()).
 * - Parallel sicher: Zeilen werden mit FOR UPDATE SKIP LOCKED beansprucht.
 * - Weg (lib/mail/routing.ts):
 *     Einladung      INVITE_MAIL_PROVIDER = pipedrive | oauth | smtp
 *     Bestätigung/   System-SMTP (SYSTEM_MAIL_*), Reply-To = Einladender
 *     Stornierung
 *     Testmail       genau das zu prüfende Postfach; Erfolg schaltet es aktiv
 * - Kein stiller Wechsel des Weges: Fehlt etwas (kein Postfach in Pipedrive,
 *   Recht fehlt, …), wird die Einladung mit error_code als fehlgeschlagen
 *   markiert – der Mitarbeiter sieht eine verständliche Meldung.
 * - Smart BCC: Kundenmails in Kopie an tenants.smart_bcc_email (außer beim
 *   Versand über Pipedrive – dort legt Pipedrive die Mail selbst ab).
 * - Vorübergehende Fehler -> Retry mit Backoff, nach MAX_ATTEMPTS -> failed.
 */
import type pg from "pg";
import { withActorOn } from "@/lib/db/actor";
import { decryptSecret } from "@/lib/crypto/secretbox";
import { bookingIcs } from "@/lib/booking/ics";
import { parseTheme } from "@/lib/theme/schema";
import { parseTextOverrides } from "@/lib/texts";
import { assetStorage } from "@/lib/storage";
import { markUserConnectionError, userPipedriveAccess } from "@/lib/pipedrive/user-connection";
import { renderCancellation, renderConfirmation, renderInvitation, renderTest, type MailTenant, type RenderedMail } from "./templates";
import { defaultSenderFactory, type SenderFactory, type SenderTarget } from "./senders";
import { MailSendError, type MailAddress, type MailAttachment, type MailConnection, type MailMessage } from "./types";
import { inviteMailProvider, systemMailConfig, type InviteMailProvider, type SystemMailConfig } from "./config";
import { routeMail, type Inviter } from "./routing";

export const MAX_ATTEMPTS = 8;
/** Wartezeit nach dem n-ten Fehlversuch (Minuten) */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480];
/** Wartezeit, solange der Weg nicht verfügbar ist (z. B. System-SMTP nicht konfiguriert) */
export const CONNECTION_RETRY_MINUTES = 15;
/** "sending" länger als das -> Prozess vermutlich abgestürzt, erneut versuchen */
const STALE_LOCK_MINUTES = 10;

export type OutboxRow = {
  id: string;
  tenant_id: string;
  type: "invitation" | "confirmation" | "cancellation" | "test";
  to_email: string;
  payload: Record<string, unknown>;
  attempts: number;
  mail_connection_id: string | null;
};

export type ProcessResult = { sent: number; requeued: number; failed: number; blocked: number };

type Options = {
  limit?: number;
  senderFactory?: SenderFactory;
  tenantId?: string;
  /** Standard: INVITE_MAIL_PROVIDER */
  inviteProvider?: InviteMailProvider;
  /** Standard: SYSTEM_MAIL_* (null = nicht konfiguriert) */
  systemConfig?: SystemMailConfig | null;
};

const asService = <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) =>
  withActorOn(pool, { role: "service_role" }, fn);

export async function processOutbox(pool: pg.Pool, opts: Options = {}): Promise<ProcessResult> {
  const limit = opts.limit ?? 20;
  const env = {
    senderFactory: opts.senderFactory ?? defaultSenderFactory,
    inviteProvider: opts.inviteProvider ?? inviteMailProvider(),
    system: opts.systemConfig !== undefined ? opts.systemConfig : systemMailConfig(),
  };
  const result: ProcessResult = { sent: 0, requeued: 0, failed: 0, blocked: 0 };

  const rows = await asService(pool, async (c) => {
    const { rows } = await c.query<OutboxRow>(
      `update public.email_outbox o
          set status = 'sending', locked_at = now(), attempts = o.attempts + 1
        where o.id in (
          select id from public.email_outbox
           where ((status = 'queued' and next_attempt_at <= now())
              or (status = 'sending' and locked_at < now() - make_interval(mins => $2)))
             and ($3::uuid is null or tenant_id = $3)
           order by next_attempt_at
           limit $1
           for update skip locked)
        returning id, tenant_id, type, to_email, payload, attempts, mail_connection_id`,
      [limit, STALE_LOCK_MINUTES, opts.tenantId ?? null],
    );
    return rows;
  });

  for (const row of rows) {
    const outcome = await processOne(pool, row, env);
    result[outcome] += 1;
  }
  return result;
}

type Env = { senderFactory: SenderFactory; inviteProvider: InviteMailProvider; system: SystemMailConfig | null };

/** Wohin und wie: Ziel für die Sender-Fabrik + Daten für die Mail */
type Plan = {
  target: SenderTarget;
  channel: "pipedrive" | "oauth" | "smtp" | "system" | "connection";
  from: MailAddress;
  replyTo: MailAddress | null;
  withSmartBcc: boolean;
  connection: MailConnection | null;
  pipedriveUserId: string | null;
  storeRendered: boolean;
};

type Prepared = { kind: "send"; plan: Plan; ctx: MailContext } | { kind: "blocked"; reason: string } | { kind: "failed"; reason: string; code: string };

async function processOne(pool: pg.Pool, row: OutboxRow, env: Env): Promise<keyof ProcessResult> {
  let prepared: Prepared;
  try {
    prepared = await prepare(pool, row, env);
  } catch (err) {
    await markFailed(pool, row.id, `Vorbereitung fehlgeschlagen: ${(err as Error).message}`, "generic");
    return "failed";
  }
  if (prepared.kind === "blocked") {
    await requeueBlocked(pool, row.id, prepared.reason);
    return "blocked";
  }
  if (prepared.kind === "failed") {
    await markFailed(pool, row.id, prepared.reason, prepared.code);
    return "failed";
  }
  const { plan, ctx } = prepared;

  let message: MailMessage;
  try {
    message = buildMessage(row, plan, ctx);
  } catch (err) {
    await markFailed(pool, row.id, `Rendern fehlgeschlagen: ${(err as Error).message}`, "generic");
    return "failed";
  }

  try {
    const sender = env.senderFactory(plan.target, {
      saveCredentials: plan.connection
        ? (enc) =>
            asService(pool, async (c) => {
              await c.query("update public.mail_connections set credentials_enc = $2 where id = $1", [plan.connection!.id, enc]);
            })
        : undefined,
    });
    const { messageId } = await sender.send(message);
    await asService(pool, async (c) => {
      await c.query(
        `update public.email_outbox
            set status = 'sent', sent_at = now(), locked_at = null, last_error = null, error_code = null,
                provider_message_id = $2, mail_connection_id = $3, send_channel = $6,
                rendered = case when $4 then $5::jsonb else null end
          where id = $1`,
        [row.id, messageId, plan.connection?.id ?? null, plan.storeRendered, JSON.stringify(message), plan.channel],
      );
      // Einladung nicht über Pipedrive versendet -> Notiz "Link gesendet" im Deal
      if (row.type === "invitation" && plan.channel !== "pipedrive" && ctx.invitation?.pipedrive_deal_id) {
        await c.query(
          "insert into public.pipedrive_jobs (tenant_id, type, payload) values ($1, 'invitation_note', $2)",
          [row.tenant_id, { invitation_id: ctx.invitation.id, outbox_id: row.id }],
        );
      }
      if (row.type === "test" && plan.connection) {
        await c.query(
          `update public.mail_connections set status = 'active', last_error = null, last_verified_at = now()
            where id = $1 and status <> 'revoked'`,
          [plan.connection.id],
        );
      }
    });
    return "sent";
  } catch (err) {
    const e = err instanceof MailSendError ? err : new MailSendError("transient", (err as Error)?.message ?? String(err));
    return handleSendError(pool, row, plan, e);
  }
}

async function handleSendError(pool: pg.Pool, row: OutboxRow, plan: Plan, e: MailSendError): Promise<keyof ProcessResult> {
  // Postfach (Testmail / oauth-Einladung): Anmeldefehler -> Postfach gestört
  if (plan.connection && (e.kind === "auth" || (row.type === "test" && e.kind === "permanent"))) {
    await asService(pool, (c) =>
      c.query("update public.mail_connections set status = 'error', last_error = $2 where id = $1", [plan.connection!.id, e.message]),
    );
    await markFailed(pool, row.id, e.message, row.type === "test" ? "mailbox_error" : "user_mailbox_error");
    return "failed";
  }
  // Pipedrive: Anmeldung/Recht/kein Postfach -> Meldung an den Mitarbeiter, kein anderer Weg
  if (plan.pipedriveUserId && e.kind !== "transient") {
    if (e.kind === "auth") await markUserConnectionError(pool, row.tenant_id, plan.pipedriveUserId, e.message);
    await markFailed(pool, row.id, e.message, e.code ?? "pipedrive_rejected");
    return "failed";
  }
  // System-SMTP: Anmeldung gescheitert -> warten, bis die Konfiguration stimmt
  if (!plan.connection && !plan.pipedriveUserId && e.kind === "auth") {
    await requeueBlocked(pool, row.id, `System-Absender: ${e.message}`);
    return "blocked";
  }
  if (e.kind !== "transient" || row.attempts >= MAX_ATTEMPTS) {
    await markFailed(pool, row.id, e.message, e.code ?? (e.kind === "transient" ? "unavailable" : "rejected"));
    return "failed";
  }
  const wait = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)]!;
  await asService(pool, (c) =>
    c.query(
      `update public.email_outbox
          set status = 'queued', locked_at = null, last_error = $2, error_code = $4,
              next_attempt_at = now() + make_interval(mins => $3)
        where id = $1`,
      [row.id, e.message, wait, e.code ?? null],
    ),
  );
  return "requeued";
}

/** Zurück in die Warteschlange, Versuch zählt nicht */
async function requeueBlocked(pool: pg.Pool, id: string, reason: string, waitMinutes = CONNECTION_RETRY_MINUTES) {
  await asService(pool, (c) =>
    c.query(
      `update public.email_outbox
          set status = 'queued', locked_at = null, attempts = greatest(attempts - 1, 0), last_error = $2,
              next_attempt_at = now() + make_interval(mins => $3)
        where id = $1`,
      [id, reason, waitMinutes],
    ),
  );
}

async function markFailed(pool: pg.Pool, id: string, reason: string, code: string) {
  await asService(pool, (c) =>
    c.query("update public.email_outbox set status = 'failed', locked_at = null, last_error = $2, error_code = $3 where id = $1", [id, reason, code]),
  );
}

// ---------------------------------------------------------------------
// Kontext laden und Weg bestimmen
// ---------------------------------------------------------------------

type ConnRow = {
  id: string;
  tenant_id: string;
  provider: MailConnection["provider"];
  sender_email: string;
  sender_name: string | null;
  status: MailConnection["status"];
  credentials_enc: string | null;
};
const CONN_COLS = "id, tenant_id, provider, sender_email, sender_name, status, credentials_enc";
const toConnection = (r: ConnRow): MailConnection => ({
  id: r.id,
  tenantId: r.tenant_id,
  provider: r.provider,
  senderEmail: r.sender_email,
  senderName: r.sender_name,
  status: r.status,
  credentialsEnc: r.credentials_enc,
});

type TenantRow = {
  name: string;
  slug: string;
  theme: unknown;
  anrede: "sie" | "ihr";
  text_overrides: unknown;
  contact_line: string | null;
  legal_links: unknown;
  timezone: string;
  change_deadline_hours: number;
  logo_path: string | null;
  sender_name: string | null;
  reply_to_email: string | null;
  smart_bcc_email: string | null;
};

type InvitationRow = {
  id: string;
  name: string;
  expires_at: Date;
  pipedrive_deal_id: string | null;
  created_by: string | null;
  event_title: string;
};

type BookingRow = {
  id: string;
  name: string;
  seats: number;
  extra_attendees: string[] | null;
  invitation_id: string;
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  title: string;
  created_at: Date;
  cancelled_at: Date | null;
};

type MailContext = {
  tenantRow: TenantRow;
  inviter: (Inviter & { signature: string | null }) | null;
  invitation: InvitationRow | null;
  booking: BookingRow | null;
};

async function loadContext(pool: pg.Pool, row: OutboxRow): Promise<MailContext> {
  return asService(pool, async (c) => {
    const { rows: t } = await c.query<TenantRow>("select * from public.tenants where id = $1", [row.tenant_id]);
    if (!t[0]) throw new Error("Mandant nicht gefunden");
    let booking: BookingRow | null = null;
    if (typeof row.payload.booking_id === "string") {
      const { rows } = await c.query<BookingRow>(
        `select b.id, b.name, b.seats, b.extra_attendees, b.invitation_id,
                s.starts_at, s.ends_at, coalesce(s.location, e.location) as location, e.title,
                b.created_at, b.cancelled_at
           from public.bookings b
           join public.slots s on s.id = b.slot_id
           join public.events e on e.id = s.event_id
          where b.id = $1 and b.tenant_id = $2`,
        [row.payload.booking_id, row.tenant_id],
      );
      booking = rows[0] ?? null;
      if (!booking) throw new Error(`Buchung ${row.payload.booking_id} nicht gefunden`);
    }
    const invitationId = typeof row.payload.invitation_id === "string" ? row.payload.invitation_id : (booking?.invitation_id ?? null);
    let invitation: InvitationRow | null = null;
    if (invitationId) {
      const { rows } = await c.query<InvitationRow>(
        `select i.id, i.name, i.expires_at, i.pipedrive_deal_id::text, i.created_by, e.title as event_title
           from public.invitations i join public.events e on e.id = i.event_id
          where i.id = $1 and i.tenant_id = $2`,
        [invitationId, row.tenant_id],
      );
      invitation = rows[0] ?? null;
    }
    let inviter: MailContext["inviter"] = null;
    if (invitation?.created_by) {
      const { rows } = await c.query<{ display_name: string | null; email: string | null; status: string; mail_signature: string | null }>(
        "select display_name, email, status::text, mail_signature from public.tenant_members where tenant_id = $1 and user_id = $2",
        [row.tenant_id, invitation.created_by],
      );
      const m = rows[0];
      if (m) {
        inviter = { userId: invitation.created_by, name: m.display_name, email: m.email, active: m.status === "active", signature: m.mail_signature };
      }
    }
    return { tenantRow: t[0], inviter, invitation, booking };
  });
}

async function prepare(pool: pg.Pool, row: OutboxRow, env: Env): Promise<Prepared> {
  const ctx = await loadContext(pool, row);
  const tenantName = ctx.tenantRow.sender_name ?? ctx.tenantRow.name;

  // Testmail: genau über das zu prüfende Postfach
  if (row.type === "test") {
    if (!row.mail_connection_id) return { kind: "failed", reason: "Testmail ohne Postfach", code: "mailbox_error" };
    const conn = await asService(pool, async (c) => {
      const { rows } = await c.query<ConnRow>(`select ${CONN_COLS} from public.mail_connections where id = $1 and tenant_id = $2`, [
        row.mail_connection_id,
        row.tenant_id,
      ]);
      return rows[0] ? toConnection(rows[0]) : null;
    });
    if (!conn || conn.status === "revoked") return { kind: "failed", reason: "Postfach nicht mehr vorhanden", code: "mailbox_error" };
    return {
      kind: "send",
      ctx,
      plan: {
        target: { kind: "connection", connection: conn },
        channel: "connection",
        from: { email: conn.senderEmail, name: conn.senderName ?? tenantName },
        replyTo: null,
        withSmartBcc: false,
        connection: conn,
        pipedriveUserId: null,
        storeRendered: conn.provider === "dev",
      },
    };
  }

  // Eigenes Postfach des Einladenden (nur für oauth relevant)
  let userConnection: MailConnection | null = null;
  if (row.type === "invitation" && env.inviteProvider === "oauth" && ctx.inviter) {
    userConnection = await asService(pool, async (c) => {
      const { rows } = await c.query<ConnRow>(
        `select ${CONN_COLS} from public.mail_connections where tenant_id = $1 and scope = 'user' and user_id = $2`,
        [row.tenant_id, ctx.inviter!.userId],
      );
      return rows[0] ? toConnection(rows[0]) : null;
    });
  }

  const route = routeMail(row.type, env.inviteProvider, { inviter: ctx.inviter, userConnection });
  switch (route.kind) {
    case "error":
      return { kind: "failed", reason: route.message, code: route.code };
    case "system": {
      if (!env.system) return { kind: "blocked", reason: "System-Absender nicht konfiguriert (SYSTEM_MAIL_FROM / SYSTEM_SMTP_*)" };
      const tenantReply = ctx.tenantRow.reply_to_email ? { email: ctx.tenantRow.reply_to_email, name: ctx.tenantRow.name } : null;
      return {
        kind: "send",
        ctx,
        plan: {
          target: { kind: "system", config: env.system },
          channel: route.channel,
          from: { email: env.system.fromEmail, name: route.fromName ?? env.system.fromName ?? tenantName },
          replyTo: route.replyTo ?? tenantReply,
          withSmartBcc: true,
          connection: null,
          pipedriveUserId: null,
          storeRendered: env.system.transport === "dev",
        },
      };
    }
    case "pipedrive":
      return {
        kind: "send",
        ctx,
        plan: {
          target: { kind: "pipedrive", access: () => userPipedriveAccess(pool, row.tenant_id, route.userId) },
          channel: "pipedrive",
          from: { email: ctx.inviter?.email ?? "", name: ctx.inviter?.name ?? null },
          replyTo: null,
          // Pipedrive legt die Mail selbst beim Deal ab – keine Kopie per Smart BCC
          withSmartBcc: false,
          connection: null,
          pipedriveUserId: route.userId,
          storeRendered: false,
        },
      };
    case "connection":
      return {
        kind: "send",
        ctx,
        plan: {
          target: { kind: "connection", connection: route.connection },
          channel: "oauth",
          from: { email: route.connection.senderEmail, name: route.connection.senderName ?? ctx.inviter?.name ?? tenantName },
          replyTo: null,
          withSmartBcc: true,
          connection: route.connection,
          pipedriveUserId: null,
          storeRendered: route.connection.provider === "dev",
        },
      };
  }
}

// ---------------------------------------------------------------------
// Mail zusammenbauen
// ---------------------------------------------------------------------

function toMailTenant(t: TenantRow): MailTenant {
  const storage = assetStorage();
  let logoUrl: string | null = null;
  // SVG zeigen viele Mail-Clients (z. B. Gmail) nicht an -> dann Name als Text
  if (t.logo_path && /\.(png|jpe?g)$/i.test(t.logo_path)) {
    const url = storage.publicUrl(t.logo_path);
    // relative URL enthält den Unterpfad bereits -> nur den Origin davorsetzen
    logoUrl = url.startsWith("http") ? url : `${new URL(process.env.APP_BASE_URL ?? "http://localhost:3000").origin}${url}`;
  }
  return {
    name: t.name,
    theme: parseTheme(t.theme),
    anrede: t.anrede,
    textOverrides: parseTextOverrides(t.text_overrides),
    contactLine: t.contact_line,
    legalLinks: Array.isArray(t.legal_links) ? (t.legal_links as MailTenant["legalLinks"]) : [],
    timezone: t.timezone,
    changeDeadlineHours: t.change_deadline_hours,
    logoUrl,
  };
}

function openLink(payload: Record<string, unknown>): string | null {
  const enc = payload.link_enc;
  if (typeof enc !== "string" || !enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

function buildMessage(row: OutboxRow, plan: Plan, ctx: MailContext): MailMessage {
  const tenant = toMailTenant(ctx.tenantRow);
  let rendered: RenderedMail;
  let toName: string | null = null;
  const attachments: MailAttachment[] = [];
  let dealId: number | null = null;

  if (row.type === "confirmation" || row.type === "cancellation") {
    const b = ctx.booking;
    if (!b) throw new Error("Buchung fehlt");
    toName = b.name;
    const bookingUrl = openLink(row.payload);
    const icsFilename = `termin-${ctx.tenantRow.slug}.ics`;
    const ics = bookingIcs({
      tenantName: tenant.name,
      invitationId: b.invitation_id,
      title: b.title,
      start: new Date(b.starts_at),
      end: new Date(b.ends_at),
      location: b.location,
      url: bookingUrl,
      organizer: { name: plan.from.name ?? tenant.name, email: plan.from.email },
      versionAt: new Date(row.type === "cancellation" && b.cancelled_at ? b.cancelled_at : b.created_at),
      cancelled: row.type === "cancellation",
    });
    attachments.push({ filename: icsFilename, contentType: "text/calendar; charset=utf-8", content: ics });
    const base = { eventTitle: b.title, startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at), location: b.location, seats: b.seats, name: b.name, bookingUrl };
    rendered =
      row.type === "confirmation"
        ? renderConfirmation(tenant, { ...base, extraAttendees: b.extra_attendees ?? [], icsFilename, changed: Boolean(row.payload.replaces_booking_id) })
        : renderCancellation(tenant, base);
  } else if (row.type === "invitation") {
    const inv = ctx.invitation;
    const link = openLink(row.payload);
    if (!inv || !link) throw new Error("Einladung oder Buchungslink fehlt");
    toName = inv.name;
    dealId = inv.pipedrive_deal_id ? Number(inv.pipedrive_deal_id) : null;
    const validDays = Math.max(1, Math.ceil((new Date(inv.expires_at).getTime() - Date.now()) / 86_400_000));
    rendered = renderInvitation(tenant, {
      eventTitle: inv.event_title,
      name: inv.name,
      bookingUrl: link,
      validDays,
      senderName: ctx.inviter?.name ?? tenant.name,
      signature: ctx.inviter?.signature ?? null,
    });
  } else {
    rendered = renderTest(tenant);
  }

  const bcc = plan.withSmartBcc && ctx.tenantRow.smart_bcc_email ? [{ email: ctx.tenantRow.smart_bcc_email }] : undefined;
  return {
    from: plan.from,
    to: { email: row.to_email, name: toName },
    replyTo: plan.replyTo,
    bcc,
    pipedriveDealId: dealId,
    ...rendered,
    attachments,
  };
}
