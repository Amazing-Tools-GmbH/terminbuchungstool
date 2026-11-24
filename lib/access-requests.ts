import "server-only";
/**
 * Zugriffsanfragen: Wer die App nutzen will, aber (noch) nicht freigeschaltet
 * ist, wird nicht nur abgewiesen – die Anfrage wird festgehalten und alle
 * Owner/Admins bekommen eine Mail (public.record_access_request, Outbox).
 * Fehler hier dürfen den eigentlichen Ablauf nie stören.
 */
import { withActor } from "@/lib/db";
import { listPipedriveUsers } from "@/lib/pipedrive/directory";
import type { AdminContext } from "@/lib/auth/admin";
import { sendMailsSoon } from "@/lib/booking/api";

export async function recordAccessRequest(
  tenant: { id: string; slug?: string },
  pipedriveUserId: number,
  known: { name?: string | null; email?: string | null } = {},
): Promise<boolean> {
  try {
    let { name, email } = known;
    if (!name || !email) {
      // Name/E-Mail aus Pipedrive (braucht users:read); sonst nur die ID
      const slug = tenant.slug ?? (await slugOf(tenant.id));
      const dir = await listPipedriveUsers({ id: tenant.id, slug }).catch(() => null);
      const u = dir?.ok ? dir.users.find((x) => x.id === pipedriveUserId) : undefined;
      name = name ?? u?.name ?? null;
      email = email ?? u?.email ?? null;
    }
    const created = await withActor({ role: "service_role" }, async (db) => {
      const { rows } = await db.query<{ created: boolean }>("select public.record_access_request($1, $2, $3, $4) as created", [
        tenant.id,
        pipedriveUserId,
        name ?? null,
        email ?? null,
      ]);
      return rows[0]?.created ?? false;
    });
    if (created) {
      try {
        sendMailsSoon(tenant.id);
      } catch {
        // außerhalb eines Requests (Tests): Cron verschickt
      }
    }
    return created;
  } catch (err) {
    console.error("Zugriffsanfrage konnte nicht gespeichert werden", err);
    return false;
  }
}

async function slugOf(tenantId: string): Promise<string> {
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ slug: string }>("select slug from public.tenants where id = $1", [tenantId]);
    return rows[0]?.slug ?? "";
  });
}

export type AccessRequest = { id: string; pipedriveUserId: number; name: string | null; email: string | null; createdAt: Date };

/** Offene Anfragen (owner/admin; RLS) */
export async function listOpenAccessRequests(ctx: AdminContext): Promise<AccessRequest[]> {
  if (ctx.role === "sales") return [];
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{ id: string; pipedrive_user_id: string; name: string | null; email: string | null; created_at: Date }>(
      `select id, pipedrive_user_id::text, name, email, created_at from public.access_requests
        where tenant_id = $1 and status = 'open' order by created_at`,
      [ctx.tenant.id],
    );
    return rows.map((r) => ({ id: r.id, pipedriveUserId: Number(r.pipedrive_user_id), name: r.name, email: r.email, createdAt: r.created_at }));
  });
}

/** Anfrage abschließen (beim Freischalten automatisch; Ablehnen per Knopf) */
export async function closeAccessRequest(ctx: AdminContext, pipedriveUserId: number, approved: boolean): Promise<boolean> {
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{ ok: boolean }>("select public.close_access_request($1, $2, $3) as ok", [ctx.tenant.id, pipedriveUserId, approved]);
    return rows[0]?.ok ?? false;
  });
}
