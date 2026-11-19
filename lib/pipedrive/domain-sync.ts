/**
 * Pipedrive-Adresse aktuell halten. Kunden können ihre Adresse in Pipedrive
 * ändern (firma.pipedrive.com -> neu.pipedrive.com); der Mandant hängt an der
 * company_id und bleibt gleich, nur pipedrive_connections.company_domain (für
 * Deal-Links) wird nachgezogen. Quelle ist die api_domain, die Pipedrive bei
 * jeder Token-Erneuerung mitschickt.
 * Läuft in der Transaktion des Aufrufers, abgesichert per Savepoint: Ein Fehler
 * hier darf nie die frisch erneuerten Tokens verwerfen.
 */
import type pg from "pg";

const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.pipedrive\.com$/;
/** Hosts von Pipedrive selbst, keine Firmenadressen */
const NOT_COMPANY = new Set(["api", "oauth", "www", "app", "developers", "marketplace", "mcp"]);

/** Firmenadresse aus api_domain ("https://firma.pipedrive.com"); null, wenn nicht eindeutig */
export function companyDomainFromApiDomain(apiDomain: string): string | null {
  let host: string;
  try {
    host = new URL(apiDomain.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  const m = HOST.exec(host);
  return m && !NOT_COMPANY.has(m[1]!) ? m[1]! : null;
}

type Target = { companyId: number } | { tenantId: string };

/** Setzt die Adresse der Verbindung; eine veraltete Zuordnung derselben Adresse bei einer anderen Firma wird freigegeben */
export async function syncCompanyDomainOn(db: pg.ClientBase, target: Target, domain: string | null): Promise<void> {
  if (!domain) return;
  const where = "companyId" in target ? "company_id = $1" : "tenant_id = $1";
  const key = "companyId" in target ? target.companyId : target.tenantId;
  await db.query("savepoint tb_domain_sync");
  try {
    await db.query(
      `update public.pipedrive_connections set company_domain = company_domain || '~' || company_id::text
        where company_domain = $2
          and company_id <> (select c.company_id from public.pipedrive_connections c where c.${where})`,
      [key, domain],
    );
    await db.query(`update public.pipedrive_connections set company_domain = $2 where ${where} and company_domain <> $2`, [key, domain]);
    await db.query("release savepoint tb_domain_sync");
  } catch (err) {
    await db.query("rollback to savepoint tb_domain_sync");
    console.error("Pipedrive-Adresse nicht aktualisiert", err);
  }
}
