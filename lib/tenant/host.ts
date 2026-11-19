/**
 * Mandantenauflösung (reine Logik, läuft in der Middleware/Edge).
 * Reihenfolge:
 *   1. ?tenant=<slug> bzw. Cookie – NUR wenn erlaubt (nie in Produktion)
 *   2. <slug>.<APP_DOMAIN>
 *   3. Host als hinterlegte custom_domain
 * Die eigentliche DB-Abfrage passiert serverseitig (lib/tenant/current.ts).
 */

export type TenantKey =
  | { kind: "slug"; slug: string }
  | { kind: "domain"; domain: string }
  /** Buchungslink /b/<token>: Mandant aus dem Token; domain = eigene Kundendomain des Hosts (Prüfung) */
  | { kind: "token"; token: string; domain: string | null };

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** /b/<token>[/…] (Pfad ohne Unterpfad) -> Token, sonst null */
export function bookingTokenFromPath(pathname: string): string | null {
  const m = /^\/b\/([^/]+)(?:\/|$)/.exec(pathname);
  return m && TOKEN.test(m[1]!) ? m[1]! : null;
}

export const TENANT_HEADER = "x-tb-tenant";
export const TENANT_QUERY_PARAM = "tenant";
export const TENANT_COOKIE = "tb_tenant";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Subdomains, die nie ein Mandant sind */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set(["www", "app", "api", "admin", "static"]);

export function isValidSlug(s: string): boolean {
  return SLUG.test(s);
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

/**
 * Der Query-Fallback ist für Vercel-Vorschauen gedacht. In Produktion
 * (VERCEL_ENV=production) ist er IMMER aus, egal was konfiguriert ist.
 */
export function tenantQueryAllowed(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.ALLOW_TENANT_QUERY_PARAM === "true";
}

export function parseTenantKey(input: {
  host: string | null;
  appDomain: string;
  queryTenant?: string | null;
  cookieTenant?: string | null;
  allowQuery: boolean;
}): TenantKey | null {
  if (input.allowQuery) {
    for (const candidate of [input.queryTenant, input.cookieTenant]) {
      const slug = candidate?.trim().toLowerCase();
      if (slug && isValidSlug(slug)) return { kind: "slug", slug };
    }
  }

  const host = input.host?.trim().toLowerCase();
  if (!host) return null;
  const appDomain = input.appDomain.trim().toLowerCase();

  if (host === appDomain || stripPort(host) === stripPort(appDomain)) return null;

  if (host.endsWith(`.${appDomain}`)) {
    const sub = host.slice(0, -(appDomain.length + 1));
    if (sub.includes(".") || RESERVED_SUBDOMAINS.has(sub) || !isValidSlug(sub)) return null;
    return { kind: "slug", slug: sub };
  }

  const domain = stripPort(host);
  if (!HOSTNAME.test(domain)) return null;
  return { kind: "domain", domain };
}

export function encodeTenantKey(key: TenantKey): string {
  if (key.kind === "token") return `token:${key.domain ?? "-"}:${key.token}`;
  return key.kind === "slug" ? `slug:${key.slug}` : `domain:${key.domain}`;
}

export function decodeTenantKey(value: string | null | undefined): TenantKey | null {
  if (!value) return null;
  const [kind, ...rest] = value.split(":");
  const v = rest.join(":");
  if (kind === "slug" && isValidSlug(v)) return { kind: "slug", slug: v };
  if (kind === "domain" && HOSTNAME.test(v)) return { kind: "domain", domain: v };
  if (kind === "token") {
    const [domain, token] = [rest[0] ?? "", rest.slice(1).join(":")];
    if (!TOKEN.test(token) || (domain !== "-" && !HOSTNAME.test(domain))) return null;
    return { kind: "token", token, domain: domain === "-" ? null : domain };
  }
  return null;
}
