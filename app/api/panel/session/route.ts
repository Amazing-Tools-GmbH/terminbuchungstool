import { z } from "zod";
import { settingsJwtSecret } from "@/lib/pipedrive/settings-token";
import { verifyPanelEntry } from "@/lib/panel/token";
import { startPanelSession } from "@/lib/panel/session";
import { panelError } from "@/lib/panel/api";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(1).max(2048),
  userId: z.number().int().positive(),
  companyId: z.number().int().positive(),
  dealId: z.number().int().positive(),
});

/**
 * Sitzung verlängern: Das Panel holt über das SDK ein frisch signiertes
 * Pipedrive-Token (GET_SIGNED_TOKEN) und tauscht es hier gegen eine neue
 * Panel-Sitzung.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return panelError("invalid_input");
  const b = parsed.data;
  const q = new URLSearchParams({ token: b.token, userId: String(b.userId), companyId: String(b.companyId), selectedIds: String(b.dealId) });
  const v = verifyPanelEntry(q, settingsJwtSecret());
  if (!v.ok) return panelError("session");
  const start = await startPanelSession(v.entry);
  if (!start.ok) return panelError(start.error);
  return Response.json({ ok: true, bearer: start.bearer }, { headers: { "cache-control": "no-store" } });
}
