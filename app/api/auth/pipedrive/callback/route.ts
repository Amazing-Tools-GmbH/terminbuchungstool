import { NextResponse, type NextRequest } from "next/server";
import { withActor } from "@/lib/db";
import { getPool } from "@/lib/db/pool";
import { exchangeCode, getMe, oauthConfig } from "@/lib/pipedrive/client";
import { connectedCompanyId } from "@/lib/pipedrive/connection";
import { completePipedriveLogin } from "@/lib/auth/pipedrive-login";
import { storeUserTokens } from "@/lib/pipedrive/user-connection";
import { LOGIN_TICKET_TTL_SECONDS, loginStateSchema, seal, unseal } from "@/lib/auth/session";
import { tenantUrl } from "@/lib/auth/urls";

export const dynamic = "force-dynamic";

/**
 * Zentraler OAuth-Callback (EINE Callback-URL für alle Mandanten, unter
 * APP_BASE_URL). Prüft den Login und schickt ein kurzlebiges Ticket zurück
 * auf die Adresse des Mandanten, wo die Sitzung gesetzt wird.
 * Die Installation der App (Phase 4) läuft später ebenfalls hier an.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = unseal("login-state", params.get("state"), loginStateSchema);
  if (!state) {
    return new NextResponse("Anmeldung abgelaufen oder ungültig. Bitte erneut über das Admin-Backend anmelden.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const tenant = await withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ slug: string; custom_domain: string | null }>(
      "select slug, custom_domain from public.tenants where id = $1",
      [state.tid],
    );
    return rows[0] ? { slug: rows[0].slug, customDomain: rows[0].custom_domain } : null;
  });
  if (!tenant) return new NextResponse("Mandant nicht gefunden", { status: 404 });

  const fail = (error: string) => NextResponse.redirect(tenantUrl(tenant, "/admin/login", { error }));
  const cfg = oauthConfig();
  const code = params.get("code");
  if (!cfg) return fail("not_configured");
  // Benutzer hat in Pipedrive abgebrochen (error=access_denied) o. Ä.
  if (!code) return fail("cancelled");

  const result = await completePipedriveLogin(state, code, {
    exchangeCode: (c) => exchangeCode(cfg, c),
    getMe: (apiDomain, token) => getMe(apiDomain, token),
    connectedCompanyId,
    lookupMember: (tid, pdUserId) =>
      withActor({ role: "service_role" }, async (db) => {
        const { rows } = await db.query<{ user_id: string; auth_email: string; status: "active" | "disabled" }>(
          "select user_id, auth_email, status from public.member_login_lookup($1, $2)",
          [tid, pdUserId],
        );
        const r = rows[0];
        return r ? { userId: r.user_id, authEmail: r.auth_email, status: r.status } : null;
      }),
    refreshMemberCache: (tid, userId, me) =>
      withActor({ role: "service_role" }, async (db) => {
        await db.query(
          "update public.tenant_members set display_name = $3, email = $4 where tenant_id = $1 and user_id = $2",
          [tid, userId, me.name.slice(0, 200), me.email],
        );
      }),
    storeUserTokens: (tid, uid, me, tokens) => storeUserTokens(getPool(), tid, uid, me, tokens),
  });
  if (!result.ok) return fail(result.error);

  const ticket = seal("login-ticket", { ...result.session, nonce: state.nonce }, LOGIN_TICKET_TTL_SECONDS);
  return NextResponse.redirect(tenantUrl(tenant, "/api/auth/session", { ticket }));
}
