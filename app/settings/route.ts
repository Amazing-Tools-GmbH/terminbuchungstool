import { NextResponse, type NextRequest } from "next/server";
import { withActor } from "@/lib/db";
import { settingsJwtSecret, verifySettingsToken } from "@/lib/pipedrive/settings-token";
import { tenantIdForCompany } from "@/lib/pipedrive/connection";
import { sessionCookie } from "@/lib/auth/admin";
import { appUrl } from "@/lib/auth/urls";
import { recordAccessRequest } from "@/lib/access-requests";
import { grantPipedriveAdminById } from "@/lib/pipedrive/admin-sync";
import { loginHintFor } from "@/lib/auth/login-hint";

export const dynamic = "force-dynamic";

/**
 * Einstieg aus den Pipedrive-App-Einstellungen (wie bei der SevDesk-
 * Schnittstelle): <APP_BASE_URL>/settings?userId=…&companyId=…&token=<JWT>.
 * Prüft das von Pipedrive signierte Token, ermittelt den Mandanten über die
 * companyId und meldet den freigeschalteten Benutzer an. Danach Weiterleitung
 * ohne Token in der Adresse.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const fail = (error: string, hint?: string | null) => NextResponse.redirect(appUrl("/admin/login", hint ? { error, hint } : { error }));

  const v = verifySettingsToken({ token: q.get("token"), userId: q.get("userId"), companyId: q.get("companyId") }, settingsJwtSecret());
  if (!v.ok) return fail(v.error === "not_configured" ? "not_configured" : "settings_invalid");

  const tid = await tenantIdForCompany(v.identity.companyId);
  if (!tid) return fail("not_connected");

  const lookup = () =>
    withActor({ role: "service_role" }, async (db) => {
      const { rows } = await db.query<{ user_id: string; status: "active" | "disabled" }>(
        "select user_id, status from public.member_login_lookup($1, $2)",
        [tid, v.identity.userId],
      );
      return rows[0] ?? null;
    });
  let member = await lookup();
  // Pipedrive-Admin: automatisch Admin
  if (!member && (await grantPipedriveAdminById(tid, v.identity.userId))) member = await lookup();
  if (!member) {
    await recordAccessRequest({ id: tid }, v.identity.userId);
    return fail("no_access", await loginHintFor(tid));
  }
  if (member.status !== "active") return fail("disabled");

  const res = NextResponse.redirect(appUrl("/admin"));
  res.cookies.set(sessionCookie({ uid: member.user_id, tid, pd: v.identity.userId }));
  // Token nicht im Verlauf/Referrer weitergeben
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", "no-store");
  return res;
}
