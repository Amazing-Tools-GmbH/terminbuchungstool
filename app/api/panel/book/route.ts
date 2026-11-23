import { z } from "zod";
import { panelAuth } from "@/lib/panel/context";
import { createPanelBooking, PanelError } from "@/lib/panel/invite";
import { panelError } from "@/lib/panel/api";
import { sendMailsSoon } from "@/lib/booking/api";
import { checkAttendees } from "@/lib/booking/input";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  slotId: z.string().uuid(),
  seats: z.number().int().min(1).max(100),
  /** weitere Teilnehmer (Name, E-Mail nur mit Einladung) */
  attendees: z.array(z.object({ name: z.string().max(200), email: z.string().max(254) })).max(99).default([]),
  inviteGuests: z.boolean().default(false),
});

/** Termin direkt für den Kontakt des Deals buchen (Bestätigung per Mail über die Outbox) */
export async function POST(req: Request) {
  const auth = await panelAuth();
  if (!auth) return panelError("session");
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return panelError("invalid_input");
  const { slotId, seats, attendees, inviteGuests } = parsed.data;
  // E-Mail des Kontakts prüft die DB (Teilnehmer dürfen sie nicht doppeln)
  const checked = checkAttendees(attendees, seats, inviteGuests, "");
  if (!checked.ok) return panelError(checked.error);
  try {
    const r = await createPanelBooking(auth.s, auth.actor, auth.tenant, {
      slotId,
      seats,
      extraAttendees: checked.extraAttendees,
      guests: checked.guests,
    });
    sendMailsSoon(auth.tenant.id);
    return Response.json({ ok: true, bookingId: r.bookingId, email: r.email }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof PanelError) {
      if (err.code === "generic") console.error("Panel-Buchung fehlgeschlagen", err);
      return panelError(err.code);
    }
    console.error("Panel-Buchung fehlgeschlagen", err);
    return panelError("generic");
  }
}
