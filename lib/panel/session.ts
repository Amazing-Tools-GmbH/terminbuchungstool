import "server-only";
/**
 * Panel-Sitzung aus einem geprüften Pipedrive-Einstieg: Mandant über die
 * companyId, nur freigeschaltete Mitglieder. Ergebnis ist ein versiegelter
 * Wert (Zweck "panel"), den der Browser als Bearer-Token mitschickt.
 */
import { withActor } from "@/lib/db";
import { PANEL_TTL_SECONDS, seal, type PanelSession } from "@/lib/auth/session";
import { tenantIdForPipedriveCompany } from "@/lib/pipedrive/runtime";
import type { PanelEntry } from "./token";
import { grantPipedriveAdminById } from "@/lib/pipedrive/admin-sync";

export type PanelStart =
  | { ok: true; session: PanelSession; bearer: string }
  | { ok: false; error: "not_connected" | "no_access" | "disabled"; tid?: string };

export async function startPanelSession(entry: PanelEntry): Promise<PanelStart> {
  const tid = await tenantIdForPipedriveCompany(entry.companyId);
  if (!tid) return { ok: false, error: "not_connected" };
  const lookup = () =>
    withActor({ role: "service_role" }, async (db) => {
      const { rows } = await db.query<{ user_id: string; status: "active" | "disabled" }>(
        "select user_id, status from public.member_login_lookup($1, $2)",
        [tid, entry.userId],
      );
      return rows[0] ?? null;
    });
  let member = await lookup();
  // noch kein Mitglied, aber Admin in Pipedrive -> automatisch Admin
  if (!member && (await grantPipedriveAdminById(tid, entry.userId))) member = await lookup();
  if (!member) return { ok: false, error: "no_access", tid };
  if (member.status !== "active") return { ok: false, error: "disabled" };
  const session: PanelSession = { uid: member.user_id, tid, pd: entry.userId, deal: entry.dealId };
  return { ok: true, session, bearer: seal("panel", session, PANEL_TTL_SECONDS) };
}
