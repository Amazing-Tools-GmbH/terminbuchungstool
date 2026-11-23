import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl, oauthConfig } from "@/lib/pipedrive/client";
import { LOGIN_NONCE_COOKIE, LOGIN_STATE_TTL_SECONDS, seal } from "@/lib/auth/session";
import { getAdminContext, secureCookies } from "@/lib/auth/admin";
import { appUrl, isAppOrigin } from "@/lib/auth/urls";

export const dynamic = "force-dynamic";

/**
 * Admin → Pipedrive-Verbindung → „Mit Pipedrive verbinden“ (nur owner):
 * OAuth mit einem State, der an Mandant + angemeldeten Owner gebunden ist.
 * Der zentrale Callback verbindet dann die freigegebene Pipedrive-Firma mit
 * DIESEM Mandanten (gleiche Firma: erneuern, andere Firma: umhängen).
 */
export async function GET(req: NextRequest) {
  if (!isAppOrigin(req.headers, req.url)) return NextResponse.redirect(appUrl("/admin/pipedrive"));
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(appUrl("/admin/login"));
  if (ctx.role !== "owner") return NextResponse.redirect(appUrl("/admin/pipedrive", { error: "forbidden" }));
  const cfg = oauthConfig();
  if (!cfg) return NextResponse.redirect(appUrl("/admin/pipedrive", { error: "pipedrive_relink_failed" }));

  const nonce = randomBytes(24).toString("base64url");
  const state = seal("login-state", { purpose: "relink", nonce, tid: ctx.tenant.id, uid: ctx.userId }, LOGIN_STATE_TTL_SECONDS);
  const res = NextResponse.redirect(authorizeUrl(cfg, state));
  res.cookies.set(LOGIN_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/api/auth",
    maxAge: LOGIN_STATE_TTL_SECONDS,
  });
  return res;
}
