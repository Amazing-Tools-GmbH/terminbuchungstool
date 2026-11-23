/**
 * Weitere Teilnehmer mit eigener Einladung: Anlegen beim Buchen, eigener
 * Link (nur Absage für sich), Umbuchung/Storno durch den Hauptbucher, Mails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { decryptSecret } from "@/lib/crypto/secretbox";
import { bookSlot, cancelBooking, cancelGuest, loadBookingGuests, loadGuestContext } from "@/lib/booking/service";
import { checkAttendees } from "@/lib/booking/input";
import { processOutbox } from "@/lib/mail/outbox";
import type { MailMessage, MailSender } from "@/lib/mail/types";
import { setupTestDb, tbCode, type TestDb } from "./helpers";

let db: TestDb;
let tenant: { id: string; slug: string };
let eventId: string;
const anon = (fn: (c: import("pg").PoolClient) => Promise<unknown>) => db.as(ANON, fn);

beforeAll(async () => {
  db = await setupTestDb();
  const s = db.seed.find((x) => x.slug === "antennevorarlberg")!;
  tenant = { id: s.tenantId, slug: s.slug };
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenant.id])) as [{ id: string }];
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin("delete from email_outbox");
});

async function newSlot(startsIn = "10 days", capacity = 10) {
  const [s] = await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + $3::interval, now() + $3::interval + interval '2 hours', $4) returning id`,
    [tenant.id, eventId, startsIn, capacity],
  );
  return s!.id;
}

async function newInvitation(dealId: number | null = null) {
  const token = generateToken();
  await db.admin(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at, pipedrive_deal_id)
     values ($1, $2, $3, 'Eva Probe', 'eva@kunde.example', now() + interval '30 days', $4)`,
    [tenant.id, eventId, hashToken(token), dealId],
  );
  return token;
}

const guests = [
  { name: "Max Gast", email: "max@gast.example" },
  { name: "Lea Gast", email: "lea@gast.example" },
];

function book(token: string, slotId: string, opts: { seats?: number; extra?: string[]; guests?: typeof guests } = {}) {
  return bookSlot(anon as never, tenant, {
    token,
    slotId,
    seats: opts.seats ?? 4,
    name: "Eva Probe",
    email: "eva@kunde.example",
    extraAttendees: opts.extra ?? ["Max Gast", "Lea Gast", "Tom ohne Mail"],
    guests: opts.guests ?? guests,
  });
}

type OutboxRow = { type: string; to_email: string; payload: Record<string, unknown> };
const outbox = () => db.admin<OutboxRow>("select type::text, to_email, payload from email_outbox order by created_at, to_email");

/** Token aus dem verschlüsselten Link einer Teilnehmer-Mail */
async function guestToken(email: string): Promise<string> {
  const row = (await outbox()).find((r) => r.to_email === email && r.type === "confirmation" && r.payload.guest_id);
  return decryptSecret(String(row!.payload.link_enc)).split("/b/")[1]!;
}

async function code(p: Promise<unknown>) {
  return p.then(
    () => null,
    (e: unknown) => tbCode(e) ?? (e as Error).message,
  );
}

describe("Buchen mit eingeladenen Teilnehmern", () => {
  it("legt Teilnehmer an und verschickt je eine eigene Einladung", async () => {
    const token = await newInvitation();
    const { bookingId } = await book(token, await newSlot());

    const rows = await db.admin<{ name: string; email: string; status: string }>(
      "select name, email, status::text from booking_guests where booking_id = $1 order by name",
      [bookingId],
    );
    expect(rows).toEqual([
      { name: "Lea Gast", email: "lea@gast.example", status: "confirmed" },
      { name: "Max Gast", email: "max@gast.example", status: "confirmed" },
    ]);
    const mails = await outbox();
    expect(mails.map((m) => [m.type, m.to_email, Boolean(m.payload.guest_id)])).toEqual([
      ["confirmation", "eva@kunde.example", false],
      ["confirmation", "lea@gast.example", true],
      ["confirmation", "max@gast.example", true],
    ]);
    // eigener Link je Teilnehmer, nur verschlüsselt in der Outbox
    const t1 = await guestToken("max@gast.example");
    const t2 = await guestToken("lea@gast.example");
    expect(t1).not.toBe(t2);
    expect(JSON.stringify(mails)).not.toContain(t1);

    // Buchungsseite des Hauptbuchers kennt die Teilnehmer (Vorbelegung beim Ändern)
    expect(await loadBookingGuests(anon as never, tenant.id, token)).toEqual([
      { name: "Max Gast", email: "max@gast.example" },
      { name: "Lea Gast", email: "lea@gast.example" },
    ]);
  });

  it("Teilnehmer-Link: Mandant + Ansicht, aber kein Zugriff auf die ganze Buchung", async () => {
    const token = await newInvitation();
    await book(token, await newSlot());
    const gt = await guestToken("max@gast.example");

    const resolved = await db.as(ANON, async (c) => (await c.query("select public.resolve_tenant_by_token($1) as t", [gt])).rows[0].t);
    expect(resolved.id).toBe(tenant.id);
    const ctx = await loadGuestContext(anon as never, tenant.id, gt);
    expect(ctx).toMatchObject({
      guest: { name: "Max Gast", email: "max@gast.example", status: "confirmed" },
      booker: { name: "Eva Probe" },
      event: { title: "Kunden-Workshop Radiowerbung" },
      booking: { status: "confirmed", changeable: true },
    });
    // nur der eigene Mandant
    const other = db.seed.find((x) => x.slug === "demo")!.tenantId;
    expect(await loadGuestContext(anon as never, other, gt)).toBeNull();
    // weder Buchungsseite noch Storno/Umbuchung der ganzen Buchung
    expect(await db.as(ANON, async (c) => (await c.query("select public.get_invitation_context($1, $2) as r", [tenant.id, gt])).rows[0].r)).toBeNull();
    expect(await code(cancelBooking(anon as never, tenant, gt))).toBe("invitation_not_found");
    expect(await code(book(gt, await newSlot()))).toBe("invitation_not_found");
  });

  it("prüft Teilnehmer: Name muss in der Liste stehen, eigene E-Mail, nicht doppelt", async () => {
    const slot = await newSlot();
    expect(await code(book(await newInvitation(), slot, { guests: [{ name: "Unbekannt", email: "u@x.example" }] }))).toBe("invalid_attendees");
    expect(await code(book(await newInvitation(), slot, { guests: [{ name: "Max Gast", email: "EVA@kunde.example" }] }))).toBe(
      "invalid_guest_email",
    );
    expect(
      await code(
        book(await newInvitation(), slot, {
          guests: [
            { name: "Max Gast", email: "x@gast.example" },
            { name: "Lea Gast", email: "x@gast.example" },
          ],
        }),
      ),
    ).toBe("invalid_guest_email");
    // nichts angelegt
    expect(await outbox()).toEqual([]);
  });
});

describe("Absage durch einen Teilnehmer", () => {
  it("gibt nur den eigenen Platz frei und informiert beide Seiten", async () => {
    const token = await newInvitation(4711);
    const { bookingId } = await book(token, await newSlot());
    const gt = await guestToken("max@gast.example");
    await db.admin("delete from email_outbox");
    await db.admin("delete from pipedrive_jobs");

    await cancelGuest(anon as never, tenant, gt);

    const [b] = await db.admin<{ seats: number; extra_attendees: string[]; status: string }>(
      "select seats, extra_attendees, status::text from bookings where id = $1",
      [bookingId],
    );
    expect(b).toEqual({ seats: 3, extra_attendees: ["Lea Gast", "Tom ohne Mail"], status: "confirmed" });
    const g = await db.admin<{ email: string; status: string }>("select email, status::text from booking_guests where booking_id = $1 order by email", [
      bookingId,
    ]);
    expect(g).toEqual([
      { email: "lea@gast.example", status: "confirmed" },
      { email: "max@gast.example", status: "cancelled" },
    ]);
    const mails = await outbox();
    expect(mails.map((m) => [m.type, m.to_email]).sort()).toEqual([
      ["cancellation", "max@gast.example"],
      ["confirmation", "eva@kunde.example"],
    ]);
    expect(mails.find((m) => m.to_email === "eva@kunde.example")!.payload.guest_cancelled).toBe("Max Gast");
    // Pipedrive-Aktivität wird aktualisiert (Plätze geändert)
    const jobs = await db.admin<{ type: string }>("select type from pipedrive_jobs where payload->>'booking_id' = $1", [bookingId]);
    expect(jobs.map((j) => j.type)).toEqual(["booking_activity"]);

    // zweite Absage geht nicht, Ansicht zeigt „abgesagt“
    expect(await code(cancelGuest(anon as never, tenant, gt))).toBe("no_active_booking");
    expect((await loadGuestContext(anon as never, tenant.id, gt))?.guest.status).toBe("cancelled");
  });

  it("nach Ablauf der Frist nicht mehr möglich", async () => {
    const token = await newInvitation();
    await book(token, await newSlot("2 hours"));
    const gt = await guestToken("max@gast.example");
    expect(await code(cancelGuest(anon as never, tenant, gt))).toBe("change_deadline_passed");
  });
});

describe("Hauptbucher ändert oder storniert", () => {
  it("Umbuchung: Verbliebene bekommen neue Links (geändert), Entfernte eine Absage", async () => {
    const token = await newInvitation();
    const first = await book(token, await newSlot());
    const oldMax = await guestToken("max@gast.example");
    await db.admin("delete from email_outbox");

    const second = await book(token, await newSlot("12 days"), {
      seats: 3,
      extra: ["Max Gast", "Neu Gast"],
      guests: [
        { name: "Max Gast", email: "max@gast.example" },
        { name: "Neu Gast", email: "neu@gast.example" },
      ],
    });
    expect(second.replacedBookingId).toBe(first.bookingId);

    const mails = await outbox();
    const guestMails = mails.filter((m) => m.payload.guest_id).map((m) => [m.type, m.to_email, m.payload.changed ?? null]);
    expect(guestMails).toEqual(
      expect.arrayContaining([
        ["cancellation", "lea@gast.example", null],
        ["confirmation", "max@gast.example", true],
        ["confirmation", "neu@gast.example", false],
      ]),
    );
    expect(guestMails).toHaveLength(3);
    // alter Link zeigt die beendete Buchung, neuer Link die neue
    expect((await loadGuestContext(anon as never, tenant.id, oldMax))?.booking.status).toBe("cancelled");
    const newMax = await guestToken("max@gast.example");
    expect(newMax).not.toBe(oldMax);
    expect((await loadGuestContext(anon as never, tenant.id, newMax))?.booking.status).toBe("confirmed");
  });

  it("Storno: alle Teilnehmer bekommen eine Absage", async () => {
    const token = await newInvitation();
    await book(token, await newSlot());
    await db.admin("delete from email_outbox");
    await cancelBooking(anon as never, tenant, token);
    const mails = await outbox();
    expect(mails.map((m) => [m.type, m.to_email]).sort()).toEqual([
      ["cancellation", "eva@kunde.example"],
      ["cancellation", "lea@gast.example"],
      ["cancellation", "max@gast.example"],
    ]);
  });
});

describe("Mails an Teilnehmer", () => {
  class Recorder implements MailSender {
    sent: MailMessage[] = [];
    async send(m: MailMessage) {
      this.sent.push(m);
      return { messageId: `rec-${this.sent.length}` };
    }
  }

  it("Einladung mit eigenem Kalendereintrag und Link nur zum Absagen", async () => {
    const token = await newInvitation();
    await book(token, await newSlot());
    const gt = await guestToken("max@gast.example");
    const rec = new Recorder();
    await processOutbox(db.pool, { senderFactory: () => rec });

    const booker = rec.sent.find((m) => m.to.email === "eva@kunde.example")!;
    const guest = rec.sent.find((m) => m.to.email === "max@gast.example")!;
    expect(guest.to.name).toBe("Max Gast");
    expect(guest.subject).toMatch(/^Einladung: Kunden-Workshop Radiowerbung am /);
    expect(guest.html).toContain("Eva Probe hat euch für diesen Termin angemeldet.");
    expect(guest.html).toContain(`/b/${gt}`);
    expect(guest.html).not.toContain(`/b/${token}`);
    const uid = (m: MailMessage) => /UID:(.*)/.exec(String(m.attachments?.[0]?.content))?.[1];
    expect(uid(guest)).toBeTruthy();
    expect(uid(guest)).not.toBe(uid(booker));

    // Absage eines Teilnehmers: Hinweis an den Hauptbucher
    await cancelGuest(anon as never, tenant, gt);
    const rec2 = new Recorder();
    await processOutbox(db.pool, { senderFactory: () => rec2 });
    const notice = rec2.sent.find((m) => m.to.email === "eva@kunde.example")!;
    expect(notice.html).toContain("Max Gast hat die Teilnahme abgesagt. Eure Buchung umfasst jetzt 3 Personen.");
    const bye = rec2.sent.find((m) => m.to.email === "max@gast.example")!;
    expect(bye.subject).toMatch(/^Abgesagt: /);
    expect(String(bye.attachments?.[0]?.content)).toContain("STATUS:CANCELLED");
    expect(uid(bye)).toBe(uid(guest));
  });
});

describe("Eingaben aus dem Formular", () => {
  it("checkAttendees", () => {
    const rows = [
      { name: "Max", email: "MAX@x.example " },
      { name: "", email: "" },
      { name: "Lea", email: "" },
    ];
    expect(checkAttendees(rows, 4, false, "eva@x.example")).toEqual({ ok: true, extraAttendees: ["Max", "Lea"], guests: [] });
    // mit Einladung: nur Zeilen mit E-Mail bekommen eine, die anderen bleiben Namen
    expect(checkAttendees(rows, 4, true, "eva@x.example")).toEqual({
      ok: true,
      extraAttendees: ["Max", "Lea"],
      guests: [{ name: "Max", email: "max@x.example" }],
    });
    expect(checkAttendees([{ name: "Max", email: "kein-mail" }], 4, true, "eva@x.example")).toEqual({ ok: false, error: "invalid_guest_email" });
    expect(checkAttendees([{ name: "", email: "a@x.example" }], 2, true, "eva@x.example")).toEqual({ ok: false, error: "missing_guest_name" });
    expect(checkAttendees([rows[0]!], 2, true, "max@x.example")).toEqual({ ok: false, error: "invalid_guest_email" });
    expect(checkAttendees(rows, 2, false, "")).toEqual({ ok: false, error: "invalid_attendees" });
  });
});
