import { appUrl } from "@/lib/auth/urls";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

/** Abmelden (POST aus dem Admin-Backend) */
export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(appUrl("/admin/login"), 303);
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
