/**
 * Öffentlicher Event-Link: Ansicht und Buchen ohne Einladung (anon, nur mit
 * Link), einmal je E-Mail; danach Dublettencheck in Pipedrive (Kontakt per
 * E-Mail, offener Deal) bzw. Kontakt + Deal anlegen, dann Aktivität.
 * Bestätigung immer über die System-Adresse (kein Mitarbeiter-Postfach).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookPublic, loadPublicEventContext } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import { processPipedriveJobs } from "@/lib/pipedrive/jobs";
import { FakePipedriveCrm } from "@/lib/pipedrive/crm";
import type { SenderFactory, SenderTarget } from "@/lib/mail/senders";
import { setupTestDb, tbCode, type TestDb } from "./helpers";

let db: TestDb;
let tenant: { id: string; slug: string };
let eventId: string;
let slotId: string;
let eventToken: string;

const anon = <T,>(fn: Parameters<TestDb["as"]>[1]) => db.as(ANON, fn) as Promise<T>;
const access = async () => ({ apiDomain: "https://x.pipedrive.com", accessToken: "t" });
/** Fehlercode (BookingError aus dem Dienst bzw. TB: aus der DB) */
const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as { code?: string })?.code ?? tbCode(e));
const jobs = () => db.admin<{ type: string; status: string }>("select type, status from pipedrive_jobs order by created_at");

beforeAll(async () => {
  db = await setupTestDb();
  const s = db.seed.find((x) => x.slug === "antennevorarlberg")!;
  tenant = { id: s.tenantId, slug: s.slug };
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenant.id])) as [{ id: string }];
  [{ id: slotId }] = (await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + interval '25 days', now() + interval '25 days 2 hours', 30) returning id`,
    [tenant.id, eventId],
  )) as [{ id: string }];
  eventToken = generateToken();
  await db.admin("update events set public_token_hash = $2 where id = $1", [eventId, hashToken(eventToken)]);
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin("delete from pipedrive_jobs");
  await db.admin("delete from email_outbox");
});

const book = (email: string, opts: { name?: string; organization?: string | null; token?: string } = {}) =>
  bookPublic(anon as never, tenant, {
    token: opts.token ?? eventToken,
    slotId,
    seats: 1,
    name: opts.name ?? "Paula Public",
    email,
    extraAttendees: [],
    guests: [],
    organization: opts.organization ?? null,
  });

describe("Öffentlicher Event-Link", () => {
  it("Mandant und Ansicht über den Link; unbekannter Link -> nichts", async () => {
    const t = await db.as(ANON, async (c) => (await c.query("select public.resolve_tenant_by_token($1) as t", [eventToken])).rows[0].t);
    expect(t.id).toBe(tenant.id);
    const ctx = await loadPublicEventContext(anon as never, tenant.id, eventToken);
    expect(ctx?.event.id).toBe(eventId);
    expect(ctx?.slots.some((s) => s.id === slotId && s.bookable)).toBe(true);
    expect(await loadPublicEventContext(anon as never, tenant.id, generateToken())).toBeNull();
  });

  it("bucht ohne Einladung: Einladung (public) mit eigenem Link, Bestätigung, einmal je E-Mail", async () => {
    const r = await book("paula@neu.example", { organization: "Neu GmbH" });
    expect(r.personalToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const [inv] = await db.admin<{ source: string; organization_name: string; created_by: string | null; email: string }>(
      "select source, organization_name, created_by, email from invitations where token_hash = $1",
      [hashToken(r.personalToken)],
    );
    expect(inv).toEqual({ source: "public", organization_name: "Neu GmbH", created_by: null, email: "paula@neu.example" });
    // persönlicher Link zeigt die Buchung
    const ctx = await db.as(ANON, async (c) => (await c.query("select public.get_invitation_context($1, $2) as r", [tenant.id, r.personalToken])).rows[0].r);
    expect(ctx.booking.id).toBe(r.bookingId);
    // zweite öffentliche Buchung derselben E-Mail -> already_booked
    expect(await codeOf(book("Paula@Neu.example"))).toBe("already_booked");
    // Pipedrive: erst zuordnen
    expect((await jobs()).map((j) => j.type)).toEqual(["link_contact"]);
  });

  it("falscher Link oder ungültige Eingaben -> Fehler", async () => {
    expect(await codeOf(book("x@y.example", { token: generateToken() }))).toBe("invitation_not_found");
    expect(await codeOf(book("keine-mail"))).toBe("invalid_email");
  });

  it("Dublettencheck: neuer Kontakt + Firma + Deal (eingestellte Phase), dann Aktivität am Deal", async () => {
    await db.admin("update tenants set new_deal_pipeline_id = 1, new_deal_stage_id = 12 where id = $1", [tenant.id]);
    const crm = new FakePipedriveCrm({});
    const r = await book("neu.kunde@firma.example", { name: "Nina Neu", organization: "Firma Neu" });
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.map((l) => l.op)).toEqual(["createOrganization", "createPerson", "createDeal"]);
    expect(crm.log[2]!.detail).toMatchObject({ title: "Firma Neu – Kunden-Workshop Radiowerbung", pipelineId: 1, stageId: 12 });
    const [inv] = await db.admin<{ pipedrive_person_id: string; pipedrive_deal_id: string }>(
      "select pipedrive_person_id::text, pipedrive_deal_id::text from invitations where token_hash = $1",
      [hashToken(r.personalToken)],
    );
    expect(inv!.pipedrive_person_id).toBeTruthy();
    expect(inv!.pipedrive_deal_id).toBeTruthy();
    // nächster Lauf: Aktivität am neuen Deal, Kunde als Gast
    await processPipedriveJobs(db.pool, { crm, access });
    const act = crm.log.find((l) => l.op === "createActivity")!;
    expect(act.detail).toMatchObject({
      deal_id: Number(inv!.pipedrive_deal_id),
      attendees: [{ email: "neu.kunde@firma.example", name: "Nina Neu", person_id: Number(inv!.pipedrive_person_id) }],
    });
  });

  it("Dublettencheck: bestehender Kontakt mit offenem Deal -> kein Anlegen", async () => {
    // Seed-Deal 1001 gehört zu Maria Muster
    const crm = new FakePipedriveCrm({ 1001: { title: "Bestand", person: { id: 5001, name: "Maria Muster", email: "maria.bestand@kunde.example" }, org: null } });
    const r = await book("Maria.Bestand@kunde.example", { name: "Maria Muster" });
    await processPipedriveJobs(db.pool, { crm, access });
    expect(crm.log.filter((l) => l.op.startsWith("create") && l.op !== "createActivity")).toEqual([]);
    const [inv] = await db.admin<{ pipedrive_person_id: string; pipedrive_deal_id: string }>(
      "select pipedrive_person_id::text, pipedrive_deal_id::text from invitations where token_hash = $1",
      [hashToken(r.personalToken)],
    );
    expect(inv).toEqual({ pipedrive_person_id: "5001", pipedrive_deal_id: "1001" });
  });

  it("Bestätigung geht über die System-Adresse, auch beim Weg „eigenes Postfach“", async () => {
    await db.admin("update tenants set mail_route = 'employee' where id = $1", [tenant.id]);
    try {
      await book("mail.test@kunde.example");
      const via: string[] = [];
      const factory: SenderFactory = (target: SenderTarget) => ({
        send: async () => {
          via.push(target.kind);
          return { messageId: "m" };
        },
      });
      const r = await processOutbox(db.pool, {
        senderFactory: factory,
        systemConfig: { transport: "dev", fromEmail: "termine@system.example", fromName: null },
      });
      expect(r.sent).toBe(1);
      expect(via).toEqual(["system"]);
    } finally {
      await db.admin("update tenants set mail_route = 'system' where id = $1", [tenant.id]);
    }
  });

  it("abgeschalteter Link: keine Ansicht, kein Buchen", async () => {
    await db.admin("update events set public_token_hash = null where id = $1", [eventId]);
    try {
      expect(await loadPublicEventContext(anon as never, tenant.id, eventToken)).toBeNull();
      expect(await codeOf(book("spaet@kunde.example"))).toBe("invitation_not_found");
    } finally {
      await db.admin("update events set public_token_hash = $2 where id = $1", [eventId, hashToken(eventToken)]);
    }
  });
});
