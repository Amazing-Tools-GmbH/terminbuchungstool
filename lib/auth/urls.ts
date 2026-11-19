/**
 * Adressen der zentralen App (Admin-Backend, Login, OAuth-Callbacks):
 * immer unter APP_BASE_URL (z. B. https://meetings.atools.de).
 */
import { appBaseUrl } from "@/lib/links";

type Env = Record<string, string | undefined>;

/** Absolute URL eines Pfads der App, z. B. appUrl("/admin/login", { error: "x" }) */
export function appUrl(path: string, params: Record<string, string> = {}, env: Env = process.env): string {
  const url = new URL(`${appBaseUrl(env)}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Origin (Schema + Host) der App */
export function appOrigin(env: Env = process.env): string {
  return new URL(appBaseUrl(env)).origin;
}

type HeaderSource = { get(name: string): string | null };

/**
 * Öffentliche Adresse, unter der der Browser die Anfrage gestellt hat. Hinter Caddy
 * sieht Next.js nur http://127.0.0.1:3003 – maßgeblich sind dann X-Forwarded-Proto/-Host
 * (setzt Caddy; die App ist von außen nur über Caddy erreichbar).
 */
export function requestOrigin(headers: HeaderSource, requestUrl: string): string {
  const url = new URL(requestUrl);
  const first = (v: string | null) => v?.split(",")[0]?.trim().toLowerCase() || null;
  const fwdProto = first(headers.get("x-forwarded-proto"));
  const proto = fwdProto === "https" || fwdProto === "http" ? fwdProto : url.protocol.replace(":", "");
  const host = first(headers.get("x-forwarded-host")) ?? first(headers.get("host")) ?? url.host;
  return `${proto}://${host}`;
}

/** Läuft die Anfrage über die zentrale Adresse (APP_BASE_URL)? */
export function isAppOrigin(headers: HeaderSource, requestUrl: string, env: Env = process.env): boolean {
  return requestOrigin(headers, requestUrl) === appOrigin(env);
}
