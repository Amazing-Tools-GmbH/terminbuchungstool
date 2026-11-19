import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getAdminContext, secureCookies } from "@/lib/auth/admin";
import { MAIL_NONCE_COOKIE, seal } from "@/lib/auth/session";
import { appUrl, isAppOrigin } from "@/lib/auth/urls";
import { mailAuthorizeUrl, mailOAuthConfig, MAIL_OAUTH_PROVIDERS, type MailOAuthProviderId } from "@/lib/mail/oauth";

export const dynamic = "force-dynamic";

const STATE_TTL = 10 * 60;

/**
 * Startet "Postfach verbinden" (Google/Microsoft) auf der zentralen Adresse.
 * ?scope=user (eigenes Postfach, alle Mitglieder) | tenant (Firmenpostfach, owner/admin)
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(appUrl("/admin/login"));
  const scope = req.nextUrl.searchParams.get("scope") === "tenant" ? "tenant" : "user";
  const back = scope === "tenant" ? "/admin/email" : "/admin/postfach";

  if (!(MAIL_OAUTH_PROVIDERS as readonly string[]).includes(provider)) return new NextResponse("Unbekannter Anbieter", { status: 404 });
  if (scope === "tenant" && ctx.role === "sales") return NextResponse.redirect(appUrl(back, { error: "forbidden" }));
  if (!isAppOrigin(req.headers, req.url)) {
    return NextResponse.redirect(appUrl(`/api/mail/oauth/${provider}/start`, { scope }));
  }
  const cfg = mailOAuthConfig(provider as MailOAuthProviderId);
  if (!cfg) return NextResponse.redirect(appUrl(back, { error: "mail_not_configured" }));

  const nonce = randomBytes(24).toString("base64url");
  const state = seal("mail-state", { purpose: "mail", provider, scope, tid: ctx.tenant.id, uid: ctx.userId, nonce }, STATE_TTL);
  const res = NextResponse.redirect(mailAuthorizeUrl(provider as MailOAuthProviderId, cfg, state, scope === "user" ? ctx.email : null));
  res.cookies.set(MAIL_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/api/mail", maxAge: STATE_TTL });
  return res;
}
