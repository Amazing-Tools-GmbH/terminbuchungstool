/**
 * Kanonische Adresse des Admin-Backends eines Mandanten (dorthin führt der
 * Login zurück; nur dort gelten Nonce- und Sitzungs-Cookie). Gleiche Regeln
 * wie für Links in Mails (lib/links.ts).
 */
import { tenantBaseUrl, type LinkTenant } from "@/lib/links";

type Env = Record<string, string | undefined>;

/** Absolute URL eines Pfads im Admin-Bereich des Mandanten, z. B. "/admin" */
export function tenantUrl(t: LinkTenant, path: string, params: Record<string, string> = {}, env: Env = process.env): string {
  const { base, query } = tenantBaseUrl(t, env);
  const url = new URL(`${base}${path}${query}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Origin (Schema + Host) der kanonischen Mandanten-Adresse */
export function tenantOrigin(t: LinkTenant, env: Env = process.env): string {
  return new URL(tenantBaseUrl(t, env).base).origin;
}
