import type { Metadata } from "next";
import { settingsJwtSecret } from "@/lib/pipedrive/settings-token";
import { verifyPanelEntry } from "@/lib/panel/token";
import { startPanelSession } from "@/lib/panel/session";
import { loadPanelContext } from "@/lib/panel/context";
import { tenantForMember } from "@/lib/tenant/current";
import { at, ownerHint, panelTexts, type PanelErrorCode } from "@/lib/texts/admin";
import { PanelApp } from "@/components/panel/PanelApp";
import { PanelError } from "@/components/panel/PanelError";
import { recordAccessRequest } from "@/lib/access-requests";
import { ownerContacts } from "@/lib/pipedrive/admin-sync";

export const dynamic = "force-dynamic";
// Token in der Adresse nicht als Referrer weitergeben
export const metadata: Metadata = { title: "Terminbuchung", referrer: "no-referrer", robots: { index: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

function PanelMessage({ code, detail, theme, owners = [] }: { code: PanelErrorCode; detail?: string; theme: "light" | "dark"; owners?: string[] }) {
  return <PanelError message={at(`panel.error.${code}`, { owner: ownerHint(owners) })} code={detail ? `${code}/${detail}` : code} theme={theme} />;
}

/**
 * Vertriebs-Panel im Pipedrive-Deal (Custom Panel, eingebettet als iframe).
 * Prüft das signierte Pipedrive-Token, startet eine Panel-Sitzung (ohne Cookie)
 * und rendert den Inhalt nach dem Mock-up.
 */
export default async function PanelPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const theme = q.get("theme") === "dark" ? "dark" : "light";

  // Grund im Server-Log (journalctl -u meetings), ohne Token – nur IDs
  const reject = (code: PanelErrorCode, detail?: string, owners?: string[]) => {
    console.warn(`[panel] abgelehnt: ${code}${detail ? `/${detail}` : ""} (userId=${q.get("userId") ?? "-"}, companyId=${q.get("companyId") ?? "-"}, resource=${q.get("resource") ?? "-"}, selectedIds=${q.get("selectedIds") ?? "-"})`);
    return <PanelMessage code={code} detail={detail} theme={theme} owners={owners} />;
  };

  const v = verifyPanelEntry(q, settingsJwtSecret());
  if (!v.ok) return reject(v.error === "not_configured" ? "not_configured" : v.error === "no_deal" ? "no_deal" : "invalid", v.error);

  let context: Awaited<ReturnType<typeof loadPanelContext>>;
  let start: Awaited<ReturnType<typeof startPanelSession>>;
  try {
    start = await startPanelSession(v.entry);
    if (!start.ok) {
      if (start.error === "no_access" && start.tid) {
        await recordAccessRequest({ id: start.tid }, v.entry.userId);
        return reject("access_requested", undefined, await ownerContacts(start.tid).catch(() => []));
      }
      return reject(start.error);
    }
    const tenant = await tenantForMember(start.session.uid, start.session.tid);
    if (!tenant) return reject("no_access", "tenant");
    context = await loadPanelContext(start.session, { role: "authenticated", userId: start.session.uid }, tenant);
  } catch (err) {
    console.error("[panel] Fehler beim Laden", err);
    return reject("generic", "load");
  }
  return (
    <PanelApp
      initial={context}
      bearer={start.bearer}
      identity={{ userId: v.entry.userId, companyId: v.entry.companyId, dealId: v.entry.dealId }}
      texts={panelTexts()}
      theme={theme}
      adminUrl="/admin"
      apiBase="/api/panel"
    />
  );
}
