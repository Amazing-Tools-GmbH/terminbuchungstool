/**
 * Phase 4: Installation der Pipedrive-App (neuer Mandant, Neuinstallation,
 * Slug-Kollision) und Deinstallation (Verbindung deaktiviert, Daten bleiben).
 * Läuft über den App-Pool -> zeigt ausdrücklich auf die lokale Testdatenbank.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { PipedriveMe, PipedriveTokens } from "@/lib/pipedrive/client";

let db: TestDb;
let install: typeof import("@/lib/pipedrive/install");
let connection: typeof import("@/lib/pipedrive/connection");

const tokens = (n: string): PipedriveTokens => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresAt: new Date(Date.now() + 3600_000),
  scope: "base,deals:full",
  apiDomain: "https://neuefirma.pipedrive.com",
});
const me = (over: Partial<PipedriveMe> = {}): PipedriveMe => ({
  id: 8800001,
  name: "Ines Installer",
  email: "ines@neuefirma.example",
  isAdmin: true,
  active: true,
  companyId: 8100001,
  companyDomain: "neuefirma",
  companyName: "Neue Firma GmbH",
  timezone: "Europe/Berlin",
  ...over,
});

beforeAll(async () => {
  db = await setupTestDb();
  // App-Code (withActor/getPool) gegen die Testdatenbank, nie gegen Supabase
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.AUTH_ADMIN = "local";
  install = await import("@/lib/pipedrive/install");
  connection = await import("@/lib/pipedrive/connection");
});

afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

describe("Pipedrive-Installation", () => {
  it("neue Firma: Mandant, Verbindung, Installierende:r ist Owner", async () => {
    const r = await install.installFromOAuth(me(), tokens("1"));
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) return;
    const [t] = await db.admin<{ slug: string; name: string; timezone: string; anrede: string }>(
      "select slug, name, timezone, anrede::text from tenants where id = $1",
      [r.session.tid],
    );
    expect(t).toEqual({ slug: "neuefirma", name: "Neue Firma GmbH", timezone: "Europe/Berlin", anrede: "sie" });
    const [m] = await db.admin<{ role: string; status: string; pipedrive_user_id: string; user_id: string }>(
      "select role::text, status::text, pipedrive_user_id::text, user_id from tenant_members where tenant_id = $1",
      [r.session.tid],
    );
    expect(m).toMatchObject({ role: "owner", status: "active", pipedrive_user_id: "8800001", user_id: r.session.uid });
    const [c] = await db.admin<{ status: string; access_token_enc: string }>(
      "select status, access_token_enc from pipedrive_connections where tenant_id = $1",
      [r.session.tid],
    );
    expect(c!.status).toBe("active");
    expect(c!.access_token_enc).not.toContain("access-1");
    // Benutzer-Tokens für den Versand über Pipedrive
    const [u] = await db.admin<{ n: string }>("select count(*)::text as n from pipedrive_user_connections where tenant_id = $1", [r.session.tid]);
    expect(u!.n).toBe("1");
    expect(await connection.tenantIdForCompany(8100001)).toBe(r.session.tid);
  });

  it("Neuinstallation: gleicher Mandant, neue Tokens, keine Datenänderung", async () => {
    const before = await connection.tenantIdForCompany(8100001);
    const r = await install.installFromOAuth(me({ companyName: "Umbenannt" }), tokens("2"));
    expect(r).toMatchObject({ ok: true, created: false });
    if (!r.ok) return;
    expect(r.session.tid).toBe(before);
    const [t] = await db.admin<{ name: string }>("select name from tenants where id = $1", [before]);
    expect(t!.name).toBe("Neue Firma GmbH");
  });

  it("Neuinstallation durch Nicht-Mitglied (kein Pipedrive-Admin): Tokens erneuert, aber kein Zugriff", async () => {
    const r = await install.installFromOAuth(me({ id: 8800002, email: "fremd@neuefirma.example", name: "Fremd", isAdmin: false }), tokens("3"));
    expect(r).toMatchObject({ ok: false, error: "no_access", created: false });
    if (r.ok) return;
    const [req] = await db.admin<{ status: string }>("select status from access_requests where tenant_id = $1 and pipedrive_user_id = 8800002", [r.tid]);
    expect(req!.status).toBe("open");
  });

  it("Neuinstallation durch einen Pipedrive-Admin: automatisch Admin, offene Anfrage erledigt", async () => {
    // erst als Nicht-Admin (Anfrage), dann ist er in Pipedrive Admin geworden
    const first = await install.installFromOAuth(me({ id: 8800009, email: "pd.admin@neuefirma.example", name: "PD Admin", isAdmin: false }), tokens("3b"));
    expect(first.ok).toBe(false);
    const r = await install.installFromOAuth(me({ id: 8800009, email: "pd.admin@neuefirma.example", name: "PD Admin" }), tokens("3c"));
    expect(r).toMatchObject({ ok: true, created: false });
    if (!r.ok) return;
    const [m] = await db.admin<{ role: string; status: string }>("select role::text, status::text from tenant_members where tenant_id = $1 and user_id = $2", [
      r.session.tid,
      r.session.uid,
    ]);
    expect(m).toEqual({ role: "admin", status: "active" });
    const [req] = await db.admin<{ status: string }>("select status from access_requests where tenant_id = $1 and pipedrive_user_id = 8800009", [r.session.tid]);
    expect(req!.status).toBe("approved");
  });

  it("vorbereiteter Mandant mit gleichem Slug (nie verbunden) wird übernommen", async () => {
    const [before] = await db.admin<{ id: string; name: string; theme: unknown; timezone: string }>(
      "select id, name, theme, timezone from tenants where slug = 'demo'",
    );
    const membersBefore = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1", [before!.id]);
    const r = await install.installFromOAuth(
      me({ companyId: 8100002, id: 8800003, email: "x@demo.example", companyDomain: "demo", companyName: "Anderer Name", timezone: "Europe/Berlin" }),
      tokens("4"),
    );
    expect(r).toMatchObject({ ok: true, created: false, adopted: true });
    if (!r.ok) return;
    expect(r.session.tid).toBe(before!.id);
    // Daten bleiben unverändert
    const [after] = await db.admin<{ name: string; theme: unknown; timezone: string }>("select name, theme, timezone from tenants where id = $1", [before!.id]);
    expect(after).toEqual({ name: before!.name, theme: before!.theme, timezone: before!.timezone });
    const members = await db.admin<{ user_id: string; role: string; status: string }>(
      "select user_id, role::text, status::text from tenant_members where tenant_id = $1",
      [before!.id],
    );
    expect(members).toHaveLength(membersBefore.length + 1);
    expect(members.find((m) => m.user_id === r.session.uid)).toMatchObject({ role: "owner", status: "active" });
    expect(await connection.tenantIdForCompany(8100002)).toBe(before!.id);
  });

  it("Mandant war schon einmal verbunden: keine Übernahme, neuer Mandant mit Zähler; ungültige Zeitzone -> Standard", async () => {
    await install.uninstallCompany(8100002);
    const r = await install.installFromOAuth(
      me({ companyId: 8100004, id: 8800005, email: "z@demo.example", companyDomain: "demo", companyName: undefined, timezone: "Mars/Olympus" }),
      tokens("7"),
    );
    expect(r).toMatchObject({ ok: true, created: true, adopted: false });
    if (!r.ok) return;
    const [t] = await db.admin<{ slug: string; name: string; timezone: string }>("select slug, name, timezone from tenants where id = $1", [r.session.tid]);
    expect(t).toEqual({ slug: "demo-2", name: "demo", timezone: "Europe/Vienna" });
  });

  it("Domain von einer anderen Firma übernommen: Installation klappt, alte Zuordnung wird freigegeben", async () => {
    const r = await install.installFromOAuth(me({ companyId: 8100003, id: 8800004, email: "y@neu.example" }), tokens("6"));
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) return;
    const [t] = await db.admin<{ slug: string }>("select slug from tenants where id = $1", [r.session.tid]);
    expect(t!.slug).toBe("neuefirma-2");
    const rows = await db.admin<{ company_id: string; company_domain: string }>(
      "select company_id::text, company_domain from pipedrive_connections where company_id in (8100001, 8100003) order by company_id",
    );
    expect(rows).toEqual([
      { company_id: "8100001", company_domain: "neuefirma~8100001" },
      { company_id: "8100003", company_domain: "neuefirma" },
    ]);
  });

  it("Login hält die Domain aktuell", async () => {
    await install.syncCompanyDomain(8100001, "neuefirma");
    const rows = await db.admin<{ company_id: string; company_domain: string }>(
      "select company_id::text, company_domain from pipedrive_connections where company_id in (8100001, 8100003) order by company_id",
    );
    expect(rows).toEqual([
      { company_id: "8100001", company_domain: "neuefirma" },
      { company_id: "8100003", company_domain: "neuefirma~8100003" },
    ]);
  });

  it("Adresse in Pipedrive geändert: wird bei der Token-Erneuerung nachgezogen", async () => {
    const { userPipedriveAccess } = await import("@/lib/pipedrive/user-connection");
    const { getPool } = await import("@/lib/db/pool");
    const tid = (await connection.tenantIdForCompany(8100001))!;
    const [u] = await db.admin<{ user_id: string }>("select user_id from pipedrive_user_connections where tenant_id = $1 limit 1", [tid]);
    await db.admin("update pipedrive_user_connections set expires_at = now() - interval '1 minute' where tenant_id = $1", [tid]);
    vi.stubEnv("PIPEDRIVE_CLIENT_ID", "cid");
    vi.stubEnv("PIPEDRIVE_CLIENT_SECRET", "csecret");
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "a-neu", refresh_token: "r-neu", expires_in: 3600, api_domain: "https://umbenannt.pipedrive.com" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const a = await userPipedriveAccess(getPool(), tid, u!.user_id);
      expect(a).toEqual({ apiDomain: "https://umbenannt.pipedrive.com", accessToken: "a-neu" });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    const [c] = await db.admin<{ company_domain: string }>("select company_domain from pipedrive_connections where tenant_id = $1", [tid]);
    expect(c!.company_domain).toBe("umbenannt");
    // Mandant und Slug bleiben gleich
    expect(await connection.tenantIdForCompany(8100001)).toBe(tid);
    const [t] = await db.admin<{ slug: string }>("select slug from tenants where id = $1", [tid]);
    expect(t!.slug).toBe("neuefirma");
    await install.syncCompanyDomain(8100001, "neuefirma");
  });

  it("Deinstallation: Verbindung revoked, Daten bleiben; erneute Installation reaktiviert", async () => {
    const tid = await connection.tenantIdForCompany(8100001);
    expect(await install.uninstallCompany(8100001)).toBe(true);
    expect(await install.uninstallCompany(8100001)).toBe(false);
    expect(await connection.tenantIdForCompany(8100001)).toBeNull();
    const [t] = await db.admin<{ n: string }>("select count(*)::text as n from tenant_members where tenant_id = $1", [tid]);
    expect(t!.n).toBe("2"); // Owner + automatisch übernommener Pipedrive-Admin
    const [u] = await db.admin<{ status: string }>("select status::text from pipedrive_user_connections where tenant_id = $1", [tid]);
    expect(u!.status).toBe("error");
    const r = await install.installFromOAuth(me(), tokens("5"));
    expect(r).toMatchObject({ ok: true, created: false });
    expect(await connection.tenantIdForCompany(8100001)).toBe(tid);
  });
});
