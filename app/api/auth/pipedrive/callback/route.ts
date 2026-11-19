import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withActor } from "@/lib/db";
import { getPool } from "@/lib/db/pool";
import { exchangeCode, getMe, oauthConfig } from "@/lib/pipedrive/client";
import { tenantIdForCompany } from "@/lib/pipedrive/connection";
import { storeUserTokens } from "@/lib/pipedrive/user-connection";
import { completePipedriveLogin } from "@/lib/auth/pipedrive-login";
import { LOGIN_NONCE_COOKIE, loginStateSchema, unseal } from "@/lib/auth/session";
import { sessionCookie } from "@/lib/auth/admin";
import { appUrl } from "@/lib/auth/urls";
import { syncCompanyDomain, installFromOAuth, uninstallCompany } from "@/lib/pipedrive/install";

export const dynamic = "force-dynamic";

/** Abbruch durch den Benutzer (Pipedrive: user_denied; OAuth-Standard: access_denied) */
const OAUTH_CANCELLED = new Set(["user_denied", "access_denied"]);

function sameNonce(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Zentraler OAuth-Callback (EINE Callback-URL für alle Mandanten:
 * <APP_BASE_URL>/api/auth/pipedrive/callback).
 *   - mit unserem State: "Mit Pipedrive anmelden" (State + Nonce-Cookie prüfen,
 *     Mandant über die Pipedrive-Firma, Sitzung setzen)
 *   - ohne State: Installation über den Installationslink der Pipedrive-App
 *     (Mandant anlegen bzw. Verbindung erneuern, Installierender = owner)
 *   - DELETE: Deinstallation (Pipedrive, Basic-Auth mit Client-ID/Secret)
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const fail = (error: string) => {
    const res = NextResponse.redirect(appUrl("/admin/login", { error }));
    res.cookies.set(LOGIN_NONCE_COOKIE, "", { path: "/api/auth", maxAge: 0 });
    return res;
  };
  // Pipedrive meldet Abbruch/Fehler als ?error=… (z. B. user_denied, wenn die Freigabe
  // verweigert wurde) – bei Login UND Installation; nie Tokens anfragen
  const oauthError = params.get("error");
  if (oauthError) return fail(OAUTH_CANCELLED.has(oauthError) ? "cancelled" : "oauth_failed");
  if (!params.has("state")) return install(params.get("code"), fail);
  const state = unseal("login-state", params.get("state"), loginStateSchema);
  if (!state || !sameNonce(state.nonce, req.cookies.get(LOGIN_NONCE_COOKIE)?.value)) return fail("expired");
  const cfg = oauthConfig();
  if (!cfg) return fail("not_configured");
  const code = params.get("code");
  if (!code) return fail("cancelled");

  const result = await completePipedriveLogin(code, {
    exchangeCode: (c) => exchangeCode(cfg, c),
    getMe: (apiDomain, token) => getMe(apiDomain, token),
    tenantForCompany: tenantIdForCompany,
    lookupMember: (tid, pdUserId) =>
      withActor({ role: "service_role" }, async (db) => {
        const { rows } = await db.query<{ user_id: string; auth_email: string | null; status: "active" | "disabled" }>(
          "select user_id, auth_email, status from public.member_login_lookup($1, $2)",
          [tid, pdUserId],
        );
        const r = rows[0];
        return r ? { userId: r.user_id, authEmail: r.auth_email, status: r.status } : null;
      }),
    refreshMemberCache: (tid, userId, me) =>
      withActor({ role: "service_role" }, async (db) => {
        await db.query("update public.tenant_members set display_name = $3, email = $4 where tenant_id = $1 and user_id = $2", [
          tid,
          userId,
          me.name.slice(0, 200),
          me.email,
        ]);
      }),
    storeUserTokens: async (tid, uid, me, tokens) => {
      await storeUserTokens(getPool(), tid, uid, me, tokens);
      await syncCompanyDomain(me.companyId, me.companyDomain).catch((err) => console.error("Pipedrive-Domain nicht aktualisiert", err));
    },
  });
  if (!result.ok) return fail(result.error);

  const res = NextResponse.redirect(appUrl("/admin"));
  res.cookies.set(sessionCookie(result.session));
  res.cookies.set(LOGIN_NONCE_COOKIE, "", { path: "/api/auth", maxAge: 0 });
  return res;
}

/** Installation über den Installationslink (ohne unseren State) */
async function install(code: string | null, fail: (e: string) => NextResponse) {
  const cfg = oauthConfig();
  if (!cfg) return fail("not_configured");
  if (!code) return fail("cancelled");
  let result;
  try {
    const tokens = await exchangeCode(cfg, code);
    const me = await getMe(tokens.apiDomain, tokens.accessToken);
    result = await installFromOAuth(me, tokens);
  } catch (err) {
    console.error("Installation der Pipedrive-App fehlgeschlagen:", (err as Error).message);
    return fail("install_failed");
  }
  if (!result.ok) return fail(result.error);
  const res = NextResponse.redirect(appUrl("/admin", result.created || result.adopted ? { installed: "1" } : {}));
  res.cookies.set(sessionCookie(result.session));
  return res;
}

/**
 * Deinstallation: Pipedrive ruft die Callback-URL per DELETE auf, mit
 * Basic-Auth (Client-ID:Client-Secret) und { company_id, user_id } im Body.
 * Die Verbindung wird deaktiviert, die Daten bleiben erhalten.
 */
export async function DELETE(req: NextRequest) {
  const cfg = oauthConfig();
  if (!cfg) return new NextResponse(null, { status: 503 });
  const expected = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  const got = req.headers.get("authorization") ?? "";
  if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return new NextResponse(null, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { company_id?: unknown } | null;
  const companyId = Number(body?.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) return new NextResponse(null, { status: 400 });
  await uninstallCompany(companyId);
  return NextResponse.json({ ok: true });
}
