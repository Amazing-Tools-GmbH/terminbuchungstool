import "server-only";
/**
 * Installation der Pipedrive-App (OAuth ohne unseren Login-State):
 *   - neue Firma  -> Mandant anlegen (Name aus Pipedrive, Slug aus der
 *                    Pipedrive-Domain, Standard-Theme), Verbindung speichern,
 *                    Installierender wird owner und ist angemeldet
 *   - vorbereiteter Mandant mit gleichem Slug, noch nie verbunden -> übernehmen
 *   - bekannte Firma -> Verbindung erneuern (Daten bleiben unverändert)
 * Deinstallation: Verbindung deaktivieren, Daten behalten.
 * Läuft als service_role (Server-Job "Pipedrive-Installation").
 */
import type { PoolClient } from "pg";
import { withActor } from "@/lib/db";
import { getPool } from "@/lib/db/pool";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { ensureAuthUser } from "@/lib/auth/users";
import type { Session } from "@/lib/auth/session";
import type { PipedriveMe, PipedriveTokens } from "./client";
import { tenantSlugFromPipedrive } from "./domain";
import { storeUserTokens } from "./user-connection";
import { syncCompanyDomainOn } from "./domain-sync";
import { recordAccessRequest } from "@/lib/access-requests";

export type InstallResult =
  | { ok: true; created: boolean; adopted: boolean; session: Session }
  | { ok: false; error: "no_access" | "install_failed"; created: boolean };

function validTimezone(tz: string | undefined): string {
  if (!tz) return "Europe/Vienna";
  try {
    new Intl.DateTimeFormat("de", { timeZone: tz });
    return tz;
  } catch {
    return "Europe/Vienna";
  }
}

/** Installierende:r wird aktiver Owner (bestehender Eintrag desselben Benutzers wird angehoben) */
async function addOwner(db: PoolClient, tid: string, uid: string, me: PipedriveMe) {
  // Pipedrive-ID eindeutig je Mandant: ein anderer Eintrag mit derselben ID verliert sie
  await db.query("update public.tenant_members set pipedrive_user_id = null where tenant_id = $1 and pipedrive_user_id = $2 and user_id <> $3", [
    tid,
    me.id,
    uid,
  ]);
  await db.query(
    `insert into public.tenant_members (tenant_id, user_id, role, status, pipedrive_user_id, display_name, email)
     values ($1, $2, 'owner', 'active', $3, $4, $5)
     on conflict (tenant_id, user_id) do update
       set role = 'owner', status = 'active', pipedrive_user_id = excluded.pipedrive_user_id,
           display_name = excluded.display_name, email = excluded.email`,
    [tid, uid, me.id, me.name.slice(0, 200), me.email],
  );
}

export async function installFromOAuth(me: PipedriveMe, t: PipedriveTokens): Promise<InstallResult> {
  // auth-Benutzer vorab (Supabase Auth-Admin-API außerhalb der Transaktion; ohne Mail)
  const authUserId = await ensureAuthUser(me.email, me.name);

  const res = await withActor({ role: "service_role" }, async (db) => {
    const conn = [t.apiDomain, encryptSecret(t.accessToken), encryptSecret(t.refreshToken), t.expiresAt, t.scope, me.id, me.companyDomain] as const;
    // Domain gehört jetzt dieser Firma: eine veraltete Zuordnung (andere Firma hat die
    // Domain inzwischen geändert) freigeben; deren Domain aktualisiert sich bei ihrem nächsten Login
    await db.query(
      `update public.pipedrive_connections set company_domain = company_domain || '~' || company_id::text
        where company_domain = $1 and company_id <> $2`,
      [me.companyDomain, me.companyId],
    );
    const { rows: existing } = await db.query<{ tenant_id: string }>(
      "select tenant_id from public.pipedrive_connections where company_id = $1 for update",
      [me.companyId],
    );
    if (existing[0]) {
      const tid = existing[0].tenant_id;
      await db.query(
        `update public.pipedrive_connections
            set api_domain = $2, access_token_enc = $3, refresh_token_enc = $4, expires_at = $5, scopes = $6,
                installed_by_user_id = $7, company_domain = $8, status = 'active', revoked_at = null
          where tenant_id = $1`,
        [tid, ...conn],
      );
      const { rows } = await db.query<{ user_id: string }>(
        "select user_id from public.tenant_members where tenant_id = $1 and pipedrive_user_id = $2 and status = 'active'",
        [tid, me.id],
      );
      return { tid, created: false, adopted: false, uid: rows[0]?.user_id ?? null };
    }

    const base = tenantSlugFromPipedrive(me.companyDomain) ?? `firma-${me.companyId}`;

    // vorbereiteter Mandant (z. B. aus dem Seed) mit genau diesem Slug, der noch NIE mit
    // Pipedrive verbunden war: übernehmen statt einen zweiten anzulegen. Daten (Theme,
    // Termine, Name, Zeitzone) bleiben; Installierende:r wird Owner.
    const { rows: prepared } = await db.query<{ id: string }>(
      `select t.id from public.tenants t
        where t.slug = $1
          and not exists (select 1 from public.pipedrive_connections c where c.tenant_id = t.id)
        for update`,
      [base],
    );
    if (prepared[0]) {
      const tid = prepared[0].id;
      await db.query(
        `insert into public.pipedrive_connections
           (tenant_id, api_domain, access_token_enc, refresh_token_enc, expires_at, scopes, installed_by_user_id, company_domain, company_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tid, ...conn, me.companyId],
      );
      await addOwner(db, tid, authUserId, me);
      return { tid, created: false, adopted: true, uid: authUserId };
    }

    // neuer Mandant: Slug aus der Pipedrive-Domain, bei Kollision mit Zähler
    let slug = base;
    for (let n = 2; ; n++) {
      const { rowCount } = await db.query("select 1 from public.tenants where slug = $1", [slug]);
      if (!rowCount) break;
      slug = `${base.slice(0, 58)}-${n}`;
    }
    const name = (me.companyName?.trim() || me.companyDomain).slice(0, 200);
    const { rows: tr } = await db.query<{ id: string }>(
      `insert into public.tenants (slug, name, anrede, sender_name, timezone) values ($1, $2, 'sie', $2, $3) returning id`,
      [slug, name, validTimezone(me.timezone)],
    );
    const tid = tr[0]!.id;
    await db.query(
      `insert into public.pipedrive_connections
         (tenant_id, api_domain, access_token_enc, refresh_token_enc, expires_at, scopes, installed_by_user_id, company_domain, company_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tid, ...conn, me.companyId],
    );
    await addOwner(db, tid, authUserId, me);
    return { tid, created: true, adopted: false, uid: authUserId };
  });

  if (!res.uid) {
    // weiterer Benutzer einer bereits verbundenen Firma: Anfrage an Owner/Admins
    await recordAccessRequest({ id: res.tid }, me.id, { name: me.name, email: me.email });
    return { ok: false, error: "no_access", created: res.created };
  }
  await storeUserTokens(getPool(), res.tid, res.uid, me, t);
  return { ok: true, created: res.created, adopted: res.adopted, session: { uid: res.uid, tid: res.tid, pd: me.id } };
}

/** Deinstallation (Pipedrive meldet sie an den Callback): deaktivieren, Daten behalten */
export async function uninstallCompany(companyId: number): Promise<boolean> {
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ tenant_id: string }>(
      `update public.pipedrive_connections set status = 'revoked', revoked_at = now()
        where company_id = $1 and status = 'active' returning tenant_id`,
      [companyId],
    );
    if (!rows[0]) return false;
    await db.query(
      "update public.pipedrive_user_connections set status = 'error', last_error = 'Pipedrive-App deinstalliert' where tenant_id = $1",
      [rows[0].tenant_id],
    );
    return true;
  });
}

/** Pipedrive-Domain der Firma aktuell halten (bei jedem Login; Domain kann sich in Pipedrive ändern) */
export async function syncCompanyDomain(companyId: number, domain: string): Promise<void> {
  await withActor({ role: "service_role" }, (db) => syncCompanyDomainOn(db, { companyId }, domain));
}
