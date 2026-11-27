import { z } from "zod";
import { panelAuth } from "@/lib/panel/context";
import { cancelPanelBooking } from "@/lib/panel/cancel";
import { PanelError } from "@/lib/panel/invite";
import { panelError } from "@/lib/panel/api";
import { sendMailsSoon } from "@/lib/booking/api";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  invitationId: z.string().uuid(),
  mode: z.enum(["reinvite", "lost"]),
  /** nur bei "lost": Absage-Mail an den Kunden (bei "reinvite" immer) */
  notify: z.boolean().default(true),
  lostReason: z.string().trim().max(255).nullable().default(null),
});

/** Buchung des Kontakts absagen: neu einladen oder Deal verloren */
export async function POST(req: Request) {
  const auth = await panelAuth();
  if (!auth) return panelError("session");
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return panelError("invalid_input");
  try {
    const r = await cancelPanelBooking(auth.s, auth.actor, auth.tenant, { ...parsed.data, lostReason: parsed.data.lostReason || null });
    sendMailsSoon(auth.tenant.id);
    return Response.json({ ok: true, email: r.email }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof PanelError) {
      if (err.code === "generic") console.error("Panel-Absage fehlgeschlagen", err);
      return panelError(err.code);
    }
    console.error("Panel-Absage fehlgeschlagen", err);
    return panelError("generic");
  }
}
