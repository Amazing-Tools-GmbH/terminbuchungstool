/** Firmendaten & Rechtliches: owner/admin speichern, sales nicht; Formularzeilen -> Rechtslinks */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let settings: typeof import("@/lib/admin/settings");
let owner: AdminContext;
let sales: AdminContext;
let tenantId: string;

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  settings = await import("@/lib/admin/settings");
  tenantId = db.seed.find((s) => s.slug === "demo")!.tenantId;
  const m = await db.admin<{ user_id: string; role: string }>("select user_id, role::text as role from tenant_members where tenant_id = $1 and status = 'active'", [tenantId]);
  const tenant = { id: tenantId } as AdminContext["tenant"];
  const ctx = (userId: string, role: "owner" | "sales"): AdminContext => ({ tenant, userId, actor: { role: "authenticated", userId }, role, name: null, email: null });
  owner = ctx(m.find((x) => x.role === "owner")!.user_id, "owner");
  // sales anlegen (Demo hat evtl. keinen)
  const [u] = await db.admin<{ id: string }>("insert into auth.users (email) values ('sales-settings@x.example') returning id");
  await db.admin("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'sales')", [tenantId, u!.id]);
  sales = ctx(u!.id, "sales");
});
afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

const input = {
  name: "Demo GmbH",
  senderName: "Demo Termine",
  replyTo: "hallo@demo.example",
  anrede: "ihr" as const,
  contactLine: "Fragen? 0800 123",
  changeDeadlineHours: 24,
  retentionMonths: 6,
  legalLinks: [
    { label: "Impressum", href: "https://demo.example/impressum" },
    { label: "Datenschutz", href: "https://demo.example/datenschutz" },
  ],
};

describe("Einstellungen", () => {
  it("owner speichert, Werte kommen zurück", async () => {
    await settings.saveSettings(owner, input);
    expect(await settings.loadSettings(owner)).toEqual(input);
    const [t] = await db.admin<{ anrede: string }>("select anrede::text from tenants where id = $1", [tenantId]);
    expect(t!.anrede).toBe("ihr");
  });

  it("sales darf nicht", async () => {
    await expect(settings.saveSettings(sales, { ...input, name: "Hack" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("Formular: nur Zeilen mit Adresse; Prüfung der Links; fehlende Pflichtlinks", () => {
    const f = new FormData();
    f.set("legalLabel0", "Impressum");
    f.set("legalHref0", "https://x.example/i");
    f.set("legalLabel1", "Datenschutz");
    f.set("legalHref1", "");
    expect(settings.legalLinksFromForm(f)).toEqual([{ label: "Impressum", href: "https://x.example/i" }]);
    const bad = settings.settingsSchema.safeParse({ ...input, legalLinks: [{ label: "X", href: "javascript:alert(1)" }] });
    expect(bad.success).toBe(false);
    expect(settings.missingLegal([{ label: "Impressum" }])).toEqual(["datenschutz"]);
    expect(settings.missingLegal(input.legalLinks)).toEqual([]);
  });
});
