import "server-only";
/**
 * Nutzerverwaltung: Benutzer der Pipedrive-Firma freischalten, sperren und
 * Rollen vergeben. Neue Pipedrive-Benutzer haben keinen Zugriff, bis sie
 * freigeschaltet werden. Wer was ändern darf, erzwingt RLS
 * (owner: alle; admin: alle außer owner; sales: nichts).
 */
import { withActor } from "@/lib/db";
import { ensureAuthUser } from "@/lib/auth/users";
import type { AdminContext, MemberRole } from "@/lib/auth/admin";
import { listPipedriveUsers } from "@/lib/pipedrive/directory";
import { AdminError, toAdminError } from "./errors";
import { closeAccessRequest, listOpenAccessRequests } from "@/lib/access-requests";
import { syncPipedriveAdmins } from "@/lib/pipedrive/admin-sync";

import { mergeTeam, type MemberRow, type Team } from "./team";

export type { MemberRow, Team, TeamEntry } from "./team";

async function listMembers(ctx: AdminContext): Promise<MemberRow[]> {
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{
      user_id: string;
      role: MemberRole;
      status: "active" | "disabled";
      pipedrive_user_id: string | null;
      display_name: string | null;
      email: string | null;
    }>(
      `select user_id, role, status::text as status, pipedrive_user_id::text, display_name, email
         from public.tenant_members where tenant_id = $1`,
      [ctx.tenant.id],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      status: r.status,
      pipedriveUserId: r.pipedrive_user_id ? Number(r.pipedrive_user_id) : null,
      name: r.display_name,
      email: r.email,
    }));
  });
}

export async function loadTeam(ctx: AdminContext): Promise<Team> {
  const dir = await listPipedriveUsers(ctx.tenant);
  // Admins in Pipedrive sind automatisch Admin (neue anlegen, sales anheben)
  if (dir.ok) await syncPipedriveAdmins(ctx.tenant.id, dir.users);
  const members = await listMembers(ctx);
  return {
    entries: mergeTeam(dir.ok ? dir.users : [], members, ctx.userId),
    directory: dir.ok ? "ok" : dir.reason,
    source: dir.ok ? dir.source : null,
  };
}

/** Pipedrive-Benutzer freischalten (bzw. wieder freischalten) */
export async function enableMember(ctx: AdminContext, pipedriveUserId: number, role: MemberRole): Promise<void> {
  try {
    const dir = await listPipedriveUsers(ctx.tenant);
    // Name und E-Mail kommen aus Pipedrive (bzw. aus der Zugriffsanfrage, die beim
    // Pipedrive-Login entstanden ist), nie aus dem Formular
    let user = dir.ok ? dir.users.find((u) => u.id === pipedriveUserId && u.active) : undefined;
    if (!user) {
      const req = (await listOpenAccessRequests(ctx)).find((r) => r.pipedriveUserId === pipedriveUserId && r.email && r.name);
      if (req) user = { id: pipedriveUserId, name: req.name!, email: req.email!, isAdmin: false, active: true };
    }
    if (!user) throw new AdminError(dir.ok ? "pipedrive_user_not_found" : "pipedrive_unavailable");

    const existing = (await listMembers(ctx)).find((m) => m.pipedriveUserId === pipedriveUserId);
    if (existing) {
      if (existing.userId === ctx.userId) throw new AdminError("self");
      await updateMember(ctx, existing.userId, { role, status: "active" });
      await closeAccessRequest(ctx, pipedriveUserId, true).catch(() => false);
      return;
    }
    const userId = await ensureAuthUser(user.email, user.name);
    await withActor(ctx.actor, async (db) => {
      await db.query(
        `insert into public.tenant_members (tenant_id, user_id, role, status, pipedrive_user_id, display_name, email)
         values ($1, $2, $3, 'active', $4, $5, $6)`,
        [ctx.tenant.id, userId, role, pipedriveUserId, user.name.slice(0, 200), user.email],
      );
    });
    // offene Zugriffsanfrage erledigt -> Mail „freigeschaltet“ an den Benutzer
    await closeAccessRequest(ctx, pipedriveUserId, true).catch(() => false);
  } catch (err) {
    // 23505: dieser auth-Benutzer ist bereits Mitglied (unter anderer Pipedrive-ID)
    if ((err as { code?: string })?.code === "23505") throw new AdminError("already_member");
    throw toAdminError(err);
  }
}

/** Rolle ändern und/oder sperren/entsperren */
export async function updateMember(
  ctx: AdminContext,
  userId: string,
  change: { role?: MemberRole; status?: "active" | "disabled" },
): Promise<void> {
  if (userId === ctx.userId) throw new AdminError("self"); // sich nicht selbst aussperren/herabstufen
  try {
    await withActor(ctx.actor, async (db) => {
      const res = await db.query(
        `update public.tenant_members
            set role = coalesce($3::public.member_role, role),
                status = coalesce($4::public.member_status, status)
          where tenant_id = $1 and user_id = $2`,
        [ctx.tenant.id, userId, change.role ?? null, change.status ?? null],
      );
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}
