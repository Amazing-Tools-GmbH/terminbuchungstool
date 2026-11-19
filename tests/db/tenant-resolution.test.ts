/** Zentrale Adressen: Mandant aus dem Buchungslink bzw. aus der Sitzung */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { setupTestDb, type TestDb } from "./helpers";

let db: TestDb;
let owners: Record<string, DbActor> = {};

beforeAll(async () => {
  db = await setupTestDb();
  const rows = await db.admin<{ slug: string; user_id: string }>(
    "select t.slug, m.user_id from tenant_members m join tenants t on t.id = m.tenant_id where m.role = 'owner'",
  );
  owners = Object.fromEntries(rows.map((r) => [r.slug, { role: "authenticated", userId: r.user_id } as DbActor]));
});
afterAll(() => db?.close());

const byToken = (actor: DbActor, token: string) =>
  db.as(actor, async (c) => (await c.query("select public.resolve_tenant_by_token($1) as t", [token])).rows[0].t);

describe("Mandant aus dem Buchungslink", () => {
  it("anon bekommt die öffentlichen Daten des richtigen Mandanten", async () => {
    for (const s of db.seed) {
      const t = await byToken(ANON, s.token);
      expect(t).toMatchObject({ id: s.tenantId, slug: s.slug });
      expect(Object.keys(t).sort()).toEqual(
        ["anrede", "change_deadline_hours", "claim", "contact_line", "custom_domain", "id", "legal_links", "logo_path", "name", "slug", "text_overrides", "theme", "timezone"].sort(),
      );
    }
  });

  it("unbekannter oder zu kurzer Token -> null", async () => {
    expect(await byToken(ANON, "x".repeat(43))).toBeNull();
    expect(await byToken(ANON, "kurz")).toBeNull();
  });
});

describe("Mandant aus der Sitzung", () => {
  it("nur Mitglieder lösen ihren Mandanten auf; anon gar nicht", async () => {
    const a = db.seed.find((s) => s.slug === "antennevorarlberg")!;
    const own = await db.as(owners.antennevorarlberg!, async (c) => (await c.query("select public.resolve_tenant_by_id($1) as t", [a.tenantId])).rows[0].t);
    expect(own).toMatchObject({ id: a.tenantId });
    const foreign = await db.as(owners.demo!, async (c) => (await c.query("select public.resolve_tenant_by_id($1) as t", [a.tenantId])).rows[0].t);
    expect(foreign).toBeNull();
    await expect(db.as(ANON, (c) => c.query("select public.resolve_tenant_by_id($1)", [a.tenantId]))).rejects.toThrow(/permission denied/);
  });
});
