/**
 * Absage im Panel (public.panel_cancel_booking) durch den Vertrieb:
 *   reinvite  Buchung storniert, Link bleibt gültig, Absage mit Link an den Kunden
 *   lost      Buchung storniert, Link gesperrt, Absage nur mit notify (ohne Link),
 *             Auftrag deal_lost -> Deal in Pipedrive auf „verloren“
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { processPipedriveJobs } from "@/lib/pipedrive/jobs";
import { FakePipedriveCrm } from "@/lib/pipedrive/crm";
import { setupTestDb, tbCode, type TestDb } from "./helpers";
import { currentInvitation } from "@/lib/panel/context";

let db: TestDb;
let tenantId: string;
let eventId: string;
let slotId: string;
let sales: { role: "authenticated"; userId: string };
let deal = 5500;

const access = async () => ({ apiDomain: "https://x.pipedrive.com", accessToken: "t" });

beforeAll(async () => {
  db = await setupTestDb();
  tenantId = db.seed.find((s) => s.slug === "antennevorarlberg")!.tenantId;
  const [m] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 and role = 'sales' and status = 'active'", [tenantId]);
  sales = { role: "authenticated", userId: m!.user_id };
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantId])) as [{ id: string }];
  [{ id: slotId }] = (await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + interval '30 days', now() + interval '30 days 2 hours', 20) returning id`,
    [tenantId, eventId],
  )) as [{ id: string }];
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin("delete from pipedrive_jobs");
  await db.admin("delete from email_outbox");
});

/** Direktbuchung aus dem Panel; Ergebnis: Einladung + Buchung */
async function bookInDeal(dealId: number | null = ++deal, email = "bernd@kunde.example") {
  // je E-Mail nur eine aktive Buchung: vorherige Testbuchungen beenden
  await db.admin("update bookings set status = 'cancelled', cancelled_at = now() where status = 'confirmed'");
  await db.admin("update invitations set status = 'cancelled' where status = 'booked'");
  const token = generateToken();
  await db.as(sales, (c) =>
    c.query("select public.book_for_deal($1, $2, $3, $4, 'Bernd Test', $6, 'Kunde GmbH', $5, 77, 2)", [
      tenantId,
      slotId,
      token,
      encryptSecret(`https://x.example/b/${token}`),
      dealId,
      email,
    ]),
  );
  const [r] = await db.admin<{ invitation_id: string; booking_id: string }>(
    "select i.id as invitation_id, b.id as booking_id from invitations i join bookings b on b.invitation_id = i.id order by b.created_at desc limit 1",
  );
  await db.admin("delete from email_outbox");
  await db.admin("delete from pipedrive_jobs");
  return { token, ...r! };
}

const cancel = (actor: DbActor, invitationId: string, mode: string, notify = true, reason: string | null = null) =>
  db.as(actor, (c) => c.query("select public.panel_cancel_booking($1, $2, $3, $4, $5) as r", [tenantId, invitationId, mode, notify, reason]));
const state = (r: { invitation_id: string; booking_id: string }) =>
  db.admin<{ inv: string; booking: string; cancelled_by: string | null }>(
    `select i.status::text as inv, b.status::text as booking, b.cancelled_by::text as cancelled_by
       from invitations i join bookings b on b.invitation_id = i.id where b.id = $1`,
    [r.booking_id],
  );

describe("Absage im Panel", () => {
  it("neu einladen: Buchung storniert, Deal unberührt, alter Link gesperrt, Absage ohne Link", async () => {
    const r = await bookInDeal();
    await cancel(sales, r.invitation_id, "reinvite");
    expect(await state(r)).toEqual([{ inv: "revoked", booking: "cancelled", cancelled_by: sales.userId }]);
    const mails = await db.admin<{ type: string; payload: { link_enc: string | null; by_organizer: boolean } }>("select type, payload from email_outbox");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.payload.by_organizer).toBe(true);
    expect(mails[0]!.payload.link_enc).toBeNull();
    // nur Aktivität löschen, kein „verloren“
    expect((await db.admin<{ type: string }>("select type from pipedrive_jobs")).map((j) => j.type)).toEqual(["cancel_activity"]);
    // alter Link bucht nicht mehr – der Vertrieb lädt neu ein oder bucht
    const err = await db
      .as(ANON, (c) => c.query("select public.book_slot_once($1, $2, $3, 1, 'Bernd Test', 'bernd@kunde.example')", [tenantId, r.token, slotId]))
      .then(() => null, tbCode);
    expect(err).toBeTruthy();
    // danach direkt neu buchen geht
    await bookInDeal();
  });

  it("neu einladen ohne Mail", async () => {
    const r = await bookInDeal();
    await cancel(sales, r.invitation_id, "reinvite", false);
    expect(await db.admin("select 1 from email_outbox")).toHaveLength(0);
  });

  it("Deal verloren: Link gesperrt, Absage ohne Link, Deal in Pipedrive auf verloren", async () => {
    const r = await bookInDeal(4711);
    await cancel(sales, r.invitation_id, "lost", true, "Kein Bedarf");
    expect((await state(r))[0]).toMatchObject({ inv: "revoked", booking: "cancelled" });
    const [mail] = await db.admin<{ payload: { link_enc: string | null } }>("select payload from email_outbox");
    expect(mail!.payload.link_enc).toBeNull();
    const crm = new FakePipedriveCrm({});
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.find((l) => l.op === "markDealLost")?.detail).toEqual({ id: 4711, reason: "Kein Bedarf" });
    // gesperrter Link: kein neues Buchen
    const err = await db
      .as(ANON, (c) => c.query("select public.book_slot_once($1, $2, $3, 1, 'Bernd Test', 'bernd@kunde.example')", [tenantId, r.token, slotId]))
      .then(() => null, tbCode);
    expect(err).toBeTruthy();
  });

  it("Deal verloren ohne Mail; ohne Grund -> Standardgrund", async () => {
    const r = await bookInDeal(4712);
    await cancel(sales, r.invitation_id, "lost", false);
    expect(await db.admin("select 1 from email_outbox")).toHaveLength(0);
    const crm = new FakePipedriveCrm({});
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.find((l) => l.op === "markDealLost")?.detail).toEqual({ id: 4712, reason: "Termin abgesagt" });
  });

  it("ohne Buchung, ohne Deal (lost), fremde/unbekannte Benutzer -> Fehler", async () => {
    const r = await bookInDeal();
    await cancel(sales, r.invitation_id, "reinvite");
    expect(await cancel(sales, r.invitation_id, "reinvite").then(() => null, tbCode)).toBe("not_found");
    const p = await bookInDeal(null);
    expect(await cancel(sales, p.invitation_id, "lost").then(() => null, tbCode)).toBe("invalid_input");
    expect(await cancel(sales, p.invitation_id, "egal").then(() => null, tbCode)).toBe("invalid_input");
    const other = db.seed.find((s) => s.slug === "demo")!.tenantId;
    const [o] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 limit 1", [other]);
    expect(await cancel({ role: "authenticated", userId: o!.user_id }, p.invitation_id, "reinvite").then(() => null, tbCode)).toBe("forbidden");
    await expect(cancel(ANON, p.invitation_id, "reinvite")).rejects.toThrow();
    // gesperrtes Mitglied
    await db.admin("update tenant_members set status = 'disabled' where user_id = $1 and tenant_id = $2", [sales.userId, tenantId]);
    try {
      expect(await cancel(sales, p.invitation_id, "reinvite").then(() => null, tbCode)).toBe("forbidden");
    } finally {
      await db.admin("update tenant_members set status = 'active' where user_id = $1 and tenant_id = $2", [sales.userId, tenantId]);
    }
  });
});

const sessionFor = (deal: number | null) => ({ uid: sales.userId, tid: tenantId, pd: 1, deal, person: deal ? null : 77 }) as never;
const shown = (deal: number | null, person: { id: number; email: string | null }) =>
  db.as(sales, (c) => currentInvitation(c as never, tenantId, sessionFor(deal), person));

describe("Panel: Abgleich über die E-Mail-Adresse des Kontakts", () => {
  it("Kontakt-Panel: aktive Buchung zur E-Mail, auch bei neuerer Einladung und anderer Person-ID", async () => {
    const r = await bookInDeal(4800);
    await db.admin(
      `insert into invitations (tenant_id, event_id, token_hash, name, email, pipedrive_deal_id, pipedrive_person_id, expires_at)
       values ($1, $2, $3, 'Bernd Test', 'bernd@kunde.example', 4801, 77, now() + interval '30 days')`,
      [tenantId, eventId, hashToken(generateToken())],
    );
    expect((await shown(null, { id: 9999, email: "Bernd@Kunde.example" }))?.id).toBe(r.invitation_id);
    // auch im anderen Deal desselben Kontakts: die aktive Buchung zählt
    expect((await shown(4801, { id: 77, email: "bernd@kunde.example" }))?.id).toBe(r.invitation_id);
  });

  it("Kontakt im Deal gewechselt: Buchung des alten Kontakts erscheint nicht mehr", async () => {
    await bookInDeal(4850, "kontakt.a@kunde.example");
    // gleicher Deal, gleiche Person-ID (z. B. Person umbenannt) – aber andere E-Mail = anderer Kontakt
    expect(await shown(4850, { id: 77, email: "kontakt.b@kunde.example" })).toBeNull();
    // ohne E-Mail kein Abgleich
    expect(await shown(4850, { id: 77, email: null })).toBeNull();
  });

  it("bereits gebucht gilt je E-Mail – egal in welchem Deal", async () => {
    await bookInDeal(4860);
    const token = generateToken();
    const err = await db
      .as(sales, (c) =>
        c.query("select public.book_for_deal($1, $2, $3, $4, 'Bernd Test', 'BERND@kunde.example', null, 4861, 78, 1)", [
          tenantId,
          slotId,
          token,
          encryptSecret(`https://x.example/b/${token}`),
        ]),
      )
      .then(() => null, tbCode);
    expect(err).toBe("already_booked");
  });
});

describe("Deal-Panel: Buchung aus dem Kontakt-Panel bzw. einem anderen Deal", () => {
  it("wird im Deal des Kontakts angezeigt; „Deal verloren“ setzt den Deal des Panels", async () => {
    const r = await bookInDeal(null); // im Kontakt-Panel gebucht
    expect((await shown(4900, { id: 77, email: "bernd@kunde.example" }))?.id).toBe(r.invitation_id);
    await db.as(sales, (c) => c.query("select public.panel_cancel_booking($1, $2, 'lost', false, null, 4900::bigint)", [tenantId, r.invitation_id]));
    const [i] = await db.admin<{ deal: string; status: string }>("select pipedrive_deal_id::text as deal, status::text from invitations where id = $1", [r.invitation_id]);
    expect(i).toEqual({ deal: "4900", status: "revoked" });
    const crm = new FakePipedriveCrm({});
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.find((l) => l.op === "markDealLost")?.detail).toEqual({ id: 4900, reason: "Termin abgesagt" });
  });

  it("Buchung aus Deal 4910, abgesagt in Deal 4911: verloren wird 4911", async () => {
    const r = await bookInDeal(4910);
    await db.as(sales, (c) => c.query("select public.panel_cancel_booking($1, $2, 'lost', false, null, 4911::bigint)", [tenantId, r.invitation_id]));
    const crm = new FakePipedriveCrm({});
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.filter((l) => l.op === "markDealLost").map((l) => l.detail)).toEqual([{ id: 4911, reason: "Termin abgesagt" }]);
  });
});
