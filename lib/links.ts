/**
 * Zentrale Erzeugung öffentlicher Links (Buchungsseite, .ics) für Mails.
 * Die endgültige Domain-Struktur ist noch offen; sie wird NUR hier und über
 * Umgebungsvariablen festgelegt:
 *
 *   1. tenants.custom_domain gesetzt      -> https://<custom_domain>
 *   2. TENANT_BASE_URL_TEMPLATE gesetzt   -> Vorlage mit {slug},
 *        z. B. "https://{slug}.termine.example.at" oder "https://termine.example.at/{slug}"
 *   3. sonst (Dev/Preview)                -> APP_BASE_URL + ?tenant=<slug>
 */

export type LinkTenant = { slug: string; customDomain?: string | null };

type Env = Record<string, string | undefined>;

export function tenantBaseUrl(t: LinkTenant, env: Env = process.env): { base: string; query: string } {
  if (t.customDomain) return { base: `https://${t.customDomain}`, query: "" };
  const template = env.TENANT_BASE_URL_TEMPLATE;
  if (template && template.includes("{slug}")) {
    return { base: template.replace("{slug}", t.slug).replace(/\/$/, ""), query: "" };
  }
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return { base, query: `?tenant=${encodeURIComponent(t.slug)}` };
}

export function bookingUrl(t: LinkTenant, token: string, env: Env = process.env): string {
  const { base, query } = tenantBaseUrl(t, env);
  return `${base}/b/${encodeURIComponent(token)}${query}`;
}

export function bookingIcsUrl(t: LinkTenant, token: string, env: Env = process.env): string {
  const { base, query } = tenantBaseUrl(t, env);
  return `${base}/b/${encodeURIComponent(token)}/ics${query}`;
}
