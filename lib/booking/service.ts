/**
 * Buchungsdienste für die öffentliche Buchungsseite. Laufen als `anon`
 * und nutzen ausschließlich die token-gebundenen DB-Funktionen.
 */
import type pg from "pg";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { bookingUrl } from "@/lib/links";
import { looksLikeToken } from "./tokens";
import { invitationContextSchema, type InvitationContext } from "./context";
import { toBookingError } from "./errors";
import type { BookInput } from "./input";

type Run = <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
export type TenantRef = { id: string; slug: string; customDomain?: string | null };

/** Buchungslink verschlüsselt für die Outbox (Mails brauchen den Link) */
export function sealBookingLink(tenant: TenantRef, token: string): string {
  return encryptSecret(bookingUrl(tenant, token));
}

export async function loadInvitationContext(run: Run, tenantId: string, token: string): Promise<InvitationContext | null> {
  if (!looksLikeToken(token)) return null;
  const raw = await run(async (c) => {
    const { rows } = await c.query("select public.get_invitation_context($1, $2) as ctx", [tenantId, token]);
    return rows[0]?.ctx ?? null;
  });
  return raw ? invitationContextSchema.parse(raw) : null;
}

export type BookResult = { bookingId: string; replacedBookingId: string | null };

export async function bookSlot(run: Run, tenant: TenantRef, input: BookInput): Promise<BookResult> {
  try {
    return await run(async (c) => {
      const { rows } = await c.query(
        "select public.book_slot($1, $2, $3, $4, $5, $6, $7, $8) as r",
        [tenant.id, input.token, input.slotId, input.seats, input.name, input.email, input.extraAttendees, sealBookingLink(tenant, input.token)],
      );
      const r = rows[0].r as { booking_id: string; replaced_booking_id: string | null };
      return { bookingId: r.booking_id, replacedBookingId: r.replaced_booking_id };
    });
  } catch (err) {
    throw toBookingError(err) ?? err;
  }
}

export async function cancelBooking(run: Run, tenant: TenantRef, token: string): Promise<{ bookingId: string }> {
  try {
    return await run(async (c) => {
      const { rows } = await c.query("select public.cancel_booking($1, $2, $3) as r", [
        tenant.id,
        token,
        sealBookingLink(tenant, token),
      ]);
      return { bookingId: (rows[0].r as { booking_id: string }).booking_id };
    });
  } catch (err) {
    throw toBookingError(err) ?? err;
  }
}
