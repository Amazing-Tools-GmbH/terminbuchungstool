/**
 * Postfach verbinden: Rechte (save/test/trennen), Absenderwahl beim Versand
 * (Mitarbeiter-Postfach, sichtbarer Fallback auf das Firmenpostfach),
 * Testmail schaltet aktiv, Smart BCC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookSlot } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import { MailSendError, type MailConnection, type MailMessage } from "@/lib/mail/types";
import type { SenderFactory } from "@/lib/mail/senders";
import { setupTestDb, tbCode, type TestDb } from "./helpers";

let db: TestDb;
let tenantA: { id: string; slug: string };
let tenantB: string;
let owner: DbActor;
let sales: DbActor;
let salesId: string;
let ownerB: DbActor;
let eventId: string;
let slotId: string;

type Sent = { via: MailConnection; message: MailMessage };
let sent: Sent[] = [];
let failFor: { connectionId: string; error: MailSendError } | null = null;
const recorder: SenderFactory = (conn) => ({
  async send(message) {
    if (failFor && failFor.connectionId === conn.id) throw failFor.error;
    sent.push({ via: conn, message });
    return { messageId: `rec-${sent.length}` };
  },
});

async function expectTb(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(tbCode(err)).toBe(code);
}

beforeAll(async () => {
  db = await setupTestDb();
  const a = db.seed.find((s) => s.slug === "antennevorarlberg")!;
  tenantA = { id: a.tenantId, slug: a.slug };
  tenantB = db.seed.find((s) => s.slug === "demo")!.tenantId;
  const m = await db.admin<{ tenant_id: string; user_id: string; role: string }>("select tenant_id, user_id, role::text from tenant_members");
  owner = { role: "authenticated", userId: m.find((x) => x.tenant_id === tenantA.id && x.role === "owner")!.user_id };
  salesId = m.find((x) => x.tenant_id === tenantA.id && x.role === "sales")!.user_id;
  sales = { role: "authenticated", userId: salesId };
  ownerB = { role: "authenticated", userId: m.find((x) => x.tenant_id === tenantB && x.role === "owner")!.user_id };
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantA.id])) as [{ id: string }];
  [{ id: slotId }] = (await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + interval '20 days', now() + interval '20 days 2 hours', 1000) returning id`,
    [tenantA.id, eventId],
  )) as [{ id: string }];
});
afterAll(() => db?.close());

beforeEach(async () => {
  sent = [];
  failFor = null;
  await db.admin("delete from email_outbox");
  await db.admin("delete from mail_connections where scope = 'user'");
  await db.admin("update mail_connections set status = 'active', last_error = null");
  // Firmenpostfach des Seeds wiederherstellen (ein Test ersetzt es)
  await db.admin(
    "update mail_connections set provider = 'dev', sender_email = 'termine@antenne-vorarlberg.example', credentials_enc = null where tenant_id = $1 and scope = 'tenant'",
    [tenantA.id],
  );
  await db.admin("update tenants set smart_bcc_email = null");
});

const save = (actor: DbActor, tenantId: string, scope: "user" | "tenant", provider = "smtp", email = "x@firma.example") =>
  db.as(actor, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "select public.save_mail_connection($1, $2, $3, $4, 'X', 'v1:enc', 'scope-a') as id",
      [tenantId, scope, provider, email],
    );
    return rows[0]!.id;
  });

/** Buchung über eine Einladung, die `createdBy` angelegt hat */
async function bookInvitedBy(createdBy: string | null) {
  const token = generateToken();
  await db.admin(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at, created_by)
     values ($1, $2, $3, 'Eva Probe', 'eva@kunde.example', now() + interval '30 days', $4)`,
    [tenantA.id, eventId, hashToken(token), createdBy],
  );
  await bookSlot((fn) => db.as(ANON, fn), tenantA, { token, slotId, seats: 1, name: "Eva Probe", email: "eva@kunde.example", extraAttendees: [] });
}

const outboxRow = async () =>
  (await db.admin<{ status: string; last_error: string | null; sender_fallback_reason: string | null; mail_connection_id: string | null }>(
    "select status, last_error, sender_fallback_reason, mail_connection_id from email_outbox order by created_at desc limit 1",
  ))[0]!;

describe("Rechte", () => {
  it("Mitglied verbindet sein eigenes Postfach (pending, ohne lesbare Zugangsdaten)", async () => {
    const id = await save(sales, tenantA.id, "user", "smtp", "Markus@Firma.example");
    const [row] = await db.admin<{ user_id: string; status: string; sender_email: string; credentials_enc: string }>(
      "select user_id, status, sender_email, credentials_enc from mail_connections where id = $1",
      [id],
    );
    expect(row).toEqual({ user_id: salesId, status: "pending", sender_email: "markus@firma.example", credentials_enc: "v1:enc" });
    // erneut verbinden ersetzt dasselbe Postfach
    expect(await save(sales, tenantA.id, "user", "google", "neu@firma.example")).toBe(id);
  });

  it("Firmenpostfach nur owner/admin; nie fremder Mandant; kein dev-Postfach", async () => {
    await expectTb(save(sales, tenantA.id, "tenant"), "forbidden");
    await expectTb(save(ownerB, tenantA.id, "user"), "forbidden");
    await expectTb(save(owner, tenantA.id, "user", "dev"), "forbidden");
    await expectTb(save(ANON, tenantA.id, "user").catch((e) => {
      // anon darf die Funktion gar nicht aufrufen
      expect(e.code).toBe("42501");
      throw Object.assign(new Error("TB:forbidden"));
    }), "forbidden");
    const id = await save(owner, tenantA.id, "tenant", "smtp", "neu-firma@firma.example");
    const [row] = await db.admin<{ scope: string; status: string }>("select scope::text, status::text from mail_connections where id = $1", [id]);
    expect(row).toEqual({ scope: "tenant", status: "pending" });
  });

  it("Testmail anfordern und trennen: eigenes Postfach ja, fremdes nur owner/admin", async () => {
    const ownId = await save(sales, tenantA.id, "user");
    const [tenantConn] = await db.admin<{ id: string }>("select id from mail_connections where tenant_id = $1 and scope = 'tenant'", [tenantA.id]);
    await db.as(sales, (c) => c.query("select public.request_mail_test($1)", [ownId]));
    await expectTb(db.as(sales, (c) => c.query("select public.request_mail_test($1)", [tenantConn!.id])), "forbidden");
    await expectTb(db.as(ownerB, (c) => c.query("select public.request_mail_test($1)", [ownId])), "forbidden");

    const del = await db.as(sales, (c) => c.query("delete from mail_connections where id = $1", [tenantConn!.id]));
    expect(del.rowCount).toBe(0);
    const delOwn = await db.as(sales, (c) => c.query("delete from mail_connections where id = $1", [ownId]));
    expect(delOwn.rowCount).toBe(1);
  });

  it("Firmenpostfach-Adresse für alle Mitglieder sichtbar, nicht für Fremde", async () => {
    const mine = await db.as(sales, (c) => c.query("select * from public.get_tenant_mailbox($1)", [tenantA.id]));
    expect(mine.rows).toEqual([{ sender_email: "termine@antenne-vorarlberg.example", provider: "dev", status: "active" }]);
    const other = await db.as(ownerB, (c) => c.query("select * from public.get_tenant_mailbox($1)", [tenantA.id]));
    expect(other.rows).toEqual([]);
  });

  it("Smart BCC nur mit Pipedrive-Adresse; nur owner/admin", async () => {
    await db.as(owner, (c) => c.query("update tenants set smart_bcc_email = 'firma@pipedrivemail.com' where id = $1", [tenantA.id]));
    await expect(
      db.as(owner, (c) => c.query("update tenants set smart_bcc_email = 'mitlesen@evil.example' where id = $1", [tenantA.id])),
    ).rejects.toThrow(/check constraint/);
    const upd = await db.as(sales, (c) => c.query("update tenants set smart_bcc_email = null where id = $1", [tenantA.id]));
    expect(upd.rowCount).toBe(0);
  });
});

describe("Absender beim Versand", () => {
  it("Bestätigung geht über das aktive Postfach dessen, der eingeladen hat", async () => {
    const userConn = await save(sales, tenantA.id, "user", "smtp", "markus@firma.example");
    await db.admin("update mail_connections set status = 'active' where id = $1", [userConn]);
    await bookInvitedBy(salesId);
    expect((await processOutbox(db.pool, { senderFactory: recorder })).sent).toBe(1);
    expect(sent[0]!.via.id).toBe(userConn);
    expect(sent[0]!.message.from.email).toBe("markus@firma.example");
    expect((await outboxRow()).sender_fallback_reason).toBeNull();
  });

  it("gestörtes Mitarbeiter-Postfach: Bestätigung über das Firmenpostfach, sichtbar vermerkt", async () => {
    const userConn = await save(sales, tenantA.id, "user", "smtp", "markus@firma.example");
    await db.admin("update mail_connections set status = 'error' where id = $1", [userConn]);
    await bookInvitedBy(salesId);
    expect((await processOutbox(db.pool, { senderFactory: recorder })).sent).toBe(1);
    expect(sent[0]!.message.from.email).toBe("termine@antenne-vorarlberg.example");
    expect((await outboxRow()).sender_fallback_reason).toMatch(/markus@firma\.example war gestört – über das Firmenpostfach/);
  });

  it("Anmeldefehler beim Mitarbeiter-Postfach: Postfach -> error, Bestätigung sofort über Firmenpostfach", async () => {
    const userConn = await save(sales, tenantA.id, "user", "smtp", "markus@firma.example");
    await db.admin("update mail_connections set status = 'active' where id = $1", [userConn]);
    await bookInvitedBy(salesId);
    failFor = { connectionId: userConn, error: new MailSendError("auth", "Token entzogen") };
    expect((await processOutbox(db.pool, { senderFactory: recorder })).blocked).toBe(1);
    const [conn] = await db.admin<{ status: string }>("select status::text from mail_connections where id = $1", [userConn]);
    expect(conn!.status).toBe("error");
    // sofort wieder fällig -> nächster Lauf nimmt das Firmenpostfach
    expect((await processOutbox(db.pool, { senderFactory: recorder })).sent).toBe(1);
    expect(sent[0]!.message.from.email).toBe("termine@antenne-vorarlberg.example");
    expect((await outboxRow()).sender_fallback_reason).toMatch(/gestört/);
  });

  it("gesperrtes Mitglied: sein Postfach wird nicht mehr verwendet", async () => {
    const userConn = await save(sales, tenantA.id, "user");
    await db.admin("update mail_connections set status = 'active' where id = $1", [userConn]);
    await db.admin("update tenant_members set status = 'disabled' where user_id = $1", [salesId]);
    try {
      await bookInvitedBy(salesId);
      await processOutbox(db.pool, { senderFactory: recorder });
      expect(sent[0]!.message.from.email).toBe("termine@antenne-vorarlberg.example");
      expect((await outboxRow()).sender_fallback_reason).toBeNull();
    } finally {
      await db.admin("update tenant_members set status = 'active' where user_id = $1", [salesId]);
    }
  });

  it("Smart BCC in Kundenmails, nicht in Testmails", async () => {
    await db.admin("update tenants set smart_bcc_email = 'firma@pipedrivemail.com' where id = $1", [tenantA.id]);
    await bookInvitedBy(null);
    const id = await save(sales, tenantA.id, "user");
    await db.as(sales, (c) => c.query("select public.request_mail_test($1)", [id]));
    await processOutbox(db.pool, { senderFactory: recorder });
    const confirmation = sent.find((s) => s.message.subject.startsWith("Buchungsbestätigung"))!;
    const test = sent.find((s) => s.via.id === id)!;
    expect(confirmation.message.bcc).toEqual([{ email: "firma@pipedrivemail.com" }]);
    expect(test.message.bcc).toBeUndefined();
  });
});

describe("Testmail", () => {
  it("bestätigt ein neues Postfach (pending -> active)", async () => {
    const id = await save(sales, tenantA.id, "user", "smtp", "markus@firma.example");
    await db.as(sales, (c) => c.query("select public.request_mail_test($1)", [id]));
    expect((await processOutbox(db.pool, { senderFactory: recorder })).sent).toBe(1);
    expect(sent[0]!.message.to.email).toBe("markus@firma.example");
    const [conn] = await db.admin<{ status: string; last_verified_at: Date | null }>(
      "select status::text, last_verified_at from mail_connections where id = $1",
      [id],
    );
    expect(conn!.status).toBe("active");
    expect(conn!.last_verified_at).not.toBeNull();
  });

  it("Anmeldefehler: Postfach -> error mit Grund, Testmail fehlgeschlagen", async () => {
    const id = await save(sales, tenantA.id, "user");
    await db.as(sales, (c) => c.query("select public.request_mail_test($1)", [id]));
    failFor = { connectionId: id, error: new MailSendError("auth", "Passwort falsch") };
    expect((await processOutbox(db.pool, { senderFactory: recorder })).failed).toBe(1);
    const [conn] = await db.admin<{ status: string; last_error: string }>("select status::text, last_error from mail_connections where id = $1", [id]);
    expect(conn).toEqual({ status: "error", last_error: "Passwort falsch" });
  });
});
