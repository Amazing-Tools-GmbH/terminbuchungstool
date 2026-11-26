/**
 * Buchungsdienste für die öffentliche Buchungsseite. Laufen als `anon`
 * und nutzen ausschließlich die token-gebundenen DB-Funktionen. Kunden
 * buchen genau einmal (book_slot_once) – kein Umbuchen, kein Stornieren.
 */
import type pg from "pg";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { bookingUrl } from "@/lib/links";
import { generateToken, looksLikeToken } from "./tokens";
import { guestContextSchema, invitationContextSchema, type GuestContext, type InvitationContext } from "./context";
import { toBookingError } from "./errors";
import type { BookInput, GuestInput } from "./input";

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

/**
 * Teilnehmer mit Einladung für die DB: je Teilnehmer ein eigener Link
 * (Token nur als Hash in der DB, Link verschlüsselt für die Mail).
 */
export function guestsForDb(tenant: TenantRef, guests: GuestInput[]) {
  return JSON.stringify(
    guests.map((g) => {
      const token = generateToken();
      return { name: g.name, email: g.email, token, link_enc: sealBookingLink(tenant, token) };
    }),
  );
}

/** Ansicht für den Link eines Teilnehmers (null = kein Teilnehmer-Link) */
export async function loadGuestContext(run: Run, tenantId: string, token: string): Promise<GuestContext | null> {
  if (!looksLikeToken(token)) return null;
  const raw = await run(async (c) => {
    const { rows } = await c.query("select public.get_guest_context($1, $2) as ctx", [tenantId, token]);
    return rows[0]?.ctx ?? null;
  });
  return raw ? guestContextSchema.parse(raw) : null;
}

/** Teilnehmer mit Einladung der aktiven Buchung (Anzeige der Bestätigung) */
export async function loadBookingGuests(run: Run, tenantId: string, token: string): Promise<GuestInput[]> {
  if (!looksLikeToken(token)) return [];
  return run(async (c) => {
    const { rows } = await c.query("select public.get_booking_guests($1, $2) as g", [tenantId, token]);
    return (rows[0]?.g ?? []) as GuestInput[];
  });
}

export type BookResult = { bookingId: string; replacedBookingId: string | null };

export async function bookSlot(run: Run, tenant: TenantRef, input: Omit<BookInput, "guests"> & { guests?: GuestInput[] }): Promise<BookResult> {
  try {
    return await run(async (c) => {
      const { rows } = await c.query(
        "select public.book_slot_once($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) as r",
        [
          tenant.id,
          input.token,
          input.slotId,
          input.seats,
          input.name,
          input.email,
          input.extraAttendees,
          sealBookingLink(tenant, input.token),
          guestsForDb(tenant, input.guests ?? []),
        ],
      );
      const r = rows[0].r as { booking_id: string; replaced_booking_id: string | null };
      return { bookingId: r.booking_id, replacedBookingId: r.replaced_booking_id };
    });
  } catch (err) {
    throw toBookingError(err) ?? err;
  }
}

export type BookingContact = { name: string; email: string | null };

/** Ansprechpartner zum Link (einladender Mitarbeiter) – für „Ihr könnt nicht kommen?“ */
export async function loadBookingContact(run: Run, tenantId: string, token: string): Promise<BookingContact | null> {
  if (!looksLikeToken(token)) return null;
  const raw = await run(async (c) => {
    const { rows } = await c.query("select public.get_booking_contact($1, $2) as c", [tenantId, token]);
    return rows[0]?.c ?? null;
  });
  return raw && typeof raw.name === "string" ? { name: raw.name, email: typeof raw.email === "string" ? raw.email : null } : null;
}
