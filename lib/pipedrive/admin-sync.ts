import "server-only";
/**
 * Pipedrive-Admins werden automatisch Admin im Terminbuchungstool:
 *   - noch kein Mitglied  -> auth-Benutzer + Mitgliedschaft (admin, aktiv);
 *                            eine offene Zugriffsanfrage gilt als erledigt
 *   - Mitglied als sales  -> wird admin, außer ein Owner/Admin hat die Rolle von
 *                            Hand festgelegt (tenant_members.role_manual) – dann bleibt sie
 *   - owner/admin         -> bleibt
 *   - gesperrt            -> bleibt gesperrt (Entscheidung eines Owners/Admins)
 * Kein automatisches Herabstufen, wenn jemand in Pipedrive kein Admin mehr ist.
 * Aufruf bei Installation, Pipedrive-Login, Panel, App-Einstellungen, Einstieg
 * über /settings und beim Laden der Nutzerverwaltung. Läuft als service_role.
 */
import { withActor } from "@/lib/db";
import { ensureAuthUser } from "@/lib/auth/users";
import type { PipedriveUser } from "./client";
import { listPipedriveUsers } from "./directory";

type Member = { user_id: string; role: "owner" | "admin" | "sales"; status: "active" | "disabled"; role_manual: boolean };

/** Ergebnis: auth-Benutzer-ID, wenn er (jetzt) aktives Mitglied ist; sonst null */
export async function grantPipedriveAdmin(tenantId: string, user: PipedriveUser): Promise<string | null> {
  if (!user.isAdmin || !user.active) return null;
  const existing = await withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<Member>(
      "select user_id, role::text as role, status::text as status, role_manual from public.tenant_members where tenant_id = $1 and pipedrive_user_id = $2",
      [tenantId, user.id],
    );
    return rows[0] ?? null;
  });
  if (existing) {
    if (existing.status !== "active") return null;
    if (existing.role === "sales" && !existing.role_manual) {
      await withActor({ role: "service_role" }, (db) =>
        db.query("update public.tenant_members set role = 'admin' where tenant_id = $1 and user_id = $2 and role = 'sales' and not role_manual", [tenantId, existing.user_id]),
      );
    }
    return existing.user_id;
  }

  // auth-Benutzer außerhalb der Transaktion (Supabase Auth-Admin-API; ohne Mail)
  const userId = await ensureAuthUser(user.email, user.name);
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ status: string }>(
      `insert into public.tenant_members (tenant_id, user_id, role, status, pipedrive_user_id, display_name, email)
       values ($1, $2, 'admin', 'active', $3, $4, $5)
       on conflict (tenant_id, user_id) do update
         set pipedrive_user_id = excluded.pipedrive_user_id,
             role = case when public.tenant_members.role = 'owner' or public.tenant_members.role_manual
                         then public.tenant_members.role else 'admin'::public.member_role end,
             display_name = excluded.display_name, email = excluded.email
       returning status::text as status`,
      [tenantId, userId, user.id, user.name.slice(0, 200), user.email],
    );
    await db.query(
      `update public.access_requests set status = 'approved', decided_at = now()
        where tenant_id = $1 and pipedrive_user_id = $2 and status = 'open'`,
      [tenantId, user.id],
    );
    return rows[0]?.status === "active" ? userId : null;
  });
}

/** Nur die Pipedrive-ID bekannt (Panel, App-Einstellungen, /settings): Benutzer aus der Pipedrive-Benutzerliste */
export async function grantPipedriveAdminById(tenantId: string, pipedriveUserId: number): Promise<string | null> {
  try {
    const slug = await withActor({ role: "service_role" }, async (db) => {
      const { rows } = await db.query<{ slug: string }>("select slug from public.tenants where id = $1", [tenantId]);
      return rows[0]?.slug ?? "";
    });
    const dir = await listPipedriveUsers({ id: tenantId, slug });
    const user = dir.ok ? dir.users.find((u) => u.id === pipedriveUserId) : undefined;
    return user ? await grantPipedriveAdmin(tenantId, user) : null;
  } catch (err) {
    console.error("Pipedrive-Admin konnte nicht übernommen werden", err);
    return null;
  }
}

/** Alle aktiven Pipedrive-Admins übernehmen (beim Laden der Nutzerverwaltung) */
export async function syncPipedriveAdmins(tenantId: string, users: PipedriveUser[]): Promise<void> {
  for (const u of users) {
    if (!u.isAdmin || !u.active) continue;
    try {
      await grantPipedriveAdmin(tenantId, u);
    } catch (err) {
      console.error(`Pipedrive-Admin ${u.id} konnte nicht übernommen werden`, err);
    }
  }
}

/** E-Mail-Adressen der aktiven Owner (Hinweis „bitte wende dich an …“) */
export async function ownerContacts(tenantId: string): Promise<string[]> {
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ email: string }>(
      `select distinct lower(email) as email from public.tenant_members
        where tenant_id = $1 and role = 'owner' and status = 'active' and email is not null
        order by 1`,
      [tenantId],
    );
    return rows.map((r) => r.email);
  });
}
