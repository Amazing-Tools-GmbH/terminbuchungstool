/**
 * Events, Termine, Buchungen pflegen: Stornieren durch das Team, Termin
 * verschieben/absagen, Event löschen – jeweils mit oder ohne Mail (Haken).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookSlot } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import type { MailMessage, MailSender } from "@/lib/mail/types";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let m: typeof import("@/lib/admin/maintenance");
let owner: AdminContext;
let sales: AdminContext;
let tenant: { id: string; slug: string };
const anon = (fn: (c: import("pg").PoolClient) => Promise<unknown>) => db.as(ANON, fn);

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  m = await import("@/lib/admin/maintenance");
  const s = db.seed.find((x) => x.slug === "antennevorarlberg")!;
  tenant = { id: s.tenantId, slug: s.slug };
  const rows = await db.admin<{ user_id: string; role: "owner" | "sales" }>(
    "select user_id, role::text as role from tenant_members where tenant_id = $1 and status = 'active'",
    [tenant.id],
  );
  const t = { id: tenant.id, timezone: "Europe/Vienna" } as AdminContext["tenant"];
  const ctx = (role: "owner" | "sales"): AdminContext => {
    const userId = rows.find((x) => x.role === role)!.user_id;
    return { tenant: t, userId, actor: { role: "authenticated", userId }, role, name: null, email: null };
  };
  owner = ctx("owner");
  sales = ctx("sales");
});
afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});
beforeEach(async () => {
  await db.admin("delete from email_outbox");
  await db.admin("delete from pipedrive_jobs");
});

async function newEvent() {
  const [e] = await db.admin<{ id: string }>("insert into events (tenant_id, title, status) values ($1, 'Pflege-Test', 'published') returning id", [tenant.id]);
  return e!.id;
}
async function newSlot(eventId: string, startsIn = "10 days") {
  const [s] = await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + $3::interval, now() + $3::interval + interval '2 hours', 20) returning id`,
    [tenant.id, eventId, startsIn],
  );
  return s!.id;
}
let n = 0;
async function book(eventId: string, slotId: string, opts: { deal?: number; guest?: boolean } = {}) {
  n++;
  const token = generateToken();
  await db.admin(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at, pipedrive_deal_id, link_enc)
     values ($1, $2, $3, 'Kunde', $4, now() + interval '30 days', $5, null)`,
    [tenant.id, eventId, hashToken(token), `kunde${n}@x.example`, opts.deal ?? null],
  );
  const r = await bookSlot(anon as never, tenant, {
    token,
    slotId,
    seats: 2,
    name: "Kunde",
    email: `kunde${n}@x.example`,
    extraAttendees: ["Gast"],
    guests: opts.guest ? [{ name: "Gast", email: `gast${n}@x.example` }] : [],
  });
  await db.admin("delete from email_outbox");
  await db.admin("delete from pipedrive_jobs");
  return r.bookingId;
}
const outbox = () => db.admin<{ type: string; to_email: string; payload: Record<string, unknown> }>("select type::text, to_email, payload from email_outbox order by to_email");
const bookingStatus = async (id: string) => (await db.admin<{ status: string }>("select status::text from bookings where id = $1", [id]))[0]!.status;

describe("Buchung durch das Team stornieren", () => {
  it("mit Haken: Mail an Kunde und eingeladene Teilnehmer, Aktivität wird gelöscht", async () => {
    const e = await newEvent();
    const b = await book(e, await newSlot(e), { deal: 555, guest: true });
    await m.cancelBookingByTeam(owner, b, true);
    expect(await bookingStatus(b)).toBe("cancelled");
    const mails = await outbox();
    expect(mails.map((x) => [x.type, x.to_email.replace(/\d+/, "")])).toEqual([
      ["cancellation", "gast@x.example"],
      ["cancellation", "kunde@x.example"],
    ]);
    expect(mails.every((x) => x.payload.by_organizer === true)).toBe(true);
    const jobs = await db.admin<{ type: string }>("select type from pipedrive_jobs");
    expect(jobs.map((j) => j.type)).toEqual(["cancel_activity"]);
  });

  it("ohne Haken: keine Mail; sales darf nicht; zweimal geht nicht", async () => {
    const e = await newEvent();
    const b = await book(e, await newSlot(e), { guest: true });
    await expect(m.cancelBookingByTeam(sales, b, false)).rejects.toMatchObject({ code: "forbidden" });
    await m.cancelBookingByTeam(owner, b, false);
    expect(await outbox()).toEqual([]);
    const [g] = await db.admin<{ status: string }>("select status::text from booking_guests where booking_id = $1", [b]);
    expect(g!.status).toBe("cancelled");
    await expect(m.cancelBookingByTeam(owner, b, false)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Termin verschieben", () => {
  it("mit Haken: geänderte Buchung an Kunde und Teilnehmer (mit eigenem Link), Aktivität aktualisiert", async () => {
    const e = await newEvent();
    const s = await newSlot(e);
    const b = await book(e, s, { deal: 556, guest: true });
    const date = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const count = await m.updateSlot(owner, { slotId: s, date, from: "14:00", to: "16:00", location: "Neuer Ort", notify: true });
    expect(count).toBe(1);
    const [slot] = await db.admin<{ h: string; location: string }>(
      "select to_char(starts_at at time zone 'Europe/Vienna', 'HH24:MI') as h, location from slots where id = $1",
      [s],
    );
    expect(slot).toEqual({ h: "14:00", location: "Neuer Ort" });
    expect(await bookingStatus(b)).toBe("confirmed");
    const mails = await outbox();
    expect(mails.map((x) => x.type)).toEqual(["confirmation", "confirmation"]);
    const guest = mails.find((x) => x.payload.guest_id)!;
    expect(guest.payload).toMatchObject({ changed: true, by_organizer: true });
    expect(typeof guest.payload.link_enc).toBe("string");
    expect((await db.admin<{ type: string }>("select type from pipedrive_jobs")).map((j) => j.type)).toEqual(["booking_activity"]);
  });

  it("ohne Haken keine Mail; nicht in die Vergangenheit", async () => {
    const e = await newEvent();
    const s = await newSlot(e);
    await book(e, s);
    const date = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    await m.updateSlot(owner, { slotId: s, date, from: "09:00", to: "10:00", location: null, notify: false });
    expect(await outbox()).toEqual([]);
    await expect(m.updateSlot(owner, { slotId: s, date: "2020-01-01", from: "09:00", to: "10:00", location: null, notify: false })).rejects.toMatchObject({
      code: "slot_in_past",
    });
  });
});

describe("Termin absagen", () => {
  it("ohne Buchungen: Termin wird gelöscht", async () => {
    const e = await newEvent();
    const s = await newSlot(e);
    expect(await m.cancelSlot(owner, s, true)).toBe(0);
    expect(await db.admin("select 1 from slots where id = $1", [s])).toEqual([]);
  });

  it("mit Buchungen: abgesagt, Buchungen storniert, Mail nur mit Haken", async () => {
    const e = await newEvent();
    const s = await newSlot(e);
    const b1 = await book(e, s);
    const b2 = await book(e, s);
    expect(await m.cancelSlot(owner, s, true)).toBe(2);
    expect(await bookingStatus(b1)).toBe("cancelled");
    expect(await bookingStatus(b2)).toBe("cancelled");
    expect((await outbox()).filter((x) => x.type === "cancellation")).toHaveLength(2);
    const [slot] = await db.admin<{ status: string }>("select status::text from slots where id = $1", [s]);
    expect(slot!.status).toBe("cancelled");
  });
});

describe("Event löschen", () => {
  it("ohne Buchungen: wirklich gelöscht (samt Terminen und Links)", async () => {
    const e = await newEvent();
    await newSlot(e);
    await db.admin(
      "insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at) values ($1, $2, $3, 'X', 'x@x.example', now() + interval '1 day')",
      [tenant.id, e, hashToken(generateToken())],
    );
    expect(await m.deleteEvent(owner, e, false)).toEqual({ deleted: true, cancelled: 0 });
    expect(await db.admin("select 1 from events where id = $1", [e])).toEqual([]);
  });

  it("mit Buchungen, ohne Haken: alle storniert, KEINE Mail, Links ungültig, Event archiviert", async () => {
    const e = await newEvent();
    const s1 = await newSlot(e);
    const s2 = await newSlot(e, "12 days");
    await book(e, s1, { guest: true });
    await book(e, s2);
    expect(await m.deleteEvent(owner, e, false)).toEqual({ deleted: false, cancelled: 2 });
    expect(await outbox()).toEqual([]);
    const inv = await db.admin<{ status: string }>("select distinct status::text from invitations where event_id = $1", [e]);
    expect(inv).toEqual([{ status: "revoked" }]);
    const [ev] = await db.admin<{ status: string }>("select status::text from events where id = $1", [e]);
    expect(ev!.status).toBe("archived");
    await expect(m.deleteEvent(owner, e, false)).rejects.toMatchObject({ code: "not_found" });
  });

  it("mit Haken: alle bekommen eine Absage, ohne Link zum Neubuchen", async () => {
    const e = await newEvent();
    await book(e, await newSlot(e), { guest: true });
    await m.deleteEvent(owner, e, true);
    const mails = await outbox();
    expect(mails).toHaveLength(2);
    expect(mails.every((x) => x.type === "cancellation" && !x.payload.link_enc)).toBe(true);
  });
});

describe("Mails bei Änderungen durch den Veranstalter", () => {
  class Recorder implements MailSender {
    sent: MailMessage[] = [];
    async send(x: MailMessage) {
      this.sent.push(x);
      return { messageId: `r${this.sent.length}` };
    }
  }
  it("Absage und Verschiebung haben eigene Hinweise und aktualisieren den Kalender", async () => {
    const e = await newEvent();
    const s = await newSlot(e);
    const b = await book(e, s);
    const date = new Date(Date.now() + 22 * 86_400_000).toISOString().slice(0, 10);
    await m.updateSlot(owner, { slotId: s, date, from: "11:00", to: "12:00", location: null, notify: true });
    const rec = new Recorder();
    await processOutbox(db.pool, { senderFactory: () => rec });
    expect(rec.sent[0]!.subject).toMatch(/^Geänderte Buchung/);
    expect(rec.sent[0]!.html).toContain("der Termin wurde von uns geändert");
    await m.cancelBookingByTeam(owner, b, true);
    await processOutbox(db.pool, { senderFactory: () => rec });
    expect(rec.sent[1]!.html).toContain("leider müssen wir diesen Termin absagen");
    const seq = (x: MailMessage) => Number(/SEQUENCE:(\d+)/.exec(String(x.attachments?.[0]?.content))?.[1]);
    expect(seq(rec.sent[1]!)).toBeGreaterThanOrEqual(seq(rec.sent[0]!));
    expect(String(rec.sent[1]!.attachments?.[0]?.content)).toContain("STATUS:CANCELLED");
  });
});
