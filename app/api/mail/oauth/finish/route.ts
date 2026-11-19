import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/admin";
import { MAIL_NONCE_COOKIE } from "@/lib/auth/session";
import { tenantUrl } from "@/lib/auth/urls";
import { AdminError } from "@/lib/admin/errors";
import { finishPendingMailbox } from "@/lib/mail/connect";
import { sendMailsSoon } from "@/lib/booking/api";
import { withBasePath } from "@/lib/base-path";
import { cookiePath } from "@/lib/base-path";

export const dynamic = "force-dynamic";

/** Abschluss auf der Mandanten-Adresse: Sitzung + Nonce-Cookie prüfen, speichern, Testmail */
export async function GET(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(new URL(withBasePath("/admin/login"), req.nextUrl.origin));
  const pending = z.string().uuid().safeParse(req.nextUrl.searchParams.get("pending"));
  let target: string;
  try {
    if (!pending.success) throw new AdminError("mail_expired");
    const { scope } = await finishPendingMailbox(ctx, pending.data, req.cookies.get(MAIL_NONCE_COOKIE)?.value);
    sendMailsSoon(ctx.tenant.id);
    target = tenantUrl(ctx.tenant, scope === "tenant" ? "/admin/email" : "/admin/postfach", { ok: "connected" });
  } catch (err) {
    const code = err instanceof AdminError ? err.code : "generic";
    target = tenantUrl(ctx.tenant, "/admin/postfach", { error: code });
  }
  const res = NextResponse.redirect(target);
  res.cookies.set(MAIL_NONCE_COOKIE, "", { path: cookiePath("/api/mail"), maxAge: 0 });
  return res;
}
