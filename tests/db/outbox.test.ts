/**
 * Outbox: Bestätigungen über den System-Absender, Verhalten bei fehlender/
 * gestörter Konfiguration, Retry/Backoff und parallele Verarbeitung ohne
 * Doppelversand. (Einladungen/Wege: tests/db/mail-connect.test.ts)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { bookSlot } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import { MailSendError, type MailMessage, type MailSender } from "@/lib/mail/types";
import type { SenderFactory } from "@/lib/mail/senders";
import { setupTestDb, type TestDb } from "./helpers";

let db: TestDb;
let tenant: { id: string; slug: string };
let slotId: string;
let eventId: string;

class Recorder implements MailSender {
  sent: MailMessage[] = [];
  constructor(private readonly fail?: () => never) {}
  async send(m: MailMessage) {
    if (this.fail) this.fail();
    this.sent.push(m);
    return { messageId: `rec-${this.sent.length}` };
  }
}
const factory = (s: MailSender): SenderFactory => () => s;

beforeAll(async () => {
  db = await setupTestDb();
  const seeded = db.seed.find((s) => s.slug === "antennevorarlberg")!;
  tenant = { id: seeded.tenantId, slug: seeded.slug };
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenant.id])) as [{ id: string }];
  [{ id: slotId }] = (await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + interval '20 days', now() + interval '20 days 2 hours', 1000) returning id`,
    [tenant.id, eventId],
  )) as [{ id: string }];
});
afterAll(() => db?.close());

beforeEach(async () => {
  await db.admin("delete from email_outbox");
  await db.admin("update mail_connections set status = 'active', last_error = null");
});

async function bookNew(seats = 1) {
  const token = generateToken();
  await db.admin(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at)
     values ($1, $2, $3, 'Eva Probe', 'eva@kunde.example', now() + interval '30 days')`,
    [tenant.id, eventId, hashToken(token)],
  );
  const r = await bookSlot((fn) => db.as(ANON, fn), tenant, {
    token,
    slotId,
    seats,
    name: "Eva Probe",
    email: "eva@kunde.example",
    extraAttendees: [],
  });
  return { token, ...r };
}

const outbox = () =>
  db.admin<{ id: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date; rendered: unknown }>(
    "select * from email_outbox order by created_at",
  );

describe("Versand", () => {
  it("rendert und verschickt die Bestätigung mit .ics, ohne Link zum Ändern (Hinweis auf Ansprechpartner)", async () => {
    const { token } = await bookNew(2);
    const rec = new Recorder();
    const r = await processOutbox(db.pool, { senderFactory: factory(rec) });
    expect(r).toEqual({ sent: 1, failed: 0 });
    const m = rec.sent[0]!;
    // System-Absender, Anzeigename = Mandant
    expect(m.from).toEqual({ email: "termine@system.example", name: "ANTENNE VORARLBERG" });
    expect(m.to).toEqual({ email: "eva@kunde.example", name: "Eva Probe" });
    expect(m.subject).toMatch(/^Buchungsbestätigung: Kunden-Workshop Radiowerbung am /);
    expect(m.html).toContain("2 Personen");
    // kein Umbuchen/Stornieren über einen Link
    expect(m.html).not.toContain(`/b/${token}`);
    expect(m.text).not.toContain("nicht kommen"); // Hinweis optional, Standard leer
    expect(m.attachments?.[0]?.filename).toBe("termin-antennevorarlberg.ics");
    expect(m.attachments?.[0]?.content).toContain("BEGIN:VEVENT");
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("Buchungslink liegt in der Outbox nur verschlüsselt", async () => {
    const { token } = await bookNew();
    const [row] = await db.admin<{ payload: { link_enc: string } }>("select payload from email_outbox");
    expect(JSON.stringify(row!.payload)).not.toContain(token);
    expect(decryptSecret(row!.payload.link_enc)).toContain(`/b/${token}`);
  });

  it("System-Absender dev: speichert die gerenderte Mail für /dev/mails", async () => {
    await bookNew();
    await processOutbox(db.pool); // Standard-Factory, Seed nutzt provider = dev
    const [row] = await outbox();
    expect(row!.status).toBe("sent");
    expect((row!.rendered as MailMessage).subject).toMatch(/^Buchungsbestätigung/);
  });
});

const retry = (id: string) => db.admin("update email_outbox set status = 'queued', attempts = 0, next_attempt_at = now() where id = $1 and status = 'failed'", [id]);

describe("System-Absender gestört", () => {
  it("nicht konfiguriert: Mail fehlgeschlagen (system_mail), geht erst nach „Erneut versuchen“ raus", async () => {
    await bookNew();
    const rec = new Recorder();
    const r = await processOutbox(db.pool, { senderFactory: factory(rec), systemConfig: null });
    expect(r.failed).toBe(1);
    expect(rec.sent).toHaveLength(0);
    const [row] = await db.admin<{ id: string; status: string; error_code: string; last_error: string }>("select * from email_outbox");
    expect(row).toMatchObject({ status: "failed", error_code: "system_mail" });
    expect(row!.last_error).toMatch(/System-Absender nicht konfiguriert/);

    // kein automatischer neuer Versuch
    expect((await processOutbox(db.pool, { senderFactory: factory(rec) })).sent).toBe(0);
    // von Hand erneut versuchen -> geht raus
    await retry(row!.id);
    expect((await processOutbox(db.pool, { senderFactory: factory(rec) })).sent).toBe(1);
  });

  it("Anmeldefehler am System-SMTP: fehlgeschlagen (kein anderer Weg)", async () => {
    await bookNew();
    const rec = new Recorder(() => {
      throw new MailSendError("auth", "535 Authentication failed");
    });
    const r = await processOutbox(db.pool, { senderFactory: factory(rec) });
    expect(r.failed).toBe(1);
    const [row] = await db.admin<{ status: string; error_code: string; last_error: string }>("select * from email_outbox");
    expect(row).toMatchObject({ status: "failed", error_code: "system_mail" });
    expect(row!.last_error).toMatch(/System-Absender: 535/);
  });
});

describe("Kein automatischer neuer Versuch", () => {
  it("vorübergehender Fehler: sofort fehlgeschlagen, nach „Erneut versuchen“ Erfolg", async () => {
    await bookNew();
    const flaky = new Recorder(() => {
      throw new MailSendError("transient", "421 try later");
    });
    expect((await processOutbox(db.pool, { senderFactory: factory(flaky) })).failed).toBe(1);
    let [row] = await outbox();
    expect(row).toMatchObject({ status: "failed", last_error: "421 try later" });

    const ok = new Recorder();
    expect((await processOutbox(db.pool, { senderFactory: factory(ok) })).sent).toBe(0);
    await retry(row!.id);
    expect((await processOutbox(db.pool, { senderFactory: factory(ok) })).sent).toBe(1);
    [row] = await outbox();
    expect(row).toMatchObject({ status: "sent", attempts: 1, last_error: null });
  });

  it("dauerhafter Fehler: failed", async () => {
    await bookNew();
    const bounce = new Recorder(() => {
      throw new MailSendError("permanent", "550 no such user");
    });
    expect((await processOutbox(db.pool, { senderFactory: factory(bounce) })).failed).toBe(1);
    expect((await outbox()).map((r) => r.status)).toEqual(["failed"]);
  });

  it("hängengebliebene 'sending'-Einträge werden erneut versucht", async () => {
    await bookNew();
    await db.admin("update email_outbox set status = 'sending', locked_at = now() - interval '1 hour'");
    expect((await processOutbox(db.pool, { senderFactory: factory(new Recorder()) })).sent).toBe(1);
  });
});

describe("Parallelität", () => {
  it("parallele Verarbeiter versenden jede Mail genau einmal", async () => {
    for (let i = 0; i < 6; i++) await bookNew();
    const rec = new Recorder();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => processOutbox(db.pool, { senderFactory: factory(rec), limit: 3 })),
    );
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(6);
    expect(rec.sent).toHaveLength(6);
    expect((await outbox()).every((r) => r.status === "sent")).toBe(true);
  });

  it("verarbeitet nur Mails des angegebenen Mandanten", async () => {
    await bookNew();
    const other = db.seed.find((s) => s.slug === "demo")!.tenantId;
    const r = await processOutbox(db.pool, { senderFactory: factory(new Recorder()), tenantId: other });
    expect(r.sent).toBe(0);
  });
});
