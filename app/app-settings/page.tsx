import type { Metadata } from "next";
import { settingsJwtSecret, verifySettingsToken } from "@/lib/pipedrive/settings-token";
import { startAppSettings } from "@/lib/app-settings";
import { loadTeam } from "@/lib/admin/members";
import { listOpenAccessRequests } from "@/lib/access-requests";
import { ADMIN_TEXTS, at, ownerHint } from "@/lib/texts/admin";
import { AppSettings } from "@/components/app-settings/AppSettings";
import { PanelError } from "@/components/panel/PanelError";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Terminbuchung – Einstellungen", referrer: "no-referrer", robots: { index: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

/**
 * App-Einstellungen in Pipedrive (Custom UI, iframe): Nutzerverwaltung wie im
 * Admin, plus Link zum Admin für alle übrigen Einstellungen.
 */
export default async function AppSettingsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const theme = q.get("theme") === "dark" ? "dark" : "light";
  const msg = (key: Parameters<typeof at>[0], code: string, owners: string[] = []) => (
    <PanelError message={at(key, { owner: ownerHint(owners) })} code={code} theme={theme} />
  );

  const v = verifySettingsToken({ token: q.get("token"), userId: q.get("userId"), companyId: q.get("companyId") }, settingsJwtSecret());
  if (!v.ok) {
    console.warn(`[app-settings] abgelehnt: ${v.error} (userId=${q.get("userId") ?? "-"}, companyId=${q.get("companyId") ?? "-"})`);
    return msg(v.error === "not_configured" ? "panel.error.not_configured" : "panel.error.invalid", v.error);
  }
  let start: Awaited<ReturnType<typeof startAppSettings>>;
  try {
    start = await startAppSettings(v.identity);
  } catch (err) {
    console.error("[app-settings] Fehler beim Laden", err);
    return msg("panel.error.generic", "load");
  }
  if (!start.ok) {
    if (start.error === "access_requested") return msg("panel.error.access_requested", start.error, start.owners);
    if (start.error === "sales") return msg("appSettings.salesOnly", start.error);
    return msg(start.error === "not_connected" ? "panel.error.not_connected" : "panel.error.disabled", start.error);
  }
  const [team, requests] = await Promise.all([loadTeam(start.ctx), listOpenAccessRequests(start.ctx)]);
  const texts = Object.fromEntries(
    Object.entries(ADMIN_TEXTS).filter(([k]) => k.startsWith("users.") || k.startsWith("role.") || k.startsWith("appSettings.")),
  );
  return (
    <AppSettings
      bearer={start.bearer}
      theme={theme}
      texts={texts}
      tenantName={start.ctx.tenant.name}
      initial={{ team, requests, viewer: { role: start.ctx.role } }}
    />
  );
}
