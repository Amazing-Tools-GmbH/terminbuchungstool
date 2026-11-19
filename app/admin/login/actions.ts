"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import { getCurrentTenant } from "@/lib/tenant/current";
import { startSession } from "@/lib/auth/admin";

/**
 * Entwicklung: Anmelden als freigeschaltetes Mitglied ohne Pipedrive.
 * Nur mit DEV_TOOLS_ENABLED (nie in Produktion).
 */
export async function devLoginAction(form: FormData) {
  if (!devToolsEnabled()) redirect("/admin/login");
  const tenant = await getCurrentTenant();
  const userId = z.string().uuid().safeParse(form.get("userId"));
  if (!tenant || !userId.success) redirect("/admin/login");

  const active = await withActor({ role: "service_role" }, async (db) => {
    const { rowCount } = await db.query(
      "select 1 from public.tenant_members where tenant_id = $1 and user_id = $2 and status = 'active'",
      [tenant.id, userId.data],
    );
    return rowCount === 1;
  });
  if (!active) redirect("/admin/login?error=no_access");
  await startSession({ uid: userId.data, tid: tenant.id, pd: null });
  redirect("/admin");
}
