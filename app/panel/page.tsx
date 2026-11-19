import type { Metadata } from "next";
import { settingsJwtSecret } from "@/lib/pipedrive/settings-token";
import { verifyPanelEntry } from "@/lib/panel/token";
import { startPanelSession } from "@/lib/panel/session";
import { loadPanelContext } from "@/lib/panel/context";
import { tenantForMember } from "@/lib/tenant/current";
import { at, panelTexts, type PanelErrorCode } from "@/lib/texts/admin";
import { withBasePath } from "@/lib/base-path";
import { PanelApp } from "@/components/panel/PanelApp";
import styles from "@/components/panel/Panel.module.css";

export const dynamic = "force-dynamic";
// Token in der Adresse nicht als Referrer weitergeben
export const metadata: Metadata = { title: "Terminbuchung", referrer: "no-referrer", robots: { index: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

function PanelMessage({ code, theme }: { code: PanelErrorCode; theme: string }) {
  return (
    <main className={styles.root} data-theme={theme}>
      <p role="alert" className={styles.alert}>
        {at(`panel.error.${code}`)}
      </p>
    </main>
  );
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

  const v = verifyPanelEntry(q, settingsJwtSecret());
  if (!v.ok) return <PanelMessage code={v.error === "not_configured" ? "not_configured" : v.error === "no_deal" ? "no_deal" : "invalid"} theme={theme} />;

  const start = await startPanelSession(v.entry);
  if (!start.ok) return <PanelMessage code={start.error} theme={theme} />;
  const tenant = await tenantForMember(start.session.uid, start.session.tid);
  if (!tenant) return <PanelMessage code="no_access" theme={theme} />;

  const context = await loadPanelContext(start.session, { role: "authenticated", userId: start.session.uid }, tenant);
  return (
    <PanelApp
      initial={context}
      bearer={start.bearer}
      identity={{ userId: v.entry.userId, companyId: v.entry.companyId, dealId: v.entry.dealId }}
      texts={panelTexts()}
      theme={theme}
      adminUrl={withBasePath("/admin")}
      apiBase={withBasePath("/api/panel")}
    />
  );
}
