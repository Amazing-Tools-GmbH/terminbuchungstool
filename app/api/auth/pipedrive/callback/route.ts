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
import { cookiePath } from "@/lib/base-path";

export const dynamic = "force-dynamic";

function sameNonce(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Zentraler OAuth-Callback (EINE Callback-URL für alle Mandanten:
 * <APP_BASE_URL>/api/auth/pipedrive/callback). Prüft State + Nonce-Cookie,
 * ermittelt den Mandanten über die Pipedrive-Firma und setzt die Sitzung.
 * Die Installation der App (Phase 4) läuft später ebenfalls hier an.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const fail = (error: string) => {
    const res = NextResponse.redirect(appUrl("/admin/login", { error }));
    res.cookies.set(LOGIN_NONCE_COOKIE, "", { path: cookiePath("/api/auth"), maxAge: 0 });
    return res;
  };
  const state = unseal("login-state", params.get("state"), loginStateSchema);
  if (!state || !sameNonce(state.nonce, req.cookies.get(LOGIN_NONCE_COOKIE)?.value)) return fail("expired");
  const cfg = oauthConfig();
  if (!cfg) return fail("not_configured");
  const code = params.get("code");
  if (!code) return fail("cancelled"); // in Pipedrive abgebrochen (error=access_denied) o. Ä.

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
    storeUserTokens: (tid, uid, me, tokens) => storeUserTokens(getPool(), tid, uid, me, tokens),
  });
  if (!result.ok) return fail(result.error);

  const res = NextResponse.redirect(appUrl("/admin"));
  res.cookies.set(sessionCookie(result.session));
  res.cookies.set(LOGIN_NONCE_COOKIE, "", { path: cookiePath("/api/auth"), maxAge: 0 });
  return res;
}
