/**
 * Outbox-Verarbeitung: holt fällige Mails, rendert sie zum Versandzeitpunkt
 * und verschickt sie über das Postfach des Mandanten.
 *
 * - Aufruf per Cron (/api/cron/outbox) und direkt nach einer Buchung (after()).
 * - Parallel sicher: Zeilen werden mit FOR UPDATE SKIP LOCKED beansprucht.
 * - Absender: lib/mail/sender-choice.ts (Mitarbeiter-Postfach, sonst Firmen-
 *   postfach; Bestätigungen bei gestörtem Mitarbeiter-Postfach sichtbar über das
 *   Firmenpostfach, Einladungen warten). Kein stiller Absenderwechsel.
 * - Bei Anmeldefehler wird die Verbindung auf "error" gesetzt.
 * - Testmails gehen genau über das zu prüfende Postfach; Erfolg schaltet es aktiv.
 * - Smart BCC: Kundenmails gehen in Kopie an tenants.smart_bcc_email (Pipedrive).
 * - Vorübergehende Fehler -> Retry mit Backoff, nach MAX_ATTEMPTS -> failed.
 */
import type pg from "pg";
import { withActorOn } from "@/lib/db/actor";
import { decryptSecret } from "@/lib/crypto/secretbox";
import { bookingIcs } from "@/lib/booking/ics";
import { parseTheme } from "@/lib/theme/schema";
import { parseTextOverrides } from "@/lib/texts";
import { assetStorage } from "@/lib/storage";
import { renderCancellation, renderConfirmation, renderTest, type MailTenant, type RenderedMail } from "./templates";
import { defaultSenderFactory, type SenderFactory } from "./senders";
import { MailSendError, type MailAttachment, type MailConnection, type MailMessage } from "./types";
import { chooseSender } from "./sender-choice";

export const MAX_ATTEMPTS = 8;
/** Wartezeit nach dem n-ten Fehlversuch (Minuten) */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480];
/** Wartezeit, solange kein aktives Postfach verbunden ist */
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

type Options = { limit?: number; senderFactory?: SenderFactory; tenantId?: string };

const asService = <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) =>
  withActorOn(pool, { role: "service_role" }, fn);

export async function processOutbox(pool: pg.Pool, opts: Options = {}): Promise<ProcessResult> {
  const limit = opts.limit ?? 20;
  const senderFactory = opts.senderFactory ?? defaultSenderFactory;
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
    const outcome = await processOne(pool, row, senderFactory);
    result[outcome] += 1;
  }
  return result;
}

async function processOne(
  pool: pg.Pool,
  row: OutboxRow,
  senderFactory: SenderFactory,
): Promise<keyof ProcessResult> {
  const pick = await pickConnection(pool, row);
  if (pick.kind === "blocked") {
    await requeueBlocked(pool, row.id, pick.reason);
    return "blocked";
  }
  const { connection, fallbackReason, isUserConnection } = pick;

  let message: MailMessage;
  try {
    message = await buildMessage(pool, row, connection);
  } catch (err) {
    await markFailed(pool, row.id, `Rendern fehlgeschlagen: ${(err as Error).message}`);
    return "failed";
  }

  try {
    const sender = senderFactory(connection, {
      saveCredentials: (enc) =>
        asService(pool, async (c) => {
          await c.query("update public.mail_connections set credentials_enc = $2 where id = $1", [connection.id, enc]);
        }),
    });
    const { messageId } = await sender.send(message);
    await asService(pool, async (c) => {
      await c.query(
        `update public.email_outbox
            set status = 'sent', sent_at = now(), locked_at = null, last_error = null,
                provider_message_id = $2, mail_connection_id = $3, sender_fallback_reason = $6,
                rendered = case when $4 then $5::jsonb else null end
          where id = $1`,
        [row.id, messageId, connection.id, connection.provider === "dev", JSON.stringify(message), fallbackReason],
      );
      // Erfolgreiche Testmail bestätigt das Postfach
      if (row.type === "test") {
        await c.query(
          `update public.mail_connections set status = 'active', last_error = null, last_verified_at = now()
            where id = $1 and status <> 'revoked'`,
          [connection.id],
        );
      }
    });
    return "sent";
  } catch (err) {
    const e = err instanceof MailSendError ? err : new MailSendError("transient", (err as Error)?.message ?? String(err));
    if (e.kind === "auth" || (row.type === "test" && e.kind === "permanent")) {
      await asService(pool, (c) =>
        c.query("update public.mail_connections set status = 'error', last_error = $2 where id = $1", [connection.id, e.message]),
      );
      if (row.type === "test") {
        await markFailed(pool, row.id, e.message);
        return "failed";
      }
      // Bestätigung/Stornierung über ein Mitarbeiter-Postfach: sofort erneut
      // einplanen – dann greift das Firmenpostfach (sichtbar vermerkt)
      await requeueBlocked(pool, row.id, e.message, isUserConnection && row.type !== "invitation" ? 0 : CONNECTION_RETRY_MINUTES);
      return "blocked";
    }
    if (e.kind === "permanent" || row.attempts >= MAX_ATTEMPTS) {
      await markFailed(pool, row.id, e.message);
      return "failed";
    }
    const wait = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)]!;
    await asService(pool, (c) =>
      c.query(
        `update public.email_outbox
            set status = 'queued', locked_at = null, last_error = $2,
                next_attempt_at = now() + make_interval(mins => $3)
          where id = $1`,
        [row.id, e.message, wait],
      ),
    );
    return "requeued";
  }
}

/** Ohne aktives Postfach: zurück in die Warteschlange, Versuch zählt nicht */
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

async function markFailed(pool: pg.Pool, id: string, reason: string) {
  await asService(pool, (c) =>
    c.query("update public.email_outbox set status = 'failed', locked_at = null, last_error = $2 where id = $1", [id, reason]),
  );
}

type ConnRow = {
  id: string;
  tenant_id: string;
  provider: MailConnection["provider"];
  sender_email: string;
  sender_name: string | null;
  status: MailConnection["status"];
  credentials_enc: string | null;
  scope: "tenant" | "user";
};

const toConnection = (r: ConnRow): MailConnection => ({
  id: r.id,
  tenantId: r.tenant_id,
  provider: r.provider,
  senderEmail: r.sender_email,
  senderName: r.sender_name,
  status: r.status,
  credentialsEnc: r.credentials_enc,
});

type Pick =
  | { kind: "send"; connection: MailConnection; fallbackReason: string | null; isUserConnection: boolean }
  | { kind: "blocked"; reason: string };

/**
 * Postfach für diese Mail. Testmails (und Mails mit fest zugeordnetem
 * Postfach) gehen genau darüber; sonst entscheidet chooseSender.
 */
async function pickConnection(pool: pg.Pool, row: OutboxRow): Promise<Pick> {
  return asService(pool, async (c): Promise<Pick> => {
    const cols = "id, tenant_id, provider, sender_email, sender_name, status, credentials_enc, scope::text as scope";
    if (row.mail_connection_id) {
      const { rows } = await c.query<ConnRow>(`select ${cols} from public.mail_connections where id = $1 and tenant_id = $2`, [
        row.mail_connection_id,
        row.tenant_id,
      ]);
      const r = rows[0];
      if (!r) return { kind: "blocked", reason: "Postfach nicht mehr vorhanden" };
      // Testmails prüfen gerade NICHT aktive Postfächer; alle anderen brauchen "active"
      if (r.status === "revoked" || (row.type !== "test" && r.status !== "active")) {
        return { kind: "blocked", reason: `Postfach ${r.sender_email} ist nicht aktiv (${r.status})` };
      }
      return { kind: "send", connection: toConnection(r), fallbackReason: null, isUserConnection: r.scope === "user" };
    }
    if (row.type === "test") return { kind: "blocked", reason: "Testmail ohne Postfach" };

    // Wer hat eingeladen? (Einladung direkt, Bestätigung/Stornierung über die Buchung)
    const invitationId = typeof row.payload.invitation_id === "string" ? row.payload.invitation_id : null;
    const bookingId = typeof row.payload.booking_id === "string" ? row.payload.booking_id : null;
    const { rows: inv } = await c.query<{ created_by: string | null }>(
      `select i.created_by from public.invitations i
        where i.tenant_id = $1
          and i.id = coalesce($2::uuid, (select b.invitation_id from public.bookings b where b.id = $3::uuid))`,
      [row.tenant_id, invitationId, bookingId],
    );
    const inviter = inv[0]?.created_by ?? null;
    const { rows } = await c.query<ConnRow>(
      `select ${cols} from public.mail_connections mc
        where mc.tenant_id = $1
          and (mc.scope = 'tenant'
               or (mc.scope = 'user' and mc.user_id = $2::uuid
                   and exists (select 1 from public.tenant_members m
                                where m.tenant_id = mc.tenant_id and m.user_id = mc.user_id and m.status = 'active')))`,
      [row.tenant_id, inviter],
    );
    const userRow = rows.find((r) => r.scope === "user");
    const tenantRow = rows.find((r) => r.scope === "tenant");
    const user = userRow ? toConnection(userRow) : null;
    const choice = chooseSender(row.type, { user, tenant: tenantRow ? toConnection(tenantRow) : null });
    if (choice.kind === "blocked") return choice;
    return { ...choice, isUserConnection: choice.connection.id === user?.id };
  });
}

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

function toMailTenant(t: TenantRow): MailTenant {
  const storage = assetStorage();
  let logoUrl: string | null = null;
  // SVG zeigen viele Mail-Clients (z. B. Gmail) nicht an -> dann Name als Text
  if (t.logo_path && /\.(png|jpe?g)$/i.test(t.logo_path)) {
    const url = storage.publicUrl(t.logo_path);
    logoUrl = url.startsWith("http") ? url : `${(process.env.APP_BASE_URL ?? "").replace(/\/$/, "")}${url}`;
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

async function buildMessage(pool: pg.Pool, row: OutboxRow, conn: MailConnection): Promise<MailMessage> {
  const tenantRow = await asService(pool, async (c) => {
    const { rows } = await c.query<TenantRow>("select * from public.tenants where id = $1", [row.tenant_id]);
    if (!rows[0]) throw new Error("Mandant nicht gefunden");
    return rows[0];
  });
  const tenant = toMailTenant(tenantRow);
  const from = { email: conn.senderEmail, name: conn.senderName ?? tenantRow.sender_name ?? tenant.name };
  const replyTo = tenantRow.reply_to_email ? { email: tenantRow.reply_to_email, name: tenant.name } : null;

  let rendered: RenderedMail;
  let toName: string | null = null;
  const attachments: MailAttachment[] = [];

  if (row.type === "confirmation" || row.type === "cancellation") {
    const bookingId = String(row.payload.booking_id ?? "");
    const b = await asService(pool, async (c) => {
      const { rows } = await c.query(
        `select b.id, b.name, b.seats, b.extra_attendees, b.invitation_id,
                s.starts_at, s.ends_at, coalesce(s.location, e.location) as location, e.title,
                b.created_at, b.cancelled_at
           from public.bookings b
           join public.slots s on s.id = b.slot_id
           join public.events e on e.id = s.event_id
          where b.id = $1 and b.tenant_id = $2`,
        [bookingId, row.tenant_id],
      );
      if (!rows[0]) throw new Error(`Buchung ${bookingId} nicht gefunden`);
      return rows[0];
    });
    toName = b.name;
    const bookingUrl = openLink(row.payload);
    const icsFilename = `termin-${tenantRow.slug}.ics`;
    const ics = bookingIcs({
      tenantName: tenant.name,
      invitationId: b.invitation_id,
      title: b.title,
      start: new Date(b.starts_at),
      end: new Date(b.ends_at),
      location: b.location,
      url: bookingUrl,
      organizer: { name: from.name, email: from.email },
      versionAt: new Date(row.type === "cancellation" && b.cancelled_at ? b.cancelled_at : b.created_at),
      cancelled: row.type === "cancellation",
    });
    attachments.push({ filename: icsFilename, contentType: "text/calendar; charset=utf-8", content: ics });

    rendered =
      row.type === "confirmation"
        ? renderConfirmation(tenant, {
            eventTitle: b.title,
            startsAt: new Date(b.starts_at),
            endsAt: new Date(b.ends_at),
            location: b.location,
            seats: b.seats,
            name: b.name,
            extraAttendees: b.extra_attendees ?? [],
            bookingUrl,
            icsFilename,
            changed: Boolean(row.payload.replaces_booking_id),
          })
        : renderCancellation(tenant, {
            eventTitle: b.title,
            startsAt: new Date(b.starts_at),
            endsAt: new Date(b.ends_at),
            location: b.location,
            seats: b.seats,
            name: b.name,
            bookingUrl,
          });
  } else if (row.type === "test") {
    rendered = renderTest(tenant);
  } else {
    // Einladungen werden ab Phase 4 aus dem Pipedrive-Panel erzeugt
    throw new Error(`Mailtyp ${row.type} wird noch nicht unterstützt`);
  }

  // Kundenmails in Kopie an Pipedrive (Smart BCC) -> Ablage beim Kontakt/Deal
  const bcc = row.type !== "test" && tenantRow.smart_bcc_email ? [{ email: tenantRow.smart_bcc_email }] : undefined;
  return { from, to: { email: row.to_email, name: toName }, replyTo, bcc, ...rendered, attachments };
}
