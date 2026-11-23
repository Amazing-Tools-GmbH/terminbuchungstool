import "server-only";
/**
 * Einladung aus dem Panel: Kontakt kommt aus Pipedrive (nie aus dem Browser),
 * Token wird hier erzeugt; in der DB stehen nur Hash und verschlüsselter Link.
 * Einladung + Mail entstehen in einer Transaktion (public.create_invitation).
 */
import { withActor, type DbActor } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookingUrl } from "@/lib/links";
import type { PanelSession } from "@/lib/auth/session";
import type { PublicTenant } from "@/lib/tenant/types";
import type { PanelErrorCode } from "@/lib/texts/admin";
import { dealContact } from "./context";

/** Gültigkeit eines Buchungslinks */
export const INVITATION_VALID_DAYS = 60;

export class PanelError extends Error {
  constructor(readonly code: PanelErrorCode) {
    super(code);
    this.name = "PanelError";
  }
}

const DB_CODES: Record<string, PanelErrorCode> = {
  "TB:forbidden": "forbidden",
  "TB:event_not_available": "event_not_available",
  "TB:slot_not_available": "slot_not_available",
  "TB:slot_not_allowed": "slot_not_available",
  "TB:invalid_input": "invalid_input",
  "TB:invalid_seats": "invalid_input",
  "TB:invalid_name": "no_contact",
  "TB:invalid_email": "no_contact",
  "TB:not_enough_seats": "not_enough_seats",
  "TB:already_booked": "already_booked",
};

export function toPanelError(err: unknown): PanelError {
  if (err instanceof PanelError) return err;
  const code = DB_CODES[(err as { message?: string })?.message ?? ""];
  return new PanelError(code ?? "generic");
}

/**
 * Direktbuchung durch den Vertrieb für den Kontakt des Deals (public.book_for_deal ->
 * public.book_slot). Der Kunde erhält die Buchungsbestätigung mit Link zum Umbuchen/Stornieren.
 */
export async function createPanelBooking(
  s: PanelSession,
  actor: DbActor,
  tenant: PublicTenant,
  input: { slotId: string; seats: number },
): Promise<{ bookingId: string; email: string }> {
  let contact: Awaited<ReturnType<typeof dealContact>>;
  try {
    contact = await dealContact(s);
  } catch {
    throw new PanelError("pipedrive_unavailable");
  }
  const person = contact.person;
  if (!contact.deal || !person?.email) throw new PanelError("no_contact");

  const token = generateToken();
  const linkEnc = encryptSecret(bookingUrl({ slug: tenant.slug, customDomain: tenant.customDomain }, token));
  try {
    const r = await withActor(actor, async (db) => {
      const { rows } = await db.query<{ r: { booking_id: string } }>(
        "select public.book_for_deal($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as r",
        [tenant.id, input.slotId, token, linkEnc, person.name, person.email, contact.organization, s.deal, person.id, input.seats],
      );
      return rows[0]!.r;
    });
    return { bookingId: r.booking_id, email: person.email };
  } catch (err) {
    throw toPanelError(err);
  }
}

export async function createPanelInvitation(
  s: PanelSession,
  actor: DbActor,
  tenant: PublicTenant,
  input: { eventId: string; slotIds: string[] | null },
): Promise<{ invitationId: string; email: string }> {
  let contact: Awaited<ReturnType<typeof dealContact>>;
  try {
    contact = await dealContact(s);
  } catch {
    throw new PanelError("pipedrive_unavailable");
  }
  const person = contact.person;
  if (!contact.deal || !person?.email) throw new PanelError("no_contact");

  const token = generateToken();
  const linkEnc = encryptSecret(bookingUrl({ slug: tenant.slug, customDomain: tenant.customDomain }, token));
  try {
    const id = await withActor(actor, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as id",
        [
          tenant.id,
          input.eventId,
          hashToken(token),
          linkEnc,
          person.name,
          person.email,
          contact.organization,
          s.deal,
          person.id,
          input.slotIds,
          INVITATION_VALID_DAYS,
        ],
      );
      return rows[0]!.id;
    });
    return { invitationId: id, email: person.email };
  } catch (err) {
    throw toPanelError(err);
  }
}
