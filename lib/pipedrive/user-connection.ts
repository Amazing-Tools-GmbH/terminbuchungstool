/**
 * Pipedrive-Zugang je Mitarbeiter: Tokens aus "Mit Pipedrive anmelden"
 * (verschlüsselt), für den Versand von Einladungen in seinem Namen.
 * Nur Server (service_role) – Tokens sind für authenticated nicht lesbar.
 * Bekommt den Pool übergeben (läuft auch in der Outbox und in Tests).
 */
import type pg from "pg";
import { withActorOn } from "@/lib/db/actor";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { MailSendError } from "@/lib/mail/types";
import { oauthConfig, refreshTokens, PipedriveError, type PipedriveMe, type PipedriveTokens } from "./client";
import type { PipedriveMailAccess } from "./mail";

export async function storeUserTokens(pool: pg.Pool, tenantId: string, userId: string, me: PipedriveMe, t: PipedriveTokens): Promise<void> {
  await withActorOn(pool, { role: "service_role" }, async (db) => {
    await db.query(
      `insert into public.pipedrive_user_connections
         (tenant_id, user_id, pipedrive_user_id, api_domain, access_token_enc, refresh_token_enc, expires_at, scopes, status, last_error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', null)
       on conflict (tenant_id, user_id) do update
         set pipedrive_user_id = excluded.pipedrive_user_id, api_domain = excluded.api_domain,
             access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
             expires_at = excluded.expires_at, scopes = excluded.scopes, status = 'active', last_error = null`,
      [tenantId, userId, me.id, t.apiDomain, encryptSecret(t.accessToken), encryptSecret(t.refreshToken), t.expiresAt, t.scope],
    );
  });
}

export async function markUserConnectionError(pool: pg.Pool, tenantId: string, userId: string, message: string): Promise<void> {
  await withActorOn(pool, { role: "service_role" }, async (db) => {
    await db.query("update public.pipedrive_user_connections set status = 'error', last_error = $3 where tenant_id = $1 and user_id = $2", [
      tenantId,
      userId,
      message,
    ]);
  });
}

/** Gültiger Zugang des Mitarbeiters (erneuert das Token bei Bedarf) */
export async function userPipedriveAccess(pool: pg.Pool, tenantId: string, userId: string): Promise<PipedriveMailAccess> {
  return withActorOn(pool, { role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ api_domain: string; access_token_enc: string; refresh_token_enc: string; expires_at: Date; status: string }>(
      `select api_domain, access_token_enc, refresh_token_enc, expires_at, status
         from public.pipedrive_user_connections where tenant_id = $1 and user_id = $2 for update`,
      [tenantId, userId],
    );
    const row = rows[0];
    if (!row) throw new MailSendError("auth", "Kein Pipedrive-Zugang – bitte einmal über Pipedrive anmelden", "pipedrive_reauth");
    if (row.expires_at.getTime() > Date.now() + 30_000) {
      return { apiDomain: row.api_domain, accessToken: decryptSecret(row.access_token_enc) };
    }
    const cfg = oauthConfig();
    if (!cfg) throw new MailSendError("transient", "PIPEDRIVE_CLIENT_ID/SECRET fehlen", "pipedrive_unavailable");
    let t: PipedriveTokens;
    try {
      t = await refreshTokens(cfg, decryptSecret(row.refresh_token_enc));
    } catch (err) {
      if (err instanceof PipedriveError && err.kind === "oauth" && err.status && err.status < 500) {
        throw new MailSendError("auth", "Pipedrive-Anmeldung abgelaufen – bitte neu anmelden", "pipedrive_reauth");
      }
      throw new MailSendError("transient", "Pipedrive-Anmeldedienst nicht erreichbar", "pipedrive_unavailable");
    }
    await db.query(
      `update public.pipedrive_user_connections
          set access_token_enc = $3, refresh_token_enc = $4, expires_at = $5, api_domain = $6, scopes = coalesce($7, scopes)
        where tenant_id = $1 and user_id = $2`,
      [tenantId, userId, encryptSecret(t.accessToken), encryptSecret(t.refreshToken), t.expiresAt, t.apiDomain, t.scope],
    );
    return { apiDomain: t.apiDomain, accessToken: t.accessToken };
  });
}
