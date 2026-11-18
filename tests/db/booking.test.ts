/**
 * Buchungsfunktionen: get_invitation_context, book_slot, cancel_booking
 * – inkl. Überbuchungsschutz bei parallelen Buchungen auf den letzten Platz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { setupTestDb, tbCode, type TestDb } from "./helpers";

let db: TestDb;
let tenantId: string;
let otherTenantId: string;
let eventId: string;

beforeAll(async () => {
  db = await setupTestDb();
  tenantId = db.seed.find((s) => s.slug === "antenne-vorarlberg")!.tenantId;
  otherTenantId = db.seed.find((s) => s.slug === "demo")!.tenantId;
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantId])) as [{ id: string }];
});
afterAll(() => db?.close());

async function newInvitation(opts: { expiresIn?: string; allowed?: string[] | null; tenant?: string; event?: string } = {}) {
  const token = generateToken();
  await db.admin(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at, allowed_slot_ids)
     values ($1, $2, $3, 'Test Kunde', 'test@kunde.example', now() + $4::interval, $5)`,
    [opts.tenant ?? tenantId, opts.event ?? eventId, hashToken(token), opts.expiresIn ?? "30 days", opts.allowed ?? null],
  );
  return token;
}

async function newSlot(opts: { capacity: number; startsIn?: string }) {
  const [s] = await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + $3::interval, now() + $3::interval + interval '2 hours', $4) returning id`,
    [tenantId, eventId, opts.startsIn ?? "10 days", opts.capacity],
  );
  return s!.id;
}

function book(token: string, slotId: string, seats = 1, extra: string[] = [], tenant = tenantId) {
  return db.as(ANON, async (c) => {
    const { rows } = await c.query("select public.book_slot($1, $2, $3, $4, 'Test Kunde', 'Test@Kunde.example', $5) as r", [
      tenant,
      token,
      slotId,
      seats,
      extra,
    ]);
    return rows[0].r as { booking_id: string; replaced_booking_id: string | null };
  });
}

function context(token: string, tenant = tenantId) {
  return db.as(ANON, async (c) => (await c.query("select public.get_invitation_context($1, $2) as r", [tenant, token])).rows[0].r);
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `erwarteter Fehler ${code}`).not.toBeNull();
  expect(tbCode(err)).toBe(code);
}

describe("get_invitation_context", () => {
  it("liefert Einladung, Veranstaltung und Termine mit Belegung (Seed)", async () => {
    const token = db.seed.find((s) => s.slug === "antenne-vorarlberg")!.token;
    const ctx = await context(token);
    expect(ctx.invitation).toMatchObject({ name: "Maria Muster", expired: false });
    expect(ctx.event.title).toBe("Kunden-Workshop Radiowerbung");
    expect(ctx.slots).toHaveLength(5);
    const frees = ctx.slots.map((s: { free: number }) => s.free);
    expect(frees).toEqual([1, 0, 6, 13, 12]);
    expect(ctx.slots[1].bookable).toBe(false);
    expect(ctx.booking).toBeNull();
  });

  it("unbekanntes Token, falscher Mandant oder widerrufene Einladung -> null", async () => {
    const token = await newInvitation();
    expect(await context(generateToken())).toBeNull();
    expect(await context(token, otherTenantId)).toBeNull();
    await db.admin("update invitations set status = 'revoked' where token_hash = $1", [hashToken(token)]);
    expect(await context(token)).toBeNull();
  });

  it("zeigt nur erlaubte Termine, wenn allowed_slot_ids gesetzt ist", async () => {
    const slotId = await newSlot({ capacity: 5 });
    const token = await newInvitation({ allowed: [slotId] });
    const ctx = await context(token);
    expect(ctx.slots.map((s: { id: string }) => s.id)).toEqual([slotId]);
  });
});

describe("book_slot", () => {
  let slotId: string;
  beforeEach(async () => {
    slotId = await newSlot({ capacity: 5 });
  });

  it("bucht, setzt Status und legt Bestätigung in die Outbox", async () => {
    const token = await newInvitation();
    const r = await book(token, slotId, 3, ["Max Beispiel", "  ", "Eva Probe"]);
    const [b] = await db.admin<{ seats: number; email: string; extra_attendees: string[] }>("select * from bookings where id = $1", [r.booking_id]);
    expect(b).toMatchObject({ seats: 3, email: "test@kunde.example", extra_attendees: ["Max Beispiel", "Eva Probe"] });
    const [inv] = await db.admin<{ status: string }>("select status from invitations where token_hash = $1", [hashToken(token)]);
    expect(inv!.status).toBe("booked");
    const mails = await db.admin("select * from email_outbox where payload->>'booking_id' = $1", [r.booking_id]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ type: "confirmation", status: "queued", to_email: "test@kunde.example" });
  });

  it("verweigert mehr Plätze als frei", async () => {
    await book(await newInvitation(), slotId, 4);
    await expectCode(book(await newInvitation(), slotId, 2), "not_enough_seats");
  });

  it("prüft Eingaben", async () => {
    const token = await newInvitation();
    await expectCode(book(token, slotId, 0), "invalid_seats");
    await expectCode(book(token, slotId, 1, ["Zu", "Viele"]), "invalid_attendees");
  });

  it("verweigert abgelaufene Einladungen, fremde Mandanten und nicht erlaubte Termine", async () => {
    await expectCode(book(await newInvitation({ expiresIn: "-1 minute" }), slotId), "invitation_expired");
    await expectCode(book(await newInvitation(), slotId, 1, [], otherTenantId), "invitation_not_found");
    const other = await newSlot({ capacity: 5 });
    await expectCode(book(await newInvitation({ allowed: [other] }), slotId), "slot_not_allowed");
  });

  it("verweigert Termine einer anderen Veranstaltung/eines anderen Mandanten", async () => {
    const [foreignSlot] = await db.admin<{ id: string }>("select id from slots where tenant_id = $1 limit 1", [otherTenantId]);
    await expectCode(book(await newInvitation(), foreignSlot!.id), "slot_not_allowed");
  });

  it("verweigert vergangene oder geschlossene Termine", async () => {
    const past = await newSlot({ capacity: 5, startsIn: "-1 hour" });
    await expectCode(book(await newInvitation(), past), "slot_not_available");
    await db.admin("update slots set status = 'closed' where id = $1", [slotId]);
    await expectCode(book(await newInvitation(), slotId), "slot_not_available");
  });

  it("Umbuchen ersetzt die alte Buchung (auch auf demselben Termin mit mehr Plätzen)", async () => {
    const token = await newInvitation();
    const first = await book(token, slotId, 5); // Slot jetzt voll
    const second = await book(token, slotId, 5); // eigene Plätze zählen nicht gegen
    expect(second.replaced_booking_id).toBe(first.booking_id);
    const other = await newSlot({ capacity: 3 });
    const third = await book(token, other, 2);
    const rows = await db.admin<{ id: string; status: string; replaced_by: string | null }>(
      "select id, status, replaced_by from bookings where id = any($1) order by created_at",
      [[first.booking_id, second.booking_id, third.booking_id]],
    );
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled", "confirmed"]);
    expect(rows[1]!.replaced_by).toBe(third.booking_id);
    const ctx = await context(token);
    expect(ctx.booking).toMatchObject({ id: third.booking_id, seats: 2, changeable: true });
  });

  it("Umbuchen und Stornieren nur bis zur Frist (48 h vor Beginn)", async () => {
    const soon = await newSlot({ capacity: 5, startsIn: "24 hours" });
    const token = await newInvitation();
    await book(token, soon, 1); // Buchen kurz vorher ist erlaubt
    await expectCode(book(token, slotId, 1), "change_deadline_passed");
    await expectCode(db.as(ANON, (c) => c.query("select public.cancel_booking($1, $2)", [tenantId, token])), "change_deadline_passed");
    expect((await context(token)).booking.changeable).toBe(false);
  });
});

describe("cancel_booking", () => {
  it("storniert, gibt Plätze frei und legt Stornomail in die Outbox", async () => {
    const slotId = await newSlot({ capacity: 2 });
    const token = await newInvitation();
    const { booking_id } = await book(token, slotId, 2);
    await db.as(ANON, (c) => c.query("select public.cancel_booking($1, $2)", [tenantId, token]));
    const [b] = await db.admin<{ status: string }>("select status from bookings where id = $1", [booking_id]);
    expect(b!.status).toBe("cancelled");
    await book(await newInvitation(), slotId, 2); // Plätze wieder frei
    const mails = await db.admin("select type from email_outbox where payload->>'booking_id' = $1 order by created_at", [booking_id]);
    expect(mails.map((m) => m.type)).toEqual(["confirmation", "cancellation"]);
    await expectCode(db.as(ANON, (c) => c.query("select public.cancel_booking($1, $2)", [tenantId, token])), "no_active_booking");
  });
});

describe("Überbuchungsschutz", () => {
  it("20 parallele Buchungen auf den letzten Platz: genau eine gewinnt", async () => {
    const slotId = await newSlot({ capacity: 3 });
    await book(await newInvitation(), slotId, 2); // 1 Platz frei
    const tokens = await Promise.all(Array.from({ length: 20 }, () => newInvitation()));

    // Jede Buchung auf eigener Verbindung/Transaktion, gleichzeitig gestartet
    const results = await Promise.allSettled(tokens.map((t) => book(t, slotId, 1)));

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(19);
    expect(new Set(failed.map((f) => tbCode(f.reason)))).toEqual(new Set(["not_enough_seats"]));

    const [{ booked }] = (await db.admin<{ booked: number }>("select app.slot_booked_seats($1) as booked", [slotId])) as [{ booked: number }];
    expect(booked).toBe(3);
  });

  it("parallele Mehrplatz-Buchungen überschreiten nie die Kapazität", async () => {
    const slotId = await newSlot({ capacity: 10 });
    const tokens = await Promise.all(Array.from({ length: 15 }, () => newInvitation()));
    await Promise.allSettled(tokens.map((t, i) => book(t, slotId, (i % 3) + 1)));
    const [{ booked }] = (await db.admin<{ booked: number }>("select app.slot_booked_seats($1) as booked", [slotId])) as [{ booked: number }];
    expect(booked).toBeLessThanOrEqual(10);
    expect(booked).toBeGreaterThanOrEqual(8);
  });
});
