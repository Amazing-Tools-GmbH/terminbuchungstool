import { z } from "zod";
import { panelAuth } from "@/lib/panel/context";
import { createPanelInvitation, PanelError } from "@/lib/panel/invite";
import { panelError } from "@/lib/panel/api";
import { sendMailsSoon } from "@/lib/booking/api";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  eventId: z.string().uuid(),
  /** null = alle kommenden Termine der Veranstaltung */
  slotIds: z.array(z.string().uuid()).min(1).max(200).nullable(),
});

/** Buchungslink erzeugen und per Mail senden (über die Outbox) */
export async function POST(req: Request) {
  const auth = await panelAuth();
  if (!auth) return panelError("session");
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return panelError("invalid_input");
  try {
    const r = await createPanelInvitation(auth.s, auth.actor, auth.tenant, {
      eventId: parsed.data.eventId,
      slotIds: parsed.data.slotIds ? [...new Set(parsed.data.slotIds)] : null,
    });
    sendMailsSoon(auth.tenant.id);
    return Response.json({ ok: true, invitationId: r.invitationId, email: r.email }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof PanelError) {
      if (err.code === "generic") console.error("Panel-Einladung fehlgeschlagen", err);
      return panelError(err.code);
    }
    console.error("Panel-Einladung fehlgeschlagen", err);
    return panelError("generic");
  }
}
