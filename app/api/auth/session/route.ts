import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentTenant } from "@/lib/tenant/current";
import { LOGIN_NONCE_COOKIE, loginTicketSchema, unseal } from "@/lib/auth/session";
import { sessionCookie } from "@/lib/auth/admin";
import { tenantUrl } from "@/lib/auth/urls";

export const dynamic = "force-dynamic";

function sameNonce(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Löst das Login-Ticket aus dem OAuth-Callback auf der Adresse des Mandanten ein. */
export async function GET(req: NextRequest) {
  const tenant = await getCurrentTenant();
  if (!tenant) return new NextResponse("Mandant nicht gefunden", { status: 404 });

  const ticket = unseal("login-ticket", req.nextUrl.searchParams.get("ticket"), loginTicketSchema);
  const nonce = req.cookies.get(LOGIN_NONCE_COOKIE)?.value;
  if (!ticket || ticket.tid !== tenant.id || !sameNonce(ticket.nonce, nonce)) {
    return NextResponse.redirect(tenantUrl(tenant, "/admin/login", { error: "expired" }));
  }

  const res = NextResponse.redirect(tenantUrl(tenant, "/admin"));
  res.cookies.set(sessionCookie({ uid: ticket.uid, tid: ticket.tid, pd: ticket.pd }));
  res.cookies.set(LOGIN_NONCE_COOKIE, "", { path: "/api/auth", maxAge: 0 });
  return res;
}
