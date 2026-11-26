/** Admin → Buchungen: Liste, Ansichten und „Gebucht von“ (booked_by per Trigger) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let bookings: typeof import("@/lib/admin/bookings");
let sales: AdminContext;
let tenantId: string;
let eventId: string;
let slotId: string;

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  bookings = await import("@/lib/admin/bookings");
  const a = db.seed.find((s) => s.slug === "antennevorarlberg")!;
  tenantId = a.tenantId;
  const [m] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 and role = 'sales' and status = 'active'", [tenantId]);
  const tenant = { id: tenantId, timezone: "Europe/Vienna" } as AdminContext["tenant"];
  sales = { tenant, userId: m!.user_id, actor: { role: "authenticated", userId: m!.user_id }, role: "sales", name: null, email: null };
  await db.admin("update tenant_members set display_name = 'Vera Vertrieb' where user_id = $1", [m!.user_id]);
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantId])) as [{ id: string }];
  [{ id: slotId }] = (await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + interval '40 days', now() + interval '40 days 2 hours', 50) returning id`,
    [tenantId, eventId],
  )) as [{ id: string }];
});

afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

describe("Buchungsliste", () => {
  it("unterscheidet Direktbuchung (Team) und Kundenbuchung", async () => {
    // Kunde bucht selbst über seinen Link
    const token = generateToken();
    await db.admin(
      `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at)
       values ($1, $2, $3, 'Karl Kunde', 'karl@kunde.example', now() + interval '30 days')`,
      [tenantId, eventId, hashToken(token)],
    );
    await db.as(ANON, (c) => c.query("select public.book_slot_once($1, $2, $3, 2, 'Karl Kunde', 'karl@kunde.example')", [tenantId, token, slotId]));
    // Vertrieb bucht direkt im Deal
    const t2 = generateToken();
    await db.as(sales.actor, (c) =>
      c.query("select public.book_for_deal($1, $2, $3, $4, 'Dora Deal', 'dora@kunde.example', 'Deal GmbH', 4242, 1, 3)", [
        tenantId,
        slotId,
        t2,
        encryptSecret(`https://x.example/b/${t2}`),
      ]),
    );

    const { items } = await bookings.listBookings(sales, { view: "upcoming", eventId });
    const karl = items.find((b) => b.email === "karl@kunde.example")!;
    const dora = items.find((b) => b.email === "dora@kunde.example")!;
    expect(karl).toMatchObject({ seats: 2, bookedBy: null, customer: "Karl Kunde", eventTitle: "Kunden-Workshop Radiowerbung" });
    expect(dora).toMatchObject({ seats: 3, bookedBy: "Vera Vertrieb", organization: "Deal GmbH" });

    // in der DB steht der Mitarbeiter (aus dem JWT, nicht aus der Eingabe)
    const [b] = await db.admin<{ booked_by: string | null }>("select booked_by from bookings where email = 'dora@kunde.example'");
    expect(b!.booked_by).toBe(sales.userId);
  });

  it("Ansichten: storniert (ohne Umbuchungen), vergangen", async () => {
    await db.admin("update bookings set status = 'cancelled', cancelled_at = now() where email = 'karl@kunde.example'");
    const cancelled = await bookings.listBookings(sales, { view: "cancelled", eventId });
    expect(cancelled.items.map((b) => b.email)).toContain("karl@kunde.example");
    const upcoming = await bookings.listBookings(sales, { view: "upcoming", eventId });
    expect(upcoming.items.map((b) => b.email)).not.toContain("karl@kunde.example");
    const past = await bookings.listBookings(sales, { view: "past" });
    expect(past.items.every((b) => b.email !== "dora@kunde.example")).toBe(true);
  });

  it("booked_by lässt sich nicht von außen setzen", async () => {
    const token = generateToken();
    await db.admin(
      `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at)
       values ($1, $2, $3, 'Anna Anon', 'anna@kunde.example', now() + interval '30 days')`,
      [tenantId, eventId, hashToken(token)],
    );
    await db.as(ANON, (c) => c.query("select public.book_slot_once($1, $2, $3, 1, 'Anna Anon', 'anna@kunde.example')", [tenantId, token, slotId]));
    const [b] = await db.admin<{ booked_by: string | null }>("select booked_by from bookings where email = 'anna@kunde.example'");
    expect(b!.booked_by).toBeNull();
  });
});
