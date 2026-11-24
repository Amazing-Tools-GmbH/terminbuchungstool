import "server-only";
/**
 * Eingebettete App-Einstellungen in Pipedrive (Custom UI „App settings“):
 * Pipedrive lädt <APP_BASE_URL>/app-settings?userId&companyId&token&id&theme
 * im iframe. Kein Cookie (Drittanbieter-iframe), sondern eine versiegelte
 * Sitzung (Zweck "app-settings") als Bearer – wie beim Panel. Rolle wird bei
 * jedem Aufruf frisch gelesen; verwalten dürfen nur owner/admin (RLS).
 */
import { headers } from "next/headers";
import { withActor, type DbActor } from "@/lib/db";
import { APP_SETTINGS_TTL_SECONDS, seal, sessionSchema, unseal, type Session } from "@/lib/auth/session";
import type { AdminContext, MemberRole } from "@/lib/auth/admin";
import { tenantForMember } from "@/lib/tenant/current";
import { tenantIdForPipedriveCompany } from "@/lib/pipedrive/runtime";
import type { SettingsIdentity } from "@/lib/pipedrive/settings-token";
import { recordAccessRequest } from "@/lib/access-requests";

export type AppSettingsStart =
  | { ok: true; ctx: AdminContext; bearer: string }
  | { ok: false; error: "not_connected" | "access_requested" | "disabled" | "sales" };

async function contextFor(session: Session): Promise<AdminContext | null> {
  const tenant = await tenantForMember(session.uid, session.tid);
  if (!tenant) return null;
  const actor: DbActor = { role: "authenticated", userId: session.uid };
  const member = await withActor(actor, async (db) => {
    const { rows } = await db.query<{ role: MemberRole; display_name: string | null; email: string | null }>(
      "select role, display_name, email from public.tenant_members where tenant_id = $1 and user_id = $2",
      [tenant.id, session.uid],
    );
    return rows[0] ?? null;
  });
  if (!member) return null;
  return { tenant, userId: session.uid, actor, role: member.role, name: member.display_name, email: member.email };
}

/** Einstieg aus Pipedrive (geprüftes Token): Sitzung für owner/admin, sonst Grund */
export async function startAppSettings(identity: SettingsIdentity): Promise<AppSettingsStart> {
  const tid = await tenantIdForPipedriveCompany(identity.companyId);
  if (!tid) return { ok: false, error: "not_connected" };
  const member = await withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ user_id: string; status: "active" | "disabled" }>(
      "select user_id, status from public.member_login_lookup($1, $2)",
      [tid, identity.userId],
    );
    return rows[0] ?? null;
  });
  if (!member) {
    await recordAccessRequest({ id: tid }, identity.userId);
    return { ok: false, error: "access_requested" };
  }
  if (member.status !== "active") return { ok: false, error: "disabled" };
  const session: Session = { uid: member.user_id, tid, pd: identity.userId };
  const ctx = await contextFor(session);
  if (!ctx) return { ok: false, error: "disabled" };
  if (ctx.role === "sales") return { ok: false, error: "sales" };
  return { ok: true, ctx, bearer: seal("app-settings", session, APP_SETTINGS_TTL_SECONDS) };
}

/** API der eingebetteten Einstellungen: Bearer prüfen, nur owner/admin */
export async function appSettingsAuth(): Promise<AdminContext | null> {
  const h = (await headers()).get("authorization") ?? "";
  const s = unseal("app-settings", h.startsWith("Bearer ") ? h.slice(7) : null, sessionSchema);
  if (!s) return null;
  const ctx = await contextFor(s);
  return ctx && ctx.role !== "sales" ? ctx : null;
}
