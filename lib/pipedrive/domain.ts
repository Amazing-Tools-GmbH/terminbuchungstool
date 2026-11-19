/**
 * Mandanten-Slug aus der Pipedrive-Unternehmensdomain.
 *
 * Jede Pipedrive-Firma hat eine eindeutige Domain <firma>.pipedrive.com.
 * Bei der OAuth-Installation (Phase 4) wird daraus der Slug des neuen
 * Mandanten: antennevorarlberg.pipedrive.com -> "antennevorarlberg"
 * -> Buchungsseite unter antennevorarlberg.<APP_DOMAIN>.
 *
 * Der Slug wird nur EINMAL bei der Installation gesetzt und danach nicht
 * mehr automatisch geändert (sonst brächen verschickte Buchungslinks).
 * Eindeutiger Schlüssel des Mandanten bleibt die Pipedrive company_id.
 */
import { RESERVED_SUBDOMAINS, isValidSlug } from "@/lib/tenant/host";

const PIPEDRIVE_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.pipedrive\.com$/;

/**
 * Extrahiert die Unternehmensdomain aus api_domain ("https://firma.pipedrive.com"),
 * einem Host ("firma.pipedrive.com") oder der reinen company_domain ("firma").
 */
export function parsePipedriveCompanyDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = value.replace(/\.$/, "");
  const match = PIPEDRIVE_HOST.exec(value);
  if (match) return match[1]!;
  return isValidSlug(value) ? value : null;
}

/**
 * Slug-Vorschlag für einen neuen Mandanten. Kollidiert die Domain mit einer
 * reservierten Subdomain unserer App (www, app, api, admin, static), wird
 * "-pd" angehängt. Ob der Slug noch frei ist, prüft die Unique-Constraint
 * auf tenants.slug bei der Installation.
 */
export function tenantSlugFromPipedrive(input: string): string | null {
  const domain = parsePipedriveCompanyDomain(input);
  if (!domain) return null;
  return RESERVED_SUBDOMAINS.has(domain) ? `${domain}-pd` : domain;
}
