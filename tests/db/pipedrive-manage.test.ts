/**
 * Admin → Pipedrive-Verbindung: Status, Trennen, Neu-Verbinden (gleiche oder
 * andere Firma) – nur Owner, Firma nicht doppelt, E-Mail muss passen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";
import type { PipedriveMe, PipedriveTokens } from "@/lib/pipedrive/client";

let db: TestDb;
let manage: typeof import("@/lib/pipedrive/manage");
let owner: AdminContext;
let sales: AdminContext;
let ownerEmail: string;
let tenantId: string;
let otherTenant: string;

const tokens = (n: string): PipedriveTokens => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresAt: new Date(Date.now() + 3600_000),
  scope: "base,deals:full",
  apiDomain: "https://firma.pipedrive.com",
});
const me = (over: Partial<PipedriveMe> = {}): PipedriveMe => ({
  id: 9900001,
  name: "Olga Owner",
  email: ownerEmail,
  isAdmin: true,
  active: true,
  companyId: 9100001,
  companyDomain: "andere-firma",
  companyName: "Andere Firma",
  ...over,
});

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PIPEDRIVE_CLIENT_ID = "";
  manage = await import("@/lib/pipedrive/manage");
  tenantId = db.seed.find((s) => s.slug === "antennevorarlberg")!.tenantId;
  otherTenant = db.seed.find((s) => s.slug === "demo")!.tenantId;
  const m = await db.admin<{ user_id: string; role: "owner" | "sales"; email: string }>(
    `select m.user_id, m.role::text as role, u.email from tenant_members m join auth.users u on u.id = m.user_id
      where m.tenant_id = $1 and m.status = 'active'`,
    [tenantId],
  );
  const tenant = { id: tenantId, timezone: "Europe/Vienna" } as AdminContext["tenant"];
  const ctx = (role: "owner" | "sales"): AdminContext => {
    const userId = m.find((x) => x.role === role)!.user_id;
    return { tenant, userId, actor: { role: "authenticated", userId }, role, name: null, email: null };
  };
  owner = ctx("owner");
  sales = ctx("sales");
  ownerEmail = m.find((x) => x.role === "owner")!.email;
  // Ausgangslage: beide Mandanten sind verbunden
  for (const [i, t] of [tenantId, otherTenant].entries()) {
    await db.admin(
      `insert into pipedrive_connections (tenant_id, company_id, company_domain, api_domain, access_token_enc, refresh_token_enc, expires_at)
       values ($1, $2, $3, 'https://x.pipedrive.com', 'v1:a:b:c', 'v1:a:b:c', now() + interval '1 hour')
       on conflict (tenant_id) do nothing`,
      [t, 7000 + i, `firma${i}`],
    );
  }
});

afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

const conn = async () =>
  (await db.admin<{ status: string; company_id: string; access_token_enc: string }>(
    "select status, company_id::text, access_token_enc from pipedrive_connections where tenant_id = $1",
    [tenantId],
  ))[0]!;

describe("Pipedrive-Verbindung im Admin", () => {
  it("Status für owner, nicht für sales", async () => {
    const s = await manage.loadConnectionStatus(owner);
    expect(s).toMatchObject({ status: "active", companyId: 7000, companyDomain: "firma0", companyUrl: "https://firma0.pipedrive.com" });
    await expect(manage.loadConnectionStatus(sales)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("Trennen: nur owner, Tokens weg, Status revoked", async () => {
    await expect(manage.disconnectPipedrive(sales)).rejects.toMatchObject({ code: "forbidden" });
    await manage.disconnectPipedrive(owner);
    expect(await conn()).toMatchObject({ status: "revoked", access_token_enc: "" });
    await expect(manage.disconnectPipedrive(owner)).rejects.toMatchObject({ code: "pipedrive_not_connected" });
  });

  it("Neu verbinden: Firma eines anderen aktiven Mandanten ist tabu, E-Mail muss passen", async () => {
    expect(await manage.relinkFromOAuth(tenantId, owner.userId, me({ companyId: 7001 }), tokens("x"))).toEqual({ ok: false, error: "company_in_use" });
    expect(await manage.relinkFromOAuth(tenantId, owner.userId, me({ email: "fremd@x.example" }), tokens("x"))).toEqual({ ok: false, error: "email_mismatch" });
    expect(await manage.relinkFromOAuth(tenantId, sales.userId, me(), tokens("x"))).toEqual({ ok: false, error: "forbidden" });
    expect((await conn()).status).toBe("revoked");
  });

  it("andere Firma: umhängen, Owner verknüpft, übrige Mitglieder ohne Pipedrive-Zuordnung", async () => {
    const r = await manage.relinkFromOAuth(tenantId, owner.userId, me(), tokens("neu"));
    expect(r).toEqual({ ok: true, changedCompany: true });
    expect(await conn()).toMatchObject({ status: "active", company_id: "9100001" });
    const members = await db.admin<{ user_id: string; pipedrive_user_id: string | null }>(
      "select user_id, pipedrive_user_id::text from tenant_members where tenant_id = $1",
      [tenantId],
    );
    for (const m of members) expect(m.pipedrive_user_id).toBe(m.user_id === owner.userId ? "9900001" : null);
    const uc = await db.admin<{ user_id: string }>("select user_id from pipedrive_user_connections where tenant_id = $1", [tenantId]);
    expect(uc.map((u) => u.user_id)).toEqual([owner.userId]);
    // gleiche Firma noch einmal: nur erneuern
    expect(await manage.relinkFromOAuth(tenantId, owner.userId, me(), tokens("neu2"))).toEqual({ ok: true, changedCompany: false });
  });
});
