/**
 * Einstieg in das Vertriebs-Panel (Custom Panel im Deal). Pipedrive lädt
 *   <APP_BASE_URL>/panel?resource=deal&view=details&userId=…&companyId=…&selectedIds=<dealId>&token=<JWT>&id=<uuid>&theme=…
 * Das JWT ist wie beim Einstieg aus den App-Einstellungen mit dem JWT-Geheimnis
 * der App signiert (userId, companyId). selectedIds ist NICHT signiert: Es legt
 * nur fest, welcher Deal angezeigt wird; Rechte ergeben sich aus der
 * Mitgliedschaft (RLS) und dem Pipedrive-Zugang des Benutzers.
 * Reine Logik.
 */
import { verifySettingsToken, type SettingsIdentity, type SettingsTokenError } from "@/lib/pipedrive/settings-token";

export type PanelEntry = SettingsIdentity & { dealId: number };
export type PanelEntryError = SettingsTokenError | "no_deal";

export function dealIdFrom(resource: string | null, selectedIds: string | null): number | null {
  if (resource !== null && resource !== "deal") return null;
  const first = (selectedIds ?? "").split(",")[0]?.trim() ?? "";
  if (!/^\d{1,15}$/.test(first)) return null;
  const n = Number(first);
  return n > 0 ? n : null;
}

export function verifyPanelEntry(
  q: { get(name: string): string | null },
  secret: string | null,
  now = Date.now(),
): { ok: true; entry: PanelEntry } | { ok: false; error: PanelEntryError } {
  const v = verifySettingsToken({ token: q.get("token"), userId: q.get("userId"), companyId: q.get("companyId") }, secret, now);
  if (!v.ok) return v;
  const dealId = dealIdFrom(q.get("resource"), q.get("selectedIds"));
  if (!dealId) return { ok: false, error: "no_deal" };
  return { ok: true, entry: { ...v.identity, dealId } };
}
