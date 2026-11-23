/** E-Mail-Vorlagen speichern: nur owner/admin, andere Anpassungen bleiben */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let store: typeof import("@/lib/admin/mail-templates-store");
let owner: AdminContext;
let sales: AdminContext;
let tenantId: string;

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  store = await import("@/lib/admin/mail-templates-store");
  tenantId = db.seed.find((s) => s.slug === "antennevorarlberg")!.tenantId;
  const m = await db.admin<{ user_id: string; role: "owner" | "sales" }>(
    "select user_id, role::text as role from tenant_members where tenant_id = $1 and status = 'active'",
    [tenantId],
  );
  const tenant = { id: tenantId } as AdminContext["tenant"];
  const ctx = (role: "owner" | "sales"): AdminContext => {
    const userId = m.find((x) => x.role === role)!.user_id;
    return { tenant, userId, actor: { role: "authenticated", userId }, role, name: null, email: null };
  };
  owner = ctx("owner");
  sales = ctx("sales");
  await db.admin(`update tenants set text_overrides = '{"hero.intro": "Eigener Text"}' where id = $1`, [tenantId]);
});

afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

const overrides = async () => (await db.admin<{ text_overrides: Record<string, string> }>("select text_overrides from tenants where id = $1", [tenantId]))[0]!.text_overrides;

describe("E-Mail-Vorlagen", () => {
  it("owner speichert, andere Texte bleiben erhalten", async () => {
    await store.saveMailTemplates(owner, { "mail.regards": "Herzliche Grüße", "mail.greeting": "" });
    expect(await overrides()).toEqual({ "hero.intro": "Eigener Text", "mail.regards": "Herzliche Grüße" });
  });

  it("ungültige Platzhalter werden abgelehnt, sales darf nicht", async () => {
    await expect(store.saveMailTemplates(owner, { "mail.greeting": "Hallo {vorname}" })).rejects.toMatchObject({ code: "template_invalid" });
    await expect(store.saveMailTemplates(sales, { "mail.regards": "x" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await overrides())["mail.regards"]).toBe("Herzliche Grüße");
  });
});
