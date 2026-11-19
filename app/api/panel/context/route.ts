import { loadPanelContext, panelAuth } from "@/lib/panel/context";
import { panelError } from "@/lib/panel/api";

export const dynamic = "force-dynamic";

/** Aktueller Stand des Panels (Kontakt, Termine, Einladung, Versandstatus) */
export async function GET() {
  const auth = await panelAuth();
  if (!auth) return panelError("session");
  try {
    const ctx = await loadPanelContext(auth.s, auth.actor, auth.tenant);
    return Response.json({ ok: true, context: ctx }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("Panel-Kontext fehlgeschlagen", err);
    return panelError("generic");
  }
}
