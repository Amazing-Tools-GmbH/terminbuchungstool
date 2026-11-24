/**
 * Zugriffsanfragen: nicht freigeschaltete Pipedrive-Benutzer werden festgehalten,
 * Owner/Admins bekommen eine Mail; Freischalten schließt die Anfrage und
 * informiert den Benutzer. Eingebettete App-Einstellungen nur für owner/admin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";
import type { MailMessage, MailSender } from "@/lib/mail/types";

let db: TestDb;
let ar: typeof import("@/lib/access-requests");
let members: typeof import("@/lib/admin/members");
let appSettings: typeof import("@/lib/app-settings");
let outbox: typeof import("@/lib/mail/outbox");
let owner: AdminContext;
let tenant: { id: string; slug: string };

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PIPEDRIVE_DIRECTORY = "fake";
  process.env.AUTH_ADMIN = "local";
  ar = await import("@/lib/access-requests");
  members = await import("@/lib/admin/members");
  appSettings = await import("@/lib/app-settings");
  outbox = await import("@/lib/mail/outbox");
  const s = db.seed.find((x) => x.slug === "antennevorarlberg")!;
  tenant = { id: s.tenantId, slug: s.slug };
  const [m] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 and role = 'owner'", [tenant.id]);
  owner = { tenant: { id: tenant.id, slug: tenant.slug, timezone: "Europe/Vienna" } as AdminContext["tenant"], userId: m!.user_id, actor: { role: "authenticated", userId: m!.user_id }, role: "owner", name: null, email: null };
});
afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});
beforeEach(async () => {
  await db.admin("delete from email_outbox");
});

const mails = () => db.admin<{ type: string; to_email: string }>("select type::text, to_email from email_outbox order by to_email");

describe("Zugriffsanfrage", () => {
  it("neuer Benutzer: Anfrage + Mail an alle aktiven Owner/Admins, keine doppelte Mail", async () => {
    // Julia Bechter (Seed-Pipedrive-Benutzer ohne Zugriff); Name/E-Mail aus dem Verzeichnis
    expect(await ar.recordAccessRequest(tenant, 7200003)).toBe(true);
    const [r] = await db.admin<{ name: string; email: string; status: string }>(
      "select name, email, status from access_requests where tenant_id = $1 and pipedrive_user_id = 7200003",
      [tenant.id],
    );
    expect(r).toEqual({ name: "Julia Bechter", email: "julia.bechter@antenne-vorarlberg.example", status: "open" });
    const m = await mails();
    expect(m.length).toBeGreaterThanOrEqual(1);
    expect(m.every((x) => x.type === "access_request")).toBe(true);
    expect(m.map((x) => x.to_email)).toContain("admin@antenne-vorarlberg.example");
    // zweiter Versuch: keine neue Mail
    await db.admin("delete from email_outbox");
    expect(await ar.recordAccessRequest(tenant, 7200003)).toBe(false);
    expect(await mails()).toEqual([]);
  });

  it("Mitglieder (auch gesperrte) erzeugen keine Anfrage", async () => {
    expect(await ar.recordAccessRequest(tenant, 7200001)).toBe(false);
    expect(await ar.recordAccessRequest(tenant, 7200002)).toBe(false);
  });

  it("Mail an Owner/Admins mit Link zur Nutzerverwaltung", async () => {
    await db.admin("delete from access_requests");
    await ar.recordAccessRequest(tenant, 7200004, { name: "Thomas Moosbrugger", email: "thomas.moosbrugger@antenne-vorarlberg.example" });
    const sent: MailMessage[] = [];
    const rec: MailSender = { send: async (x) => (sent.push(x), { messageId: "x" }) };
    await outbox.processOutbox(db.pool, { senderFactory: () => rec });
    expect(sent[0]!.subject).toContain("Thomas Moosbrugger");
    expect(sent[0]!.html).toContain("/admin/benutzer");
    expect(sent[0]!.bcc).toBeUndefined();
  });

  it("Freischalten schließt die Anfrage und informiert den Benutzer", async () => {
    expect((await ar.listOpenAccessRequests(owner)).map((r) => r.pipedriveUserId)).toContain(7200004);
    await db.admin("delete from email_outbox");
    await members.enableMember(owner, 7200004, "sales");
    const [r] = await db.admin<{ status: string }>("select status from access_requests where pipedrive_user_id = 7200004");
    expect(r!.status).toBe("approved");
    expect(await mails()).toEqual([{ type: "access_granted", to_email: "thomas.moosbrugger@antenne-vorarlberg.example" }]);
  });

  it("Ablehnen: ohne Mail; sales sieht keine Anfragen", async () => {
    await ar.recordAccessRequest(tenant, 7200003);
    await db.admin("delete from email_outbox");
    expect(await ar.closeAccessRequest(owner, 7200003, false)).toBe(true);
    expect(await mails()).toEqual([]);
    const [s] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 and role = 'sales'", [tenant.id]);
    const sales = { ...owner, userId: s!.user_id, actor: { role: "authenticated" as const, userId: s!.user_id }, role: "sales" as const };
    expect(await ar.listOpenAccessRequests(sales)).toEqual([]);
    await expect(ar.closeAccessRequest(sales, 7200003, true)).rejects.toThrow(/TB:forbidden/);
  });
});

describe("App-Einstellungen in Pipedrive", () => {
  it("owner: Sitzung; sales: Hinweis; unbekannt: Anfrage", async () => {
    const o = await appSettings.startAppSettings({ userId: 7200001, companyId: 7100001 });
    expect(o.ok).toBe(true);
    const s = await appSettings.startAppSettings({ userId: 7200002, companyId: 7100001 });
    expect(s).toEqual({ ok: false, error: "sales" });
    await db.admin("delete from access_requests");
    const n = await appSettings.startAppSettings({ userId: 7200003, companyId: 7100001 });
    expect(n).toEqual({ ok: false, error: "access_requested" });
    expect(await db.admin("select 1 from access_requests where pipedrive_user_id = 7200003 and status = 'open'")).toHaveLength(1);
    expect(await appSettings.startAppSettings({ userId: 1, companyId: 999 })).toEqual({ ok: false, error: "not_connected" });
  });
});
