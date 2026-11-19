import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { withBasePath } from "@/lib/base-path";
import { cookiePath } from "@/lib/base-path";

/** Abmelden (POST aus dem Admin-Backend) */
export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL(withBasePath("/admin/login"), req.nextUrl.origin), 303);
  res.cookies.set(SESSION_COOKIE, "", { path: cookiePath(), maxAge: 0 });
  return res;
}
