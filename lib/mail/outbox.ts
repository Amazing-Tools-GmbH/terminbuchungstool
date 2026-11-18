/**
 * Outbox-Verarbeitung: holt fällige Mails, rendert sie zum Versandzeitpunkt
 * und verschickt sie über das Postfach des Mandanten.
 *
 * - Aufruf per Cron (/api/cron/outbox) und direkt nach einer Buchung (after()).
 * - Parallel sicher: Zeilen werden mit FOR UPDATE SKIP LOCKED beansprucht.
 * - Postfach nicht aktiv/gestört -> Mail bleibt in der Outbox (kein stiller
 *   Absenderwechsel); bei Anmeldefehler wird die Verbindung auf "error" gesetzt.
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
  const connection = await loadConnection(pool, row);
  if (!connection || connection.status !== "active") {
    await requeueBlocked(pool, row.id, connection ? `Postfach ${connection.senderEmail} ist nicht aktiv (${connection.status})` : "Kein Postfach verbunden");
    return "blocked";
  }

  let message: MailMessage;
  try {
    message = await buildMessage(pool, row, connection);
  } catch (err) {
    await markFailed(pool, row.id, `Rendern fehlgeschlagen: ${(err as Error).message}`);
    return "failed";
  }

  try {
    const sender = senderFactory(connection);
    const { messageId } = await sender.send(message);
    await asService(pool, (c) =>
      c.query(
        `update public.email_outbox
            set status = 'sent', sent_at = now(), locked_at = null, last_error = null,
                provider_message_id = $2, mail_connection_id = $3,
                rendered = case when $4 then $5::jsonb else null end
          where id = $1`,
        [row.id, messageId, connection.id, connection.provider === "dev", JSON.stringify(message)],
      ),
    );
    return "sent";
  } catch (err) {
    const e = err instanceof MailSendError ? err : new MailSendError("transient", (err as Error)?.message ?? String(err));
    if (e.kind === "auth") {
      await asService(pool, (c) =>
        c.query("update public.mail_connections set status = 'error', last_error = $2 where id = $1", [connection.id, e.message]),
      );
      await requeueBlocked(pool, row.id, e.message);
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
async function requeueBlocked(pool: pg.Pool, id: string, reason: string) {
  await asService(pool, (c) =>
    c.query(
      `update public.email_outbox
          set status = 'queued', locked_at = null, attempts = greatest(attempts - 1, 0), last_error = $2,
              next_attempt_at = now() + make_interval(mins => $3)
        where id = $1`,
      [id, reason, CONNECTION_RETRY_MINUTES],
    ),
  );
}

async function markFailed(pool: pg.Pool, id: string, reason: string) {
  await asService(pool, (c) =>
    c.query("update public.email_outbox set status = 'failed', locked_at = null, last_error = $2 where id = $1", [id, reason]),
  );
}

async function loadConnection(pool: pg.Pool, row: OutboxRow): Promise<MailConnection | null> {
  return asService(pool, async (c) => {
    const { rows } = await c.query(
      `select id, tenant_id, provider, sender_email, sender_name, status, credentials_enc
         from public.mail_connections
        where tenant_id = $1 and ($2::uuid is null and scope = 'tenant' or id = $2)
        limit 1`,
      [row.tenant_id, row.mail_connection_id],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          tenantId: r.tenant_id,
          provider: r.provider,
          senderEmail: r.sender_email,
          senderName: r.sender_name,
          status: r.status,
          credentialsEnc: r.credentials_enc,
        }
      : null;
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

  return { from, to: { email: row.to_email, name: toName }, replyTo, ...rendered, attachments };
}
