import "server-only";
/**
 * Zugriff auf die Pipedrive-Verbindung eines Mandanten (Tokens aus der
 * Installation). Läuft als service_role, weil pipedrive_connections
 * verschlüsselte Tokens enthält und für authenticated nicht lesbar ist –
 * Aufrufer müssen vorher geprüft haben, dass der Benutzer Mitglied ist.
 */
import { withActor } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { oauthConfig, refreshTokens, PipedriveError } from "./client";

export type PipedriveAccess = { apiDomain: string; accessToken: string; companyId: number; companyDomain: string };

type Row = {
  api_domain: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
  company_id: string;
  company_domain: string;
};

/** Gültiger Zugang (erneuert das Token bei Bedarf); null = keine Verbindung */
export async function pipedriveAccess(tenantId: string): Promise<PipedriveAccess | null> {
  return withActor({ role: "service_role" }, async (db) => {
    // FOR UPDATE: zwei gleichzeitige Anfragen erneuern das Token nicht doppelt
    const { rows } = await db.query<Row>(
      `select api_domain, access_token_enc, refresh_token_enc, expires_at, company_id::text, company_domain
         from public.pipedrive_connections where tenant_id = $1 and status = 'active' for update`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    const base = { companyId: Number(row.company_id), companyDomain: row.company_domain };

    if (row.expires_at.getTime() > Date.now()) {
      return { ...base, apiDomain: row.api_domain, accessToken: decryptSecret(row.access_token_enc) };
    }
    const cfg = oauthConfig();
    if (!cfg) throw new PipedriveError("oauth", "PIPEDRIVE_CLIENT_ID/SECRET fehlen – Token kann nicht erneuert werden");
    const t = await refreshTokens(cfg, decryptSecret(row.refresh_token_enc));
    await db.query(
      `update public.pipedrive_connections
          set access_token_enc = $2, refresh_token_enc = $3, expires_at = $4, api_domain = $5, scopes = coalesce($6, scopes)
        where tenant_id = $1`,
      [tenantId, encryptSecret(t.accessToken), encryptSecret(t.refreshToken), t.expiresAt, t.apiDomain, t.scope],
    );
    return { ...base, apiDomain: t.apiDomain, accessToken: t.accessToken };
  });
}

/** Pipedrive company_id der Verbindung des Mandanten (für den Login-Abgleich) */
export async function connectedCompanyId(tenantId: string): Promise<number | null> {
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ company_id: string }>(
      "select company_id::text from public.pipedrive_connections where tenant_id = $1",
      [tenantId],
    );
    return rows[0] ? Number(rows[0].company_id) : null;
  });
}

/** Mandant zur Pipedrive-Firma (Login, Einstieg aus den App-Einstellungen) */
export async function tenantIdForCompany(companyId: number): Promise<string | null> {
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ tenant_id: string }>("select tenant_id from public.pipedrive_connections where company_id = $1 and status = 'active'", [
      companyId,
    ]);
    return rows[0]?.tenant_id ?? null;
  });
}
