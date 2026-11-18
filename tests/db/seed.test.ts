/**
 * Seed-Ziele: "local" (pg-Client) und "supabase" (ein SQL-Skript mit
 * Literalen über die Management API). Der Supabase-Plan wird hier gegen die
 * LOKALE Testdatenbank ausgeführt – so ist geprüft, dass das gerenderte Skript
 * gültig ist, ohne Supabase anzufassen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planTenant, parseTarget } from "@/scripts/seed";
import { inlineParams } from "@/scripts/supabase/api";
import { SEED_TENANTS } from "@/seed/tenants";
import { setupTestDb, type TestDb } from "./helpers";

let db: TestDb;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(() => db?.close());

const asScript = (plans: ReturnType<typeof planTenant>[]) =>
  plans.flatMap((p) => p.statements.map((s) => inlineParams(s.sql, s.params) + ";")).join("\n");

describe("Seed", () => {
  it("lokaler Seed legt Admin-Mitglieder an", async () => {
    const rows = await db.admin<{ n: number }>("select count(*)::int as n from tenant_members");
    expect(rows[0]!.n).toBe(SEED_TENANTS.length);
  });

  it("Supabase-Plan läuft als ein Skript, ohne auth.users anzufassen", async () => {
    const plans = SEED_TENANTS.map((t) => planTenant(t, "supabase"));
    const script = asScript(plans);
    expect(script).not.toMatch(/auth\.users|tenant_members/);

    const usersBefore = await db.admin<{ n: number }>("select count(*)::int as n from auth.users");
    await db.pool.query(script); // einfache Abfrage, wie über die Management API

    const tenants = await db.admin<{ id: string; slug: string; logo_path: string | null }>(
      "select id, slug, logo_path from tenants order by slug",
    );
    expect(tenants.map((t) => t.id).sort()).toEqual(plans.map((p) => p.invitation.tenantId).sort());
    expect(tenants.find((t) => t.slug === "antennevorarlberg")!.logo_path).toMatch(/^[0-9a-f-]{36}\/logo\.svg$/);
    expect((await db.admin<{ n: number }>("select count(*)::int as n from tenant_members"))[0]!.n).toBe(0);
    expect((await db.admin<{ n: number }>("select count(*)::int as n from auth.users"))[0]!.n).toBe(usersBefore[0]!.n);

    // Belegung kam über book_slot zustande, Outbox ist leer
    const booked = await db.admin<{ n: number }>("select coalesce(sum(seats), 0)::int as n from bookings where status = 'confirmed'");
    const expected = SEED_TENANTS.flatMap((t) => t.event.slots).reduce((a, s) => a + s.booked, 0);
    expect(booked[0]!.n).toBe(expected);
    expect((await db.admin<{ n: number }>("select count(*)::int as n from email_outbox"))[0]!.n).toBe(0);

    // Test-Einladung ist über get_invitation_context erreichbar
    const inv = plans[0]!.invitation;
    const ctx = await db.admin<{ c: unknown }>("select public.get_invitation_context($1, $2) as c", [inv.tenantId, inv.token]);
    expect(ctx[0]!.c).toBeTruthy();
  });

  it("Skript ist atomar: scheitert eine Anweisung, bleibt nichts zurück", async () => {
    const before = await db.admin<{ id: string }>("select id from tenants order by id");
    const script = asScript([planTenant(SEED_TENANTS[0]!, "supabase")]) + "\nselect 1/0;";
    await expect(db.pool.query(script)).rejects.toThrow();
    expect(await db.admin<{ id: string }>("select id from tenants order by id")).toEqual(before);
  });

  it("Ziel muss explizit angegeben werden", () => {
    expect(parseTarget(["--target=local"])).toBe("local");
    expect(parseTarget(["--target=supabase"])).toBe("supabase");
    expect(() => parseTarget([])).toThrow(/--target/);
    expect(() => parseTarget(["--target=prod"])).toThrow();
  });
});
