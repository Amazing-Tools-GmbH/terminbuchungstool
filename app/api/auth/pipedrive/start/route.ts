import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl, oauthConfig } from "@/lib/pipedrive/client";
import { LOGIN_NONCE_COOKIE, LOGIN_STATE_TTL_SECONDS, seal } from "@/lib/auth/session";
import { secureCookies } from "@/lib/auth/admin";
import { appOrigin, appUrl } from "@/lib/auth/urls";
import { cookiePath } from "@/lib/base-path";

export const dynamic = "force-dynamic";

/**
 * Startet "Mit Pipedrive anmelden" – immer auf der zentralen Adresse
 * (APP_BASE_URL). Der Nonce liegt als Cookie dort; der Callback (gleiche
 * Adresse) akzeptiert die Anmeldung nur zusammen mit diesem Cookie.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.origin !== appOrigin()) return NextResponse.redirect(appUrl("/api/auth/pipedrive/start"));

  const cfg = oauthConfig();
  if (!cfg) return NextResponse.redirect(appUrl("/admin/login", { error: "not_configured" }));

  const nonce = randomBytes(24).toString("base64url");
  const state = seal("login-state", { purpose: "login", nonce }, LOGIN_STATE_TTL_SECONDS);
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
