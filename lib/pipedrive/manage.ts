import "server-only";
/**
 * Admin → Pipedrive-Verbindung: Status anzeigen, Verbindung testen, trennen
 * und (neu) verbinden – auch mit einer anderen Pipedrive-Firma.
 * Tokens liegen in pipedrive_connections (nur service_role); Aufrufer prüfen
 * vorher die Rolle (Status: owner/admin, Trennen/Verbinden: owner).
 */
import type { PoolClient } from "pg";
import { withActor } from "@/lib/db";
import { getPool } from "@/lib/db/pool";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError } from "@/lib/admin/errors";
import { getMe, oauthConfig, revokeToken, PipedriveError, type PipedriveMe, type PipedriveTokens } from "./client";
import { pipedriveAccess } from "./connection";
import { storeUserTokens } from "./user-connection";

export type ConnectionStatus = {
  status: "active" | "revoked" | "none";
  companyId: number | null;
  companyDomain: string | null;
  companyUrl: string | null;
  connectedAt: Date | null;
  revokedAt: Date | null;
  installedBy: string | null;
  scopes: string[];
  jobs: { queued: number; failed: number; lastError: string | null; lastErrorAt: Date | null };
  team: { active: number; withError: number };
};

export async function loadConnectionStatus(ctx: AdminContext): Promise<ConnectionStatus> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{
      status: "active" | "revoked";
      company_id: string;
      company_domain: string;
      created_at: Date;
      revoked_at: Date | null;
      scopes: string | null;
      installed_by: string | null;
    }>(
      `select c.status, c.company_id::text, c.company_domain, c.created_at, c.revoked_at, c.scopes,
              (select coalesce(m.display_name, m.email) from public.tenant_members m
                where m.tenant_id = c.tenant_id and m.pipedrive_user_id = c.installed_by_user_id limit 1) as installed_by
         from public.pipedrive_connections c where c.tenant_id = $1`,
      [ctx.tenant.id],
    );
    const { rows: j } = await db.query<{ queued: string; failed: string; last_error: string | null; last_at: Date | null }>(
      `select count(*) filter (where status in ('queued', 'sending'))::text as queued,
              count(*) filter (where status = 'failed' and created_at > now() - interval '7 days')::text as failed,
              (array_agg(last_error order by created_at desc) filter (where status = 'failed'))[1] as last_error,
              max(created_at) filter (where status = 'failed') as last_at
         from public.pipedrive_jobs where tenant_id = $1`,
      [ctx.tenant.id],
    );
    const { rows: u } = await db.query<{ active: string; error: string }>(
      `select count(*) filter (where status = 'active')::text as active, count(*) filter (where status = 'error')::text as error
         from public.pipedrive_user_connections where tenant_id = $1`,
      [ctx.tenant.id],
    );
    const c = rows[0];
    // Domain mit "~" = veraltete Zuordnung (andere Firma nutzt die Adresse inzwischen)
    const domain = c && !c.company_domain.includes("~") ? c.company_domain : null;
    return {
      status: c?.status ?? "none",
      companyId: c ? Number(c.company_id) : null,
      companyDomain: c?.company_domain.split("~")[0] ?? null,
      companyUrl: domain ? `https://${domain}.pipedrive.com` : null,
      connectedAt: c?.created_at ?? null,
      revokedAt: c?.revoked_at ?? null,
      installedBy: c?.installed_by ?? null,
      scopes: (c?.scopes ?? "").split(/[\s,]+/).filter(Boolean),
      jobs: { queued: Number(j[0]?.queued ?? 0), failed: Number(j[0]?.failed ?? 0), lastError: j[0]?.last_error ?? null, lastErrorAt: j[0]?.last_at ?? null },
      team: { active: Number(u[0]?.active ?? 0), withError: Number(u[0]?.error ?? 0) },
    };
  });
}

/** Verbindung prüfen: Token (ggf. erneuern) + /users/me */
export async function testConnection(ctx: AdminContext): Promise<{ companyName: string | null; user: string }> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  let access;
  try {
    access = await pipedriveAccess(ctx.tenant.id);
  } catch (err) {
    console.error("Pipedrive-Test: Token", (err as Error).message);
    throw new AdminError("pipedrive_unauthorized");
  }
  if (!access) throw new AdminError("pipedrive_not_connected");
  try {
    const me = await getMe(access.apiDomain, access.accessToken);
    return { companyName: me.companyName ?? null, user: me.name };
  } catch (err) {
    console.error("Pipedrive-Test: API", (err as Error).message);
    throw new AdminError(err instanceof PipedriveError && err.kind === "unauthorized" ? "pipedrive_unauthorized" : "pipedrive_unavailable");
  }
}

/**
 * Verbindung trennen (nur owner): Tokens bei Pipedrive widerrufen (best effort),
 * hier löschen und deaktivieren. Daten bleiben; Anmeldung und Panel gehen erst
 * nach dem (Neu-)Verbinden wieder.
 */
export async function disconnectPipedrive(ctx: AdminContext): Promise<void> {
  if (ctx.role !== "owner") throw new AdminError("forbidden");
  const tokens = await withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ refresh_token_enc: string }>(
      `update public.pipedrive_connections c
          set status = 'revoked', revoked_at = now(), access_token_enc = '', refresh_token_enc = '', expires_at = now()
         from (select refresh_token_enc from public.pipedrive_connections where tenant_id = $1 for update) old
        where c.tenant_id = $1 and c.status = 'active'
        returning old.refresh_token_enc`,
      [ctx.tenant.id],
    );
    if (!rows[0]) throw new AdminError("pipedrive_not_connected");
    const { rows: users } = await db.query<{ refresh_token_enc: string }>(
      "select refresh_token_enc from public.pipedrive_user_connections where tenant_id = $1",
      [ctx.tenant.id],
    );
    await db.query(
      `update public.pipedrive_user_connections
          set status = 'error', last_error = 'Pipedrive-Verbindung getrennt', access_token_enc = '', refresh_token_enc = '', expires_at = now()
        where tenant_id = $1`,
      [ctx.tenant.id],
    );
    return [rows[0].refresh_token_enc, ...users.map((u) => u.refresh_token_enc)];
  });
  const cfg = oauthConfig();
  if (!cfg) return;
  for (const enc of tokens) {
    if (!enc) continue;
    try {
      await revokeToken(cfg, decryptSecret(enc), "refresh_token");
    } catch {
      // nicht entschlüsselbar -> nichts zu widerrufen
    }
  }
}

export type RelinkResult =
  | { ok: true; changedCompany: boolean }
  | { ok: false; error: "company_in_use" | "forbidden" | "email_mismatch" };

/**
 * Mandant mit der Pipedrive-Firma verbinden, für die der angemeldete Owner
 * gerade die App freigegeben hat (gleiche Firma: Verbindung erneuern;
 * andere Firma: umhängen). Der Owner wird mit seinem Pipedrive-Benutzer
 * verknüpft; andere Mitglieder müssen bei einem Firmenwechsel in der
 * Nutzerverwaltung neu freigeschaltet werden.
 */
export async function relinkFromOAuth(tid: string, uid: string, me: PipedriveMe, t: PipedriveTokens): Promise<RelinkResult> {
  const res = await withActor({ role: "service_role" }, async (db): Promise<RelinkResult> => {
    const { rows: m } = await db.query<{ role: string; status: string }>(
      "select role::text, status::text from public.tenant_members where tenant_id = $1 and user_id = $2 for update",
      [tid, uid],
    );
    if (m[0]?.role !== "owner" || m[0]?.status !== "active") return { ok: false, error: "forbidden" };
    // gleiche Regel wie beim Login: Pipedrive-E-Mail = E-Mail des angemeldeten Benutzers
    const { rows: a } = await db.query<{ id: string | null }>("select public.auth_user_id_by_email($1) as id", [me.email]);
    if (a[0]?.id !== uid) return { ok: false, error: "email_mismatch" };

    // Firma schon mit einem anderen Mandanten aktiv verbunden?
    const { rows: other } = await db.query<{ tenant_id: string; status: string }>(
      "select tenant_id, status from public.pipedrive_connections where company_id = $1 and tenant_id <> $2 for update",
      [me.companyId, tid],
    );
    if (other[0]?.status === "active") return { ok: false, error: "company_in_use" };
    // getrennte Verbindung eines anderen Mandanten zu dieser Firma freigeben (company_id ist eindeutig)
    if (other[0]) await db.query("delete from public.pipedrive_connections where tenant_id = $1 and status = 'revoked'", [other[0].tenant_id]);
    // Adresse gehört jetzt dieser Firma (veraltete Zuordnung freigeben, wie bei der Installation)
    await db.query(
      `update public.pipedrive_connections set company_domain = company_domain || '~' || company_id::text
        where company_domain = $1 and company_id <> $2`,
      [me.companyDomain, me.companyId],
    );

    const { rows: cur } = await db.query<{ company_id: string }>(
      "select company_id::text from public.pipedrive_connections where tenant_id = $1 for update",
      [tid],
    );
    const changedCompany = !!cur[0] && Number(cur[0].company_id) !== me.companyId;
    await db.query(
      `insert into public.pipedrive_connections
         (tenant_id, company_id, company_domain, api_domain, access_token_enc, refresh_token_enc, expires_at, scopes, installed_by_user_id, status, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', null)
       on conflict (tenant_id) do update
         set company_id = excluded.company_id, company_domain = excluded.company_domain, api_domain = excluded.api_domain,
             access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
             expires_at = excluded.expires_at, scopes = excluded.scopes, installed_by_user_id = excluded.installed_by_user_id,
             status = 'active', revoked_at = null`,
      [tid, me.companyId, me.companyDomain, t.apiDomain, encryptSecret(t.accessToken), encryptSecret(t.refreshToken), t.expiresAt, t.scope, me.id],
    );
    if (changedCompany) await detachOldCompany(db, tid, uid);
    await linkOwner(db, tid, uid, me);
    return { ok: true, changedCompany };
  });
  if (res.ok) await storeUserTokens(getPool(), tid, uid, me, t);
  return res;
}

/** Firmenwechsel: Pipedrive-Zuordnungen der alten Firma gelten nicht mehr */
async function detachOldCompany(db: PoolClient, tid: string, uid: string) {
  await db.query("update public.tenant_members set pipedrive_user_id = null where tenant_id = $1 and user_id <> $2", [tid, uid]);
  await db.query("delete from public.pipedrive_user_connections where tenant_id = $1", [tid]);
}

async function linkOwner(db: PoolClient, tid: string, uid: string, me: PipedriveMe) {
  await db.query("update public.tenant_members set pipedrive_user_id = null where tenant_id = $1 and pipedrive_user_id = $2 and user_id <> $3", [
    tid,
    me.id,
    uid,
  ]);
  await db.query("update public.tenant_members set pipedrive_user_id = $3, display_name = $4 where tenant_id = $1 and user_id = $2", [
    tid,
    uid,
    me.id,
    me.name.slice(0, 200),
  ]);
}
