/**
 * Phase 4: Einladung aus dem Panel (create_invitation), Aufträge an Pipedrive
 * bei Buchung/Umbuchung/Stornierung und deren Verarbeitung (simuliertes CRM).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { encryptSecret } from "@/lib/crypto/secretbox";
import { bookSlot, cancelBooking } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import { processPipedriveJobs } from "@/lib/pipedrive/jobs";
import { FakePipedriveCrm } from "@/lib/pipedrive/crm";
import { PipedriveError } from "@/lib/pipedrive/client";
import type { SenderFactory } from "@/lib/mail/senders";
import { setupTestDb, tbCode, type TestDb } from "./helpers";

let db: TestDb;
let tenant: { id: string; slug: string };
let tenantB: string;
let sales: DbActor;
let salesId: string;
let ownerB: DbActor;
let eventId: string;
let slots: string[] = [];

const access = async () => ({ apiDomain: "https://x.pipedrive.com", accessToken: "t" });
const sink: SenderFactory = () => ({ send: async () => ({ messageId: "m" }) });

async function expectTb(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(tbCode(err)).toBe(code);
}

beforeAll(async () => {
  db = await setupTestDb();
  const a = db.seed.find((s) => s.slug === "antennevorarlberg")!;
  tenant = { id: a.tenantId, slug: a.slug };
  tenantB = db.seed.find((s) => s.slug === "demo")!.tenantId;
  const m = await db.admin<{ tenant_id: string; user_id: string; role: string }>("select tenant_id, user_id, role::text from tenant_members");
  salesId = m.find((x) => x.tenant_id === tenant.id && x.role === "sales")!.user_id;
  sales = { role: "authenticated", userId: salesId };
  ownerB = { role: "authenticated", userId: m.find((x) => x.tenant_id === tenantB && x.role === "owner")!.user_id };
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenant.id])) as [{ id: string }];
  for (const d of [20, 21]) {
    const [s] = await db.admin<{ id: string }>(
      `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
       values ($1, $2, date_trunc('hour', now()) + make_interval(days => $3), date_trunc('hour', now()) + make_interval(days => $3, hours => 2), 50) returning id`,
      [tenant.id, eventId, d],
    );
    slots.push(s!.id);
  }
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin("delete from pipedrive_jobs");
  await db.admin("delete from email_outbox");
});

/** Einladung wie aus dem Panel */
async function invite(actor: DbActor, opts: { deal?: number | null; email?: string; slotIds?: string[] | null; tenantId?: string } = {}) {
  const token = generateToken();
  const id = await db.as(actor, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as id",
      [
        opts.tenantId ?? tenant.id,
        eventId,
        hashToken(token),
        encryptSecret(`https://atools.de/meetings/b/${token}`),
        "Maria Muster",
        opts.email ?? "Maria.Muster@kunde.example",
        "Muster Autohaus GmbH",
        opts.deal === undefined ? 1001 : opts.deal,
        5001,
        opts.slotIds === undefined ? [slots[0]] : opts.slotIds,
        30,
      ],
    );
    return rows[0]!.id;
  });
  return { token, id };
}

const jobs = () => db.admin<{ type: string; status: string; payload: Record<string, string> }>("select type, status, payload from pipedrive_jobs order by created_at");

describe("create_invitation", () => {
  it("legt Einladung (Hash, verschlüsselter Link, Termin, Einladender) und Einladungsmail an", async () => {
    const { id } = await invite(sales);
    const [inv] = await db.admin<{ email: string; created_by: string; allowed_slot_ids: string[]; pipedrive_deal_id: string; link_enc: string; status: string }>(
      "select email, created_by, allowed_slot_ids, pipedrive_deal_id, link_enc, status from invitations where id = $1",
      [id],
    );
    expect(inv).toMatchObject({ email: "maria.muster@kunde.example", created_by: salesId, allowed_slot_ids: [slots[0]], pipedrive_deal_id: "1001", status: "open" });
    expect(inv!.link_enc).toMatch(/^v1:/);
    const out = await db.admin<{ type: string; to_email: string; payload: { invitation_id: string } }>("select type, to_email, payload from email_outbox");
    expect(out).toEqual([expect.objectContaining({ type: "invitation", to_email: "maria.muster@kunde.example", payload: expect.objectContaining({ invitation_id: id }) })]);
  });

  it("erneut einladen macht den alten Link desselben Kontakts im selben Deal ungültig", async () => {
    const first = await invite(sales, { deal: 4711 });
    const other = await invite(sales, { deal: 4711, email: "anderer@kunde.example" });
    const second = await invite(sales, { deal: 4711 });
    const rows = await db.admin<{ id: string; status: string }>("select id, status from invitations where id = any($1)", [[first.id, other.id, second.id]]);
    const st = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(st).toEqual({ [first.id]: "revoked", [other.id]: "open", [second.id]: "open" });
  });

  it("Rechte und Prüfungen", async () => {
    await expectTb(invite(ownerB), "forbidden"); // fremder Mandant
    await expect(invite(ANON)).rejects.toThrow(/permission denied/);
    const [foreignSlot] = await db.admin<{ id: string }>("select id from slots where tenant_id = $1 limit 1", [tenantB]);
    await expectTb(invite(sales, { slotIds: [foreignSlot!.id] }), "slot_not_available");
    await expectTb(invite(sales, { slotIds: [] }), "slot_not_available");
    await db.admin("update events set status = 'draft' where id = $1", [eventId]);
    try {
      await expectTb(invite(sales), "event_not_available");
    } finally {
      await db.admin("update events set status = 'published' where id = $1", [eventId]);
    }
  });

  it("alle Termine anbieten (null)", async () => {
    const { id } = await invite(sales, { slotIds: null });
    const [inv] = await db.admin<{ allowed_slot_ids: string[] | null }>("select allowed_slot_ids from invitations where id = $1", [id]);
    expect(inv!.allowed_slot_ids).toBeNull();
  });
});

describe("Aufträge an Pipedrive", () => {
  const book = (token: string, slotId: string, seats = 2) =>
    bookSlot((fn) => db.as(ANON, fn), tenant, { token, slotId, seats, name: "Maria Muster", email: "maria.muster@kunde.example", extraAttendees: ["Max Muster"] });

  it("Buchung -> Aktivität; Umbuchung -> dieselbe Aktivität aktualisiert; Stornierung -> gelöscht + Notiz", async () => {
    const crm = new FakePipedriveCrm({});
    const { token } = await invite(sales, { slotIds: null });
    await book(token, slots[0]!);
    expect((await jobs()).map((j) => j.type)).toEqual(["booking_activity"]);
    expect(await processPipedriveJobs(db.pool, { crm, access })).toEqual({ done: 1, requeued: 0, failed: 0 });
    const created = crm.log[0]!;
    expect(created.op).toBe("createActivity");
    expect(created.detail).toMatchObject({ subject: "Kunden-Workshop Radiowerbung (2 Pers.)", type: "meeting", deal_id: 1001, owner_id: 7200002, participants: [{ person_id: 5001, primary: true }], duration: "02:00", done: false });
    expect(String((created.detail as { note: string }).note)).toContain("Weitere Teilnehmer: Max Muster");
    const [b1] = await db.admin<{ pipedrive_activity_id: string }>("select pipedrive_activity_id from bookings where status = 'confirmed' and email = 'maria.muster@kunde.example' order by created_at desc limit 1");
    expect(b1!.pipedrive_activity_id).toBeTruthy();

    // Umbuchung: KEIN Stornierungsauftrag, Aktivität wird aktualisiert
    await book(token, slots[1]!, 3);
    expect((await jobs()).filter((j) => j.status === "queued").map((j) => j.type)).toEqual(["booking_activity"]);
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log[1]).toMatchObject({ op: "updateActivity", detail: { id: Number(b1!.pipedrive_activity_id), subject: "Kunden-Workshop Radiowerbung (3 Pers.)" } });

    // Stornierung
    await cancelBooking((fn) => db.as(ANON, fn), tenant, token);
    expect((await jobs()).filter((j) => j.status === "queued").map((j) => j.type)).toEqual(["cancel_activity"]);
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.slice(2).map((l) => l.op)).toEqual(["deleteActivity", "addNote"]);
    expect(String((crm.log[3]!.detail as { html: string }).html)).toMatch(/Terminbuchung storniert: Kunden-Workshop Radiowerbung/);
  });

  it("ohne Pipedrive-Deal keine Aufträge", async () => {
    const { token } = await invite(sales, { deal: null, email: "ohne.deal@kunde.example", slotIds: null });
    await book(token, slots[0]!);
    expect(await jobs()).toEqual([]);
  });

  it("Notiz 'Link gesendet', wenn die Einladung nicht über Pipedrive ging (z. B. smtp)", async () => {
    const crm = new FakePipedriveCrm({});
    await invite(sales, { deal: 1002, email: "anna@kunde.example" });
    await processOutbox(db.pool, { senderFactory: sink, inviteProvider: "smtp" });
    expect((await jobs()).map((j) => j.type)).toEqual(["invitation_note"]);
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log[0]).toMatchObject({ op: "addNote", detail: { dealId: 1002, personId: 5001 } });
    expect(String((crm.log[0]!.detail as { html: string }).html)).toMatch(/Terminbuchung: Link an Maria Muster gesendet \(.+\d{2}:\d{2}–\d{2}:\d{2}\)/);
  });

  it("über Pipedrive versendet: keine zusätzliche Notiz (Mail steht schon im Deal)", async () => {
    await db.admin(
      `insert into pipedrive_user_connections (tenant_id, user_id, pipedrive_user_id, api_domain, access_token_enc, refresh_token_enc, expires_at, scopes)
       values ($1, $2, 7200002, 'https://x.pipedrive.com', $3, $3, now() + interval '1 hour', 'mail-sending:full') on conflict do nothing`,
      [tenant.id, salesId, encryptSecret("t")],
    );
    await invite(sales, { deal: 1003, email: "p@kunde.example" });
    await processOutbox(db.pool, { senderFactory: sink, inviteProvider: "pipedrive" });
    expect(await jobs()).toEqual([]);
  });

  it("Fehler: vorübergehend -> erneut; dauerhaft (4xx) oder ohne Verbindung -> failed", async () => {
    const { token } = await invite(sales, { email: "fehler@kunde.example", slotIds: null, deal: 1005 });
    await book(token, slots[0]!);
    const down = new FakePipedriveCrm({});
    down.createActivity = async () => {
      throw new PipedriveError("api", "503", 503);
    };
    expect(await processPipedriveJobs(db.pool, { crm: down, access })).toEqual({ done: 0, requeued: 1, failed: 0 });
    await db.admin("update pipedrive_jobs set next_attempt_at = now()");
    const bad = new FakePipedriveCrm({});
    bad.createActivity = async () => {
      throw new PipedriveError("api", "400", 400);
    };
    expect(await processPipedriveJobs(db.pool, { crm: bad, access })).toEqual({ done: 0, requeued: 0, failed: 1 });

    await db.admin("update pipedrive_jobs set status = 'queued', next_attempt_at = now(), attempts = 0");
    expect(await processPipedriveJobs(db.pool, { crm: new FakePipedriveCrm({}), access: async () => null })).toEqual({ done: 0, requeued: 0, failed: 1 });
  });
});
