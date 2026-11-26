/**
 * Admins in Pipedrive werden automatisch Admin im Terminbuchungstool (neu
 * anlegen, sales anheben; gesperrt bleibt gesperrt, owner bleibt owner), auch
 * beim Panel und beim Laden der Nutzerverwaltung. Owner-Kontakt für den Hinweis
 * „Bitte wende dich an den Owner …“.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";
import type { PipedriveUser } from "@/lib/pipedrive/client";

let db: TestDb;
let sync: typeof import("@/lib/pipedrive/admin-sync");
let members: typeof import("@/lib/admin/members");
let panel: typeof import("@/lib/panel/session");
let tenant: { id: string; slug: string };
let owner: AdminContext;

const pd = (over: Partial<PipedriveUser> = {}): PipedriveUser => ({
  id: 7299001,
  name: "Petra Pipedrive",
  email: "petra@antenne-vorarlberg.example",
  isAdmin: true,
  active: true,
  ...over,
});
const member = async (pdId: number) =>
  (
    await db.admin<{ role: string; status: string }>(
      "select role::text, status::text from tenant_members where tenant_id = $1 and pipedrive_user_id = $2",
      [tenant.id, pdId],
    )
  )[0] ?? null;

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PIPEDRIVE_DIRECTORY = "fake";
  process.env.AUTH_ADMIN = "local";
  sync = await import("@/lib/pipedrive/admin-sync");
  members = await import("@/lib/admin/members");
  panel = await import("@/lib/panel/session");
  const s = db.seed.find((x) => x.slug === "antennevorarlberg")!;
  tenant = { id: s.tenantId, slug: s.slug };
  const [m] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 and role = 'owner'", [tenant.id]);
  owner = {
    tenant: { id: tenant.id, slug: tenant.slug, timezone: "Europe/Vienna" } as AdminContext["tenant"],
    userId: m!.user_id,
    actor: { role: "authenticated", userId: m!.user_id },
    role: "owner",
    name: null,
    email: null,
  };
});
afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

describe("Pipedrive-Admins werden automatisch Admin", () => {
  it("neu: auth-Benutzer + Mitgliedschaft admin/aktiv; offene Anfrage erledigt", async () => {
    await db.admin("select public.record_access_request($1, 7299001, 'Petra', 'petra@antenne-vorarlberg.example')", [tenant.id]);
    const uid = await sync.grantPipedriveAdmin(tenant.id, pd());
    expect(uid).toBeTruthy();
    expect(await member(7299001)).toEqual({ role: "admin", status: "active" });
    const [r] = await db.admin<{ status: string }>("select status from access_requests where tenant_id = $1 and pipedrive_user_id = 7299001", [tenant.id]);
    expect(r!.status).toBe("approved");
    // erneut: nichts doppelt
    expect(await sync.grantPipedriveAdmin(tenant.id, pd())).toBe(uid);
  });

  it("kein Admin oder inaktiv in Pipedrive: nichts", async () => {
    expect(await sync.grantPipedriveAdmin(tenant.id, pd({ id: 7299002, email: "x2@a.example", isAdmin: false }))).toBeNull();
    expect(await sync.grantPipedriveAdmin(tenant.id, pd({ id: 7299003, email: "x3@a.example", active: false }))).toBeNull();
    expect(await member(7299002)).toBeNull();
    expect(await member(7299003)).toBeNull();
  });

  it("sales wird admin; owner bleibt owner; gesperrt bleibt gesperrt", async () => {
    // Markus Fink (sales, 7200002) ist jetzt Admin in Pipedrive
    await sync.grantPipedriveAdmin(tenant.id, pd({ id: 7200002, name: "Markus Fink", email: "markus.fink@antenne-vorarlberg.example" }));
    expect(await member(7200002)).toEqual({ role: "admin", status: "active" });
    await sync.grantPipedriveAdmin(tenant.id, pd({ id: 7200001, name: "Sabine Leitner", email: "admin@antenne-vorarlberg.example" }));
    expect(await member(7200001)).toEqual({ role: "owner", status: "active" });
    await db.admin("update tenant_members set status = 'disabled' where tenant_id = $1 and pipedrive_user_id = 7299001", [tenant.id]);
    expect(await sync.grantPipedriveAdmin(tenant.id, pd())).toBeNull();
    expect(await member(7299001)).toEqual({ role: "admin", status: "disabled" });
    // zurücksetzen
    await db.admin("update tenant_members set role = 'sales' where tenant_id = $1 and pipedrive_user_id = 7200002", [tenant.id]);
  });

  it("Panel: Pipedrive-Admin ohne Mitgliedschaft bekommt direkt eine Sitzung", async () => {
    // Julia Bechter (7200003) ist im Seed Admin in Pipedrive, aber kein Mitglied
    expect(await member(7200003)).toBeNull();
    const r = await panel.startPanelSession({ userId: 7200003, companyId: 7100001, dealId: 1001, personId: null });
    expect(r.ok).toBe(true);
    expect(await member(7200003)).toEqual({ role: "admin", status: "active" });
    // kein Admin in Pipedrive: weiterhin kein Zugriff
    expect(await panel.startPanelSession({ userId: 7200004, companyId: 7100001, dealId: 1001, personId: null })).toMatchObject({ ok: false, error: "no_access" });
  });

  it("Nutzerverwaltung übernimmt alle aktiven Pipedrive-Admins", async () => {
    await db.admin("delete from tenant_members where tenant_id = $1 and pipedrive_user_id = 7200003", [tenant.id]);
    const team = await members.loadTeam(owner);
    expect(team.entries.find((e) => e.pipedrive?.id === 7200003)?.member).toMatchObject({ role: "admin", status: "active" });
    // Nicht-Admins bleiben ohne Zugriff
    expect(team.entries.find((e) => e.pipedrive?.id === 7200004)?.member).toBeNull();
  });
});

describe("Rolle von Hand festgelegt", () => {
  it("Owner stuft einen Pipedrive-Admin zu Vertrieb herab – bleibt so (Login, Nutzerverwaltung)", async () => {
    // Julia Bechter (7200003) ist Pipedrive-Admin und wurde oben automatisch Admin
    const [j] = await db.admin<{ user_id: string; role_manual: boolean }>(
      "select user_id, role_manual from tenant_members where tenant_id = $1 and pipedrive_user_id = 7200003",
      [tenant.id],
    );
    expect(j!.role_manual).toBe(false); // automatisch übernommen, nicht von Hand
    await members.updateMember(owner, j!.user_id, { role: "sales" });
    expect(await member(7200003)).toEqual({ role: "sales", status: "active" });
    await sync.grantPipedriveAdmin(tenant.id, pd({ id: 7200003, name: "Julia Bechter", email: "julia.bechter@antenne-vorarlberg.example" }));
    await members.loadTeam(owner);
    expect(await member(7200003)).toEqual({ role: "sales", status: "active" });
  });

  it("nur Rollenänderungen angemeldeter Benutzer zählen als „von Hand“", async () => {
    await db.admin("update tenant_members set role = 'sales', role_manual = false where tenant_id = $1 and pipedrive_user_id = 7200003", [tenant.id]);
    // Server-Job (ohne auth.uid()): automatisch angehoben, role_manual bleibt false
    await sync.grantPipedriveAdmin(tenant.id, pd({ id: 7200003, name: "Julia Bechter", email: "julia.bechter@antenne-vorarlberg.example" }));
    const [j] = await db.admin<{ role: string; role_manual: boolean }>(
      "select role::text, role_manual from tenant_members where tenant_id = $1 and pipedrive_user_id = 7200003",
      [tenant.id],
    );
    expect(j).toEqual({ role: "admin", role_manual: false });
  });
});

describe("Mindestens ein Owner", () => {
  it("der letzte aktive Owner kann weder herabgestuft noch gesperrt noch entfernt werden", async () => {
    const [o] = await db.admin<{ user_id: string }>("select user_id from tenant_members where tenant_id = $1 and role = 'owner'", [tenant.id]);
    // auch Server-Jobs nicht (Trigger in der Datenbank)
    await expect(db.admin("update tenant_members set role = 'admin' where tenant_id = $1 and user_id = $2", [tenant.id, o!.user_id])).rejects.toThrow(/TB:last_owner/);
    await expect(db.admin("update tenant_members set status = 'disabled' where tenant_id = $1 and user_id = $2", [tenant.id, o!.user_id])).rejects.toThrow(
      /TB:last_owner/,
    );
    await expect(db.admin("delete from tenant_members where tenant_id = $1 and user_id = $2", [tenant.id, o!.user_id])).rejects.toThrow(/TB:last_owner/);
  });
});

describe("Panel im Kontakt", () => {
  it("nur, wenn die Firma es eingeschaltet hat", async () => {
    const entry = { userId: 7200001, companyId: 7100001, dealId: null, personId: 5001 };
    expect(await panel.startPanelSession(entry)).toMatchObject({ ok: false, error: "person_disabled" });
    await db.admin("update tenants set panel_person_enabled = true where id = $1", [tenant.id]);
    try {
      const r = await panel.startPanelSession(entry);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.session).toMatchObject({ deal: null, person: 5001 });
    } finally {
      await db.admin("update tenants set panel_person_enabled = false where id = $1", [tenant.id]);
    }
  });
});

describe("Owner-Kontakt", () => {
  it("aktive Owner des Mandanten, sonst niemand", async () => {
    expect(await sync.ownerContacts(tenant.id)).toEqual(["admin@antenne-vorarlberg.example"]);
  });
});
