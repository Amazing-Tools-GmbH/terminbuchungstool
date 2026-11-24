/** Löschfrist: personenbezogene Daten alter Buchungen werden entfernt, Statistik bleibt */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { purgeExpiredData } from "@/lib/retention";
import { setupTestDb, type TestDb } from "./helpers";

let db: TestDb;
let tenantId: string;
let eventId: string;

beforeAll(async () => {
  db = await setupTestDb();
  tenantId = db.seed.find((s) => s.slug === "antennevorarlberg")!.tenantId;
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantId])) as [{ id: string }];
});
afterAll(() => db?.close());

/** Buchung direkt anlegen (Test: vergangene Termine lassen sich über book_slot nicht buchen) */
async function pastBooking(monthsAgo: number, email: string) {
  const [s] = await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() - make_interval(months => $3), now() - make_interval(months => $3) + interval '2 hours', 10) returning id`,
    [tenantId, eventId, monthsAgo],
  );
  const [i] = await db.admin<{ id: string }>(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, organization_name, expires_at, status, link_enc)
     values ($1, $2, $3, 'Alte Kundin', $4, 'Alte GmbH', now() - make_interval(months => $5) + interval '1 day', 'booked', 'v1:x')
     returning id`,
    [tenantId, eventId, hashToken(generateToken()), email, monthsAgo],
  );
  const [b] = await db.admin<{ id: string }>(
    `insert into bookings (tenant_id, slot_id, invitation_id, name, email, seats, extra_attendees)
     values ($1, $2, $3, 'Alte Kundin', $4, 2, '{Gast}') returning id`,
    [tenantId, s!.id, i!.id, email],
  );
  await db.admin(
    "insert into booking_guests (tenant_id, booking_id, name, email, token_hash) values ($1, $2, 'Gast', 'gast-alt@x.example', $3)",
    [tenantId, b!.id, hashToken(generateToken())],
  );
  await db.admin(
    "insert into email_outbox (tenant_id, type, to_email, payload, status, created_at) values ($1, 'confirmation', $2, $3, 'sent', now() - make_interval(months => $4))",
    [tenantId, email, { booking_id: b!.id }, monthsAgo],
  );
  return { slotId: s!.id, invitationId: i!.id, bookingId: b!.id };
}

describe("Löschfrist", () => {
  it("anonymisiert Buchungen älter als die Frist, jüngere bleiben", async () => {
    await db.admin("update tenants set retention_months = 12, data_purged_at = null where id = $1", [tenantId]);
    const old = await pastBooking(13, "alt@kunde.example");
    const recent = await pastBooking(6, "neu@kunde.example");

    const r = await purgeExpiredData(db.pool, { force: true });
    expect(r.bookings).toBeGreaterThanOrEqual(1);

    const [b] = await db.admin<{ name: string; email: string; seats: number; extra_attendees: string[]; anonymized_at: Date | null }>(
      "select name, email, seats, extra_attendees, anonymized_at from bookings where id = $1",
      [old.bookingId],
    );
    expect(b).toMatchObject({ name: "gelöscht", email: "geloescht@example.invalid", seats: 2, extra_attendees: [] });
    expect(b!.anonymized_at).not.toBeNull();
    const [inv] = await db.admin<{ name: string; organization_name: string | null; link_enc: string | null }>(
      "select name, organization_name, link_enc from invitations where id = $1",
      [old.invitationId],
    );
    expect(inv).toEqual({ name: "gelöscht", organization_name: null, link_enc: null });
    expect(await db.admin("select 1 from booking_guests where booking_id = $1", [old.bookingId])).toEqual([]);
    expect(await db.admin("select 1 from email_outbox where to_email = 'alt@kunde.example'")).toEqual([]);

    // jüngere Buchung unverändert
    const [n] = await db.admin<{ email: string }>("select email from bookings where id = $1", [recent.bookingId]);
    expect(n!.email).toBe("neu@kunde.example");
    expect(await db.admin("select 1 from email_outbox where to_email = 'neu@kunde.example'")).toHaveLength(1);
  });

  it("kürzere Frist greift; höchstens einmal am Tag ohne force", async () => {
    await db.admin("update tenants set retention_months = 3 where id = $1", [tenantId]);
    // eben gelaufen -> ohne force nichts
    const skipped = await purgeExpiredData(db.pool);
    expect(skipped.tenants).toBe(0);
    await purgeExpiredData(db.pool, { force: true });
    const [n] = await db.admin<{ email: string }>("select email from bookings where email in ('neu@kunde.example', 'geloescht@example.invalid') order by email desc limit 1");
    expect(n!.email).toBe("geloescht@example.invalid");
    expect(await db.admin("select 1 from bookings where email = 'neu@kunde.example'")).toEqual([]);
  });

  it("kommende Buchungen und der andere Mandant bleiben unberührt", async () => {
    const other = db.seed.find((s) => s.slug === "demo")!.tenantId;
    const before = await db.admin<{ n: number }>("select count(*)::int as n from bookings where tenant_id = $1 and anonymized_at is null", [other]);
    const future = await db.admin<{ n: number }>(
      "select count(*)::int as n from bookings b join slots s on s.id = b.slot_id where b.tenant_id = $1 and s.ends_at > now() and b.anonymized_at is null",
      [tenantId],
    );
    await purgeExpiredData(db.pool, { force: true });
    expect(await db.admin("select count(*)::int as n from bookings where tenant_id = $1 and anonymized_at is null", [other])).toEqual(before);
    expect(
      await db.admin(
        "select count(*)::int as n from bookings b join slots s on s.id = b.slot_id where b.tenant_id = $1 and s.ends_at > now() and b.anonymized_at is null",
        [tenantId],
      ),
    ).toEqual(future);
  });
});
