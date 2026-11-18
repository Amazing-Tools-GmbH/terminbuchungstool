import { NextResponse, type NextRequest } from "next/server";
import {
  TENANT_COOKIE,
  TENANT_HEADER,
  TENANT_QUERY_PARAM,
  encodeTenantKey,
  parseTenantKey,
  tenantQueryAllowed,
} from "@/lib/tenant/host";

/**
 * Ermittelt aus Host (bzw. in Vorschauen aus ?tenant=) den Mandanten-
 * Schlüssel und reicht ihn als Request-Header an die Server-Komponenten
 * weiter. Ein vom Client mitgeschickter Header wird immer verworfen.
 */
export function middleware(req: NextRequest) {
  const allowQuery = tenantQueryAllowed(process.env);
  const queryTenant = req.nextUrl.searchParams.get(TENANT_QUERY_PARAM);

  const key = parseTenantKey({
    host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    appDomain: process.env.APP_DOMAIN ?? "localhost:3000",
    queryTenant,
    cookieTenant: req.cookies.get(TENANT_COOKIE)?.value,
    allowQuery,
  });

  const headers = new Headers(req.headers);
  headers.delete(TENANT_HEADER);
  if (key) headers.set(TENANT_HEADER, encodeTenantKey(key));

  const res = NextResponse.next({ request: { headers } });
  // Vorschau-Fallback merken, damit Folgeseiten ohne ?tenant= funktionieren
  if (allowQuery && queryTenant && key?.kind === "slug") {
    res.cookies.set(TENANT_COOKIE, key.slug, { path: "/", sameSite: "lax", httpOnly: true });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|dev-assets/).*)"],
};
