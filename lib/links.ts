/**
 * Zentrale Erzeugung öffentlicher Links (Buchungsseite, .ics) für Mails.
 * Alles liegt unter APP_BASE_URL (z. B. https://meetings.atools.de); der
 * Mandant ergibt sich aus dem Buchungslink selbst – keine Subdomain, kein Slug.
 *
 *   1. tenants.custom_domain gesetzt -> https://<custom_domain>
 *   2. sonst                         -> APP_BASE_URL
 * Die App läuft im Root (kein basePath): verwendet wird nur der Origin.
 */

export type LinkTenant = { slug: string; customDomain?: string | null };

type Env = Record<string, string | undefined>;

/** Basis-URL der App (Origin, ohne abschließenden Schrägstrich) */
export function appBaseUrl(env: Env = process.env): string {
  return new URL(env.APP_BASE_URL || "http://localhost:3000").origin;
}

export function publicBaseUrl(t: LinkTenant, env: Env = process.env): string {
  if (t.customDomain) return `https://${t.customDomain}`;
  return appBaseUrl(env);
}

export function bookingUrl(t: LinkTenant, token: string, env: Env = process.env): string {
  return `${publicBaseUrl(t, env)}/b/${encodeURIComponent(token)}`;
}

export function bookingIcsUrl(t: LinkTenant, token: string, env: Env = process.env): string {
  return `${publicBaseUrl(t, env)}/b/${encodeURIComponent(token)}/ics`;
}
