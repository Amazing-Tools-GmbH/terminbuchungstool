/**
 * Admin: Veranstaltung samt erstem Termin in einer Transaktion anlegen.
 * Läuft über den App-Pool -> zeigt ausdrücklich auf die lokale Testdatenbank.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let slots: typeof import("@/lib/admin/slots");
let owner: AdminContext;
let sales: AdminContext;

const future = () => {
  const d = new Date(Date.now() + 30 * 86_400_000);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  slots = await import("@/lib/admin/slots");
  const a = db.seed.find((s) => s.slug === "antennevorarlberg")!;
  const m = await db.admin<{ user_id: string; role: "owner" | "admin" | "sales" }>(
    "select user_id, role::text as role from tenant_members where tenant_id = $1 and status = 'active'",
    [a.tenantId],
  );
  const tenant = { id: a.tenantId, timezone: "Europe/Vienna" } as AdminContext["tenant"];
  const ctx = (role: "owner" | "sales"): AdminContext => {
    const userId = m.find((x) => x.role === role)!.user_id;
    return { tenant, userId, actor: { role: "authenticated", userId }, role, name: null, email: null };
  };
  owner = ctx("owner");
  sales = ctx("sales");
});

afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

const input = (over: Partial<Parameters<typeof slots.createEvent>[1]> = {}) => ({
  title: "Test Event",
  location: "Würzburg",
  description: null,
  date: future(),
  from: "10:00",
  to: "12:00",
  capacity: 8,
  ...over,
});

describe("Veranstaltung mit erstem Termin", () => {
  it("legt Veranstaltung und offenen, buchbaren Termin an (Zeit in der Mandanten-Zeitzone)", async () => {
    const r = await slots.createEvent(owner, input());
    const [e] = await db.admin<{ title: string; status: string; location: string }>("select title, status::text, location from events where id = $1", [r.eventId]);
    expect(e).toEqual({ title: "Test Event", status: "published", location: "Würzburg" });
    const [s] = await db.admin<{ event_id: string; capacity: number; status: string; location: string | null; local: string }>(
      `select event_id, capacity, status::text, location, to_char(starts_at at time zone 'Europe/Vienna', 'HH24:MI') as local from slots where id = $1`,
      [r.slotId],
    );
    expect(s).toEqual({ event_id: r.eventId, capacity: 8, status: "open", location: null, local: "10:00" });
  });

  it("Termin in der Vergangenheit: nichts wird angelegt (auch keine Veranstaltung)", async () => {
    const before = await db.admin<{ n: string }>("select count(*)::text as n from events where title = 'Vergangen'");
    await expect(slots.createEvent(owner, input({ title: "Vergangen", date: "2020-01-01" }))).rejects.toMatchObject({ code: "slot_in_past" });
    const after = await db.admin<{ n: string }>("select count(*)::text as n from events where title = 'Vergangen'");
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("Vertrieb darf keine Veranstaltung anlegen (RLS)", async () => {
    await expect(slots.createEvent(sales, input({ title: "Verboten" }))).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("Teilnehmeranzahl ändern", () => {
  const bookedSlot = async () =>
    (
      await db.admin<{ id: string; capacity: number; booked: number }>(
        `select s.id, s.capacity, coalesce(sum(b.seats), 0)::int as booked
           from slots s join bookings b on b.slot_id = s.id and b.status = 'confirmed'
          where s.tenant_id = $1 group by s.id order by booked desc limit 1`,
        [owner.tenant.id],
      )
    )[0]!;

  it("setzt die Zahl direkt (auch verringern bis zur gebuchten Anzahl)", async () => {
    const s = await bookedSlot();
    await slots.setCapacity(owner, s.id, s.capacity + 5);
    await slots.setCapacity(owner, s.id, s.booked);
    const [r] = await db.admin<{ capacity: number }>("select capacity from slots where id = $1", [s.id]);
    expect(r!.capacity).toBe(s.booked);
    await slots.setCapacity(owner, s.id, s.capacity);
  });

  it("nicht unter die gebuchten Plätze", async () => {
    const s = await bookedSlot();
    await expect(slots.setCapacity(owner, s.id, s.booked - 1)).rejects.toMatchObject({ code: "capacity_below_booked" });
  });

  it("Vertrieb darf nicht ändern (RLS)", async () => {
    const s = await bookedSlot();
    await expect(slots.setCapacity(sales, s.id, s.capacity + 1)).rejects.toMatchObject({ code: "forbidden" });
  });
});
