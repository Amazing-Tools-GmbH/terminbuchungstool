import "server-only";
/**
 * Absage im Panel durch den Vertrieb (public.panel_cancel_booking):
 *   reinvite  Termin absagen, der Kunde bekommt die Absage mit seinem Link
 *             und wählt dort einen neuen Termin
 *   lost      Termin absagen, Link sperren, Deal in Pipedrive auf „verloren“
 *             (Absage-Mail an den Kunden nur mit notify, ohne Link)
 * Abgesagt wird nur die Buchung, die das Panel gerade zeigt: Einladung zum
 * aktuellen Kontakt des Deals (Kontakt aus Pipedrive, nie aus dem Browser).
 */
import { withActor, type DbActor } from "@/lib/db";
import type { PanelSession } from "@/lib/auth/session";
import type { PublicTenant } from "@/lib/tenant/types";
import { currentInvitation, dealContact } from "./context";
import { PanelError, toPanelError } from "./invite";

export type PanelCancelInput = { invitationId: string; mode: "reinvite" | "lost"; notify: boolean; lostReason: string | null };

export async function cancelPanelBooking(s: PanelSession, actor: DbActor, tenant: PublicTenant, input: PanelCancelInput): Promise<{ email: string }> {
  if (input.mode === "lost" && !s.deal) throw new PanelError("invalid_input");
  let person: Awaited<ReturnType<typeof dealContact>>["person"];
  try {
    person = (await dealContact(s)).person;
  } catch {
    throw new PanelError("pipedrive_unavailable");
  }
  try {
    return await withActor(actor, async (db) => {
      const inv = await currentInvitation(db, tenant.id, s, person);
      if (!inv || inv.id !== input.invitationId) throw new PanelError("not_booked");
      const { rows } = await db.query<{ r: { email: string } }>("select public.panel_cancel_booking($1, $2, $3, $4, $5, $6) as r", [
        tenant.id,
        inv.id,
        input.mode,
        input.notify,
        input.lostReason,
        s.deal,
      ]);
      return { email: rows[0]!.r.email };
    });
  } catch (err) {
    if ((err as { message?: string })?.message === "TB:not_found") throw new PanelError("not_booked");
    throw toPanelError(err);
  }
}
