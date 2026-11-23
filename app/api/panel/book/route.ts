import { z } from "zod";
import { panelAuth } from "@/lib/panel/context";
import { createPanelBooking, PanelError } from "@/lib/panel/invite";
import { panelError } from "@/lib/panel/api";
import { sendMailsSoon } from "@/lib/booking/api";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  slotId: z.string().uuid(),
  seats: z.number().int().min(1).max(100),
});

/** Termin direkt für den Kontakt des Deals buchen (Bestätigung per Mail über die Outbox) */
export async function POST(req: Request) {
  const auth = await panelAuth();
  if (!auth) return panelError("session");
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return panelError("invalid_input");
  try {
    const r = await createPanelBooking(auth.s, auth.actor, auth.tenant, parsed.data);
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
