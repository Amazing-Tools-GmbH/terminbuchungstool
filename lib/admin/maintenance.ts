import "server-only";
/**
 * Events, Termine und Buchungen pflegen (owner/admin). Mehrschrittige
 * Änderungen laufen über DB-Funktionen (Sperren, Mails über die Outbox,
 * Pipedrive-Aufträge); einfache Felder über RLS.
 */
import { withActor } from "@/lib/db";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError, toAdminError } from "./errors";
import type { UpdateEventInput, UpdateSlotInput } from "./input";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookingUrl } from "@/lib/links";

async function run<T>(ctx: AdminContext, fn: (db: import("pg").PoolClient) => Promise<T>): Promise<T> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  try {
    return await withActor(ctx.actor, fn);
  } catch (err) {
    throw toAdminError(err);
  }
}

/**
 * Öffentlichen Buchungslink eines Events erzeugen (neu = alter Link ungültig)
 * oder abschalten. In der DB nur Hash + verschlüsselter Link (fürs Admin).
 */
export function setPublicLink(ctx: AdminContext, eventId: string, enable: boolean): Promise<void> {
  return run(ctx, async (db) => {
    let hash: Buffer | null = null;
    let enc: string | null = null;
    if (enable) {
      const token = generateToken();
      hash = hashToken(token);
      enc = encryptSecret(bookingUrl({ slug: ctx.tenant.slug, customDomain: ctx.tenant.customDomain }, token));
    }
    const res = await db.query(
      "update public.events set public_token_hash = $3, public_link_enc = $4 where id = $1 and tenant_id = $2 and status <> 'archived'",
      [eventId, ctx.tenant.id, hash, enc],
    );
    if (res.rowCount === 0) throw new AdminError("forbidden");
  });
}

export function updateEvent(ctx: AdminContext, input: UpdateEventInput): Promise<void> {
  return run(ctx, async (db) => {
    const res = await db.query(
      "update public.events set title = $3, location = $4, description = $5, show_seats = $6 where id = $1 and tenant_id = $2 and status <> 'archived'",
      [input.eventId, ctx.tenant.id, input.title, input.location, input.description, input.showSeats],
    );
    if (res.rowCount === 0) throw new AdminError("forbidden");
  });
}

/** Termin verschieben/Ort ändern; Datum/Uhrzeit in der Mandanten-Zeitzone. Ergebnis: Anzahl betroffener Buchungen */
export function updateSlot(ctx: AdminContext, input: UpdateSlotInput): Promise<number> {
  return run(ctx, async (db) => {
    const { rows } = await db.query<{ n: number }>(
      `select public.admin_update_slot($1, $2, ($3::date + $4::time) at time zone $7, ($3::date + $5::time) at time zone $7, $6, $8) as n`,
      [ctx.tenant.id, input.slotId, input.date, input.from, input.to, input.location, ctx.tenant.timezone, input.notify],
    );
    return rows[0]!.n;
  });
}

export function cancelSlot(ctx: AdminContext, slotId: string, notify: boolean): Promise<number> {
  return run(ctx, async (db) => {
    const { rows } = await db.query<{ n: number }>("select public.admin_cancel_slot($1, $2, $3) as n", [ctx.tenant.id, slotId, notify]);
    return rows[0]!.n;
  });
}

export function deleteEvent(ctx: AdminContext, eventId: string, notify: boolean): Promise<{ deleted: boolean; cancelled: number }> {
  return run(ctx, async (db) => {
    const { rows } = await db.query<{ r: { deleted: boolean; cancelled: number } }>("select public.admin_delete_event($1, $2, $3) as r", [
      ctx.tenant.id,
      eventId,
      notify,
    ]);
    return rows[0]!.r;
  });
}

export function cancelBookingByTeam(ctx: AdminContext, bookingId: string, notify: boolean): Promise<void> {
  return run(ctx, async (db) => {
    await db.query("select public.admin_cancel_booking($1, $2, $3)", [ctx.tenant.id, bookingId, notify]);
  });
}
