import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentTenant } from "@/lib/tenant/current";
import { authorizeUrl, oauthConfig } from "@/lib/pipedrive/client";
import { LOGIN_NONCE_COOKIE, LOGIN_STATE_TTL_SECONDS, seal } from "@/lib/auth/session";
import { secureCookies } from "@/lib/auth/admin";
import { tenantOrigin, tenantUrl } from "@/lib/auth/urls";
import { cookiePath } from "@/lib/base-path";

export const dynamic = "force-dynamic";

/**
 * Startet "Mit Pipedrive anmelden" auf der Adresse des Mandanten.
 * Der Nonce liegt als Cookie auf diesem Host; der zentrale Callback kann
 * das Ergebnis nur zusammen mit diesem Cookie einlösen (Schutz vor
 * untergeschobenen Logins).
 */
export async function GET(req: NextRequest) {
  const tenant = await getCurrentTenant();
  if (!tenant) return new NextResponse("Mandant nicht gefunden", { status: 404 });

  // Immer auf der kanonischen Adresse des Mandanten starten (dorthin führt der Callback zurück)
  if (req.nextUrl.origin !== tenantOrigin(tenant)) {
    return NextResponse.redirect(tenantUrl(tenant, "/api/auth/pipedrive/start"));
  }

  const cfg = oauthConfig();
  if (!cfg) return NextResponse.redirect(tenantUrl(tenant, "/admin/login", { error: "not_configured" }));

  const nonce = randomBytes(24).toString("base64url");
  const state = seal("login-state", { purpose: "login", tid: tenant.id, nonce }, LOGIN_STATE_TTL_SECONDS);
  const res = NextResponse.redirect(authorizeUrl(cfg, state));
  res.cookies.set(LOGIN_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: cookiePath("/api/auth"),
    maxAge: LOGIN_STATE_TTL_SECONDS,
  });
  return res;
}
