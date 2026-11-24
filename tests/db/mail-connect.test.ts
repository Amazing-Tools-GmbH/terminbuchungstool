/**
 * Versandwege: Rechte (Postfach speichern/testen/trennen, Signatur, Versandweg),
 * Weg "system" (System-Adresse, Reply-To = Einladender) und "employee" (alle
 * Kundenmails über das eigene Postfach, sonst verständlicher Fehlercode – kein
 * stiller Wechsel), Smart BCC, .ics, Testmail schaltet ein Postfach aktiv.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookSlot } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import { MailSendError, type MailMessage } from "@/lib/mail/types";
import type { SenderFactory, SenderTarget } from "@/lib/mail/senders";
import { encryptSecret } from "@/lib/crypto/secretbox";
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

type Sent = { via: SenderTarget; viaId: string; message: MailMessage };
let sent: Sent[] = [];
/** Fehler für ein Ziel: Postfach-ID oder "system" */
let failFor: { target: string; error: MailSendError } | null = null;
const targetId = (t: SenderTarget) => (t.kind === "connection" ? t.connection.id : t.kind);
const recorder: SenderFactory = (target) => ({
  async send(message) {
    if (failFor && failFor.target === targetId(target)) throw failFor.error;
    sent.push({ via: target, viaId: targetId(target), message });
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
  await db.admin("update tenants set smart_bcc_email = null, mail_route = 'system'");
  await db.admin("delete from pipedrive_user_connections");
  await db.admin("update tenant_members set mail_signature = null, status = 'active'");
});

const save = (actor: DbActor, tenantId: string, scope: "user" | "tenant", provider = "smtp", email = "x@firma.example") =>
  db.as(actor, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "select public.save_mail_connection($1, $2, $3, $4, 'X', 'v1:enc', 'scope-a') as id",
      [tenantId, scope, provider, email],
    );
    return rows[0]!.id;
  });

/** Einladung, die `createdBy` angelegt hat (mit Deal 501) */
async function createInvitation(createdBy: string | null) {
  const token = generateToken();
  const [inv] = await db.admin<{ id: string }>(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at, created_by, pipedrive_deal_id)
     values ($1, $2, $3, 'Eva Probe', 'eva@kunde.example', now() + interval '30 days', $4, 501) returning id`,
    [tenantA.id, eventId, hashToken(token), createdBy],
  );
  return { token, invitationId: inv!.id };
}

/** Einladungsmail in die Outbox legen (wie später das Pipedrive-Panel) */
async function queueInvitation(createdBy: string | null) {
  const { token, invitationId } = await createInvitation(createdBy);
  await db.admin(
    `insert into email_outbox (tenant_id, type, to_email, payload) values ($1, 'invitation', 'eva@kunde.example', $2)`,
    [tenantA.id, { invitation_id: invitationId, link_enc: encryptSecret(`https://termine.example/b/${token}`) }],
  );
  return token;
}

/** Buchung über eine Einladung, die `createdBy` angelegt hat */
async function bookInvitedBy(createdBy: string | null) {
  const { token } = await createInvitation(createdBy);
  await bookSlot((fn) => db.as(ANON, fn), tenantA, { token, slotId, seats: 1, name: "Eva Probe", email: "eva@kunde.example", extraAttendees: [] });
}

const outboxRow = async () =>
  (await db.admin<{ status: string; last_error: string | null; error_code: string | null; send_channel: string | null; mail_connection_id: string | null }>(
    "select status, last_error, error_code, send_channel, mail_connection_id from email_outbox order by created_at desc limit 1",
  ))[0]!;

const run = (opts: Parameters<typeof processOutbox>[1] = {}) => processOutbox(db.pool, { senderFactory: recorder, ...opts });

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

describe("Bestätigung/Stornierung: System-Absender", () => {
  it("System-Adresse, Reply-To = einladender Mitarbeiter, Smart BCC, .ics", async () => {
    await db.admin("update tenants set smart_bcc_email = 'firma@pipedrivemail.com' where id = $1", [tenantA.id]);
    await bookInvitedBy(salesId);
    expect((await run()).sent).toBe(1);
    const m = sent[0]!.message;
    expect(sent[0]!.viaId).toBe("system");
    expect(m.from).toEqual({ email: "termine@system.example", name: "ANTENNE VORARLBERG" });
    expect(m.replyTo).toEqual({ email: "markus.fink@antenne-vorarlberg.example", name: "Markus Fink" });
    expect(m.bcc).toEqual([{ email: "firma@pipedrivemail.com" }]);
    expect(m.attachments?.[0]?.filename).toMatch(/\.ics$/);
    expect((await outboxRow()).send_channel).toBe("system");
  });

  it("ohne Einladenden: Reply-To der Firma (falls gesetzt)", async () => {
    await db.admin("update tenants set reply_to_email = 'info@firma.example' where id = $1", [tenantA.id]);
    try {
      await bookInvitedBy(null);
      await run();
      expect(sent[0]!.message.replyTo).toEqual({ email: "info@firma.example", name: "ANTENNE VORARLBERG" });
    } finally {
      await db.admin("update tenants set reply_to_email = null where id = $1", [tenantA.id]);
    }
  });
});

describe("Weg System-Adresse: Einladung", () => {
  it("System-Adresse mit Namen des Mitarbeiters, Reply-To an ihn, Smart BCC, Signatur, Notiz im Deal", async () => {
    await db.admin("update tenants set smart_bcc_email = 'firma@pipedrivemail.com' where id = $1", [tenantA.id]);
    await db.as(sales, (c) => c.query("select public.set_my_mail_signature($1, $2)", [tenantA.id, "Markus Fink\nVertrieb <ANTENNE>\n0800 10 36 36"]));
    const token = await queueInvitation(salesId);
    expect((await run()).sent).toBe(1);
    const m = sent[0]!.message;
    expect(sent[0]!.viaId).toBe("system");
    expect(m.from).toEqual({ email: "termine@system.example", name: "Markus Fink" });
    expect(m.replyTo).toEqual({ email: "markus.fink@antenne-vorarlberg.example", name: "Markus Fink" });
    expect(m.bcc).toEqual([{ email: "firma@pipedrivemail.com" }]);
    expect(m.html).toContain(`/b/${token}`);
    // Signatur escaped und mit Zeilenumbrüchen
    expect(m.html).toContain("Markus Fink<br>Vertrieb &lt;ANTENNE&gt;<br>0800 10 36 36");
    expect(m.text).toContain("Vertrieb <ANTENNE>");
    expect((await outboxRow()).send_channel).toBe("smtp");
    const jobs = await db.admin<{ type: string }>("select type from pipedrive_jobs where tenant_id = $1 and type = 'invitation_note'", [tenantA.id]);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("gesperrter Einladender: Fehler statt Versand", async () => {
    await queueInvitation(salesId);
    await db.admin("update tenant_members set status = 'disabled' where user_id = $1", [salesId]);
    expect((await run()).failed).toBe(1);
    expect((await outboxRow()).error_code).toBe("no_inviter");
  });
});

describe("Weg eigenes Postfach (employee)", () => {
  beforeEach(async () => {
    await db.admin("update tenants set mail_route = 'employee' where id = $1", [tenantA.id]);
  });
  const activeMailbox = async () => {
    const id = await save(sales, tenantA.id, "user", "google", "markus@firma.example");
    await db.admin("update mail_connections set status = 'active' where id = $1", [id]);
    return id;
  };

  it("Einladung über das aktive eigene Postfach, mit Smart BCC", async () => {
    await db.admin("update tenants set smart_bcc_email = 'firma@pipedrivemail.com' where id = $1", [tenantA.id]);
    const id = await activeMailbox();
    await queueInvitation(salesId);
    expect((await run()).sent).toBe(1);
    expect(sent[0]!.viaId).toBe(id);
    expect(sent[0]!.message.from).toEqual({ email: "markus@firma.example", name: "X" });
    expect(sent[0]!.message.replyTo).toBeNull();
    expect(sent[0]!.message.bcc).toEqual([{ email: "firma@pipedrivemail.com" }]);
    expect(await outboxRow()).toMatchObject({ send_channel: "oauth", mail_connection_id: id });
  });

  it("Bestätigung ebenfalls über das eigene Postfach, mit .ics (Organisator = Mitarbeiter) und Smart BCC", async () => {
    await db.admin("update tenants set smart_bcc_email = 'firma@pipedrivemail.com' where id = $1", [tenantA.id]);
    const id = await activeMailbox();
    await bookInvitedBy(salesId);
    expect((await run()).sent).toBe(1);
    const m = sent[0]!.message;
    expect(sent[0]!.viaId).toBe(id);
    expect(m.from.email).toBe("markus@firma.example");
    expect(m.bcc).toEqual([{ email: "firma@pipedrivemail.com" }]);
    const ics = m.attachments?.[0];
    expect(ics?.filename).toMatch(/\.ics$/);
    expect(String(ics?.content)).toMatch(/ORGANIZER[^\r\n]*mailto:markus@firma\.example/i);
    expect(await outboxRow()).toMatchObject({ send_channel: "oauth", mail_connection_id: id });
  });

  it("ohne eigenes Postfach: Einladung und Bestätigung scheitern sichtbar, KEIN Wechsel auf die System-Adresse", async () => {
    await queueInvitation(salesId);
    expect((await run()).failed).toBe(1);
    expect((await outboxRow()).error_code).toBe("no_user_mailbox");
    await db.admin("delete from email_outbox");
    await bookInvitedBy(salesId);
    expect((await run()).failed).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await outboxRow()).error_code).toBe("no_user_mailbox");
  });

  it("gestörtes Postfach -> Meldung, kein Wechsel", async () => {
    const id = await save(sales, tenantA.id, "user", "google");
    await db.admin("update mail_connections set status = 'error' where id = $1", [id]);
    await bookInvitedBy(salesId);
    expect((await run()).failed).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await outboxRow()).error_code).toBe("user_mailbox_error");
  });

  it("Anmeldefehler beim Senden: Postfach gestört, Mail mit Meldung", async () => {
    const id = await activeMailbox();
    await bookInvitedBy(salesId);
    failFor = { target: id, error: new MailSendError("auth", "invalid_grant") };
    expect((await run()).failed).toBe(1);
    expect((await outboxRow()).error_code).toBe("user_mailbox_error");
    const [c] = await db.admin<{ status: string }>("select status::text from mail_connections where id = $1", [id]);
    expect(c!.status).toBe("error");
  });

  it("Zugriffsanfragen gehen weiterhin über die System-Adresse", async () => {
    await db.admin("select public.record_access_request($1, 99887766, 'Neu Ling', 'neu@firma.example')", [tenantA.id]);
    const r = await run();
    expect(r.sent).toBeGreaterThan(0);
    expect(sent.every((x) => x.viaId === "system")).toBe(true);
    await db.admin("delete from access_requests where pipedrive_user_id = 99887766");
  });
});

describe("Versandweg einstellen", () => {
  it("owner/admin dürfen, sales nicht; nur gültige Werte", async () => {
    await db.as(owner, (c) => c.query("update tenants set mail_route = 'employee' where id = $1", [tenantA.id]));
    const [t] = await db.admin<{ mail_route: string }>("select mail_route from tenants where id = $1", [tenantA.id]);
    expect(t!.mail_route).toBe("employee");
    const upd = await db.as(sales, (c) => c.query("update tenants set mail_route = 'system' where id = $1", [tenantA.id]));
    expect(upd.rowCount).toBe(0);
    await expect(db.as(owner, (c) => c.query("update tenants set mail_route = 'pipedrive' where id = $1", [tenantA.id]))).rejects.toThrow(/check constraint/);
    const other = await db.as(ownerB, (c) => c.query("update tenants set mail_route = 'system' where id = $1", [tenantA.id]));
    expect(other.rowCount).toBe(0);
  });
});

describe("Signatur", () => {
  it("nur die eigene, nur als aktives Mitglied", async () => {
    await db.as(sales, (c) => c.query("select public.set_my_mail_signature($1, $2)", [tenantA.id, "  Gruß Markus  "]));
    const [m] = await db.admin<{ mail_signature: string }>("select mail_signature from tenant_members where user_id = $1", [salesId]);
    expect(m!.mail_signature).toBe("Gruß Markus");
    await expectTb(db.as(ownerB, (c) => c.query("select public.set_my_mail_signature($1, 'x')", [tenantA.id])), "forbidden");
    await expect(db.as(ANON, (c) => c.query("select public.set_my_mail_signature($1, 'x')", [tenantA.id]))).rejects.toThrow(/permission denied/);
  });
});

describe("Testmail", () => {
  it("bestätigt ein neues Postfach (pending -> active)", async () => {
    const id = await save(sales, tenantA.id, "user", "smtp", "markus@firma.example");
    await db.as(sales, (c) => c.query("select public.request_mail_test($1)", [id]));
    expect((await processOutbox(db.pool, { senderFactory: recorder })).sent).toBe(1);
    expect(sent[0]!.message.to.email).toBe("markus@firma.example");
    expect(sent[0]!.viaId).toBe(id);
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
    failFor = { target: id, error: new MailSendError("auth", "Passwort falsch") };
    expect((await processOutbox(db.pool, { senderFactory: recorder })).failed).toBe(1);
    const [conn] = await db.admin<{ status: string; last_error: string }>("select status::text, last_error from mail_connections where id = $1", [id]);
    expect(conn).toEqual({ status: "error", last_error: "Passwort falsch" });
  });
});
