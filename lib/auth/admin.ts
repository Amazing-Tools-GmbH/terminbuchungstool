import "server-only";
/**
 * Angemeldeter Benutzer des Admin-Backends (Server-Komponenten, Actions).
 * Das Admin-Backend liegt zentral unter APP_BASE_URL; der Mandant steht in
 * der Sitzung. Mitgliedschaft und Rolle werden bei JEDEM Request frisch aus
 * der DB gelesen (als der Benutzer selbst, RLS) – Sperren oder Rollenwechsel
 * wirken sofort.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withActor, type DbActor } from "@/lib/db";
import { tenantForMember } from "@/lib/tenant/current";
import type { PublicTenant } from "@/lib/tenant/types";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, seal, sessionSchema, unseal, type Session } from "./session";

import type { MemberRole } from "./roles";

export { canManage, type MemberRole } from "./roles";

export type AdminContext = {
  tenant: PublicTenant;
  userId: string;
  actor: DbActor;
  role: MemberRole;
  name: string | null;
  email: string | null;
};

export function secureCookies(env: Record<string, string | undefined> = process.env): boolean {
  return (env.APP_BASE_URL ?? "").startsWith("https://");
}

export const getAdminContext = cache(async (): Promise<AdminContext | null> => {
  const session = unseal("session", (await cookies()).get(SESSION_COOKIE)?.value, sessionSchema);
  if (!session) return null;
  // Mandant aus der Sitzung (zentrale Adresse, keine Subdomain); nur für Mitglieder auflösbar
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
  if (!member) return null; // gesperrt oder entfernt -> RLS liefert nichts
  return { tenant, userId: session.uid, actor, role: member.role, name: member.display_name, email: member.email };
});

/** Für Seiten und Actions: angemeldet (optional mit Mindestrolle), sonst Login bzw. Startseite */
export async function requireAdmin(roles?: MemberRole[]): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/admin/login");
  if (roles && !roles.includes(ctx.role)) redirect("/admin?error=forbidden");
  return ctx;
}

/** Name, Wert und Optionen des Sitzungs-Cookies (für cookies().set bzw. response.cookies.set) */
export function sessionCookie(session: Session) {
  return {
    name: SESSION_COOKIE,
    value: seal("session", session, SESSION_TTL_SECONDS),
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** In Server Actions */
export async function startSession(session: Session): Promise<void> {
  (await cookies()).set(sessionCookie(session));
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
