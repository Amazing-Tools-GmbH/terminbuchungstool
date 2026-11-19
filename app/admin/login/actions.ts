"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import { startSession } from "@/lib/auth/admin";

/**
 * Entwicklung: Anmelden als freigeschaltetes Mitglied eines Mandanten ohne
 * Pipedrive. Nur mit DEV_TOOLS_ENABLED (nie in Produktion).
 */
export async function devLoginAction(form: FormData) {
  if (!devToolsEnabled()) redirect("/admin/login");
  const input = z.object({ userId: z.string().uuid(), tenantId: z.string().uuid() }).safeParse(Object.fromEntries(form));
  if (!input.success) redirect("/admin/login");

  const active = await withActor({ role: "service_role" }, async (db) => {
    const { rowCount } = await db.query(
      "select 1 from public.tenant_members where tenant_id = $1 and user_id = $2 and status = 'active'",
      [input.data.tenantId, input.data.userId],
    );
    return rowCount === 1;
  });
  if (!active) redirect("/admin/login?error=no_access");
  await startSession({ uid: input.data.userId, tid: input.data.tenantId, pd: null });
  redirect("/admin");
}
