import "server-only";
/** E-Mail-Vorlagen speichern (tenants.text_overrides; RLS: nur owner/admin) */
import { withActor } from "@/lib/db";
import { parseTextOverrides } from "@/lib/texts";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError, toAdminError } from "./errors";
import { mergeMailOverrides } from "./mail-templates";

export async function saveMailTemplates(ctx: AdminContext, input: Partial<Record<string, string>>): Promise<void> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  try {
    await withActor(ctx.actor, async (db) => {
      const { rows } = await db.query<{ text_overrides: unknown; anrede: "sie" | "ihr" }>(
        "select text_overrides, anrede from public.tenants where id = $1 for update",
        [ctx.tenant.id],
      );
      if (!rows[0]) throw new AdminError("forbidden");
      const merged = mergeMailOverrides(parseTextOverrides(rows[0].text_overrides), input, rows[0].anrede);
      if (!merged.ok) throw new AdminError("template_invalid");
      const res = await db.query("update public.tenants set text_overrides = $2::jsonb where id = $1", [ctx.tenant.id, JSON.stringify(merged.overrides)]);
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}
