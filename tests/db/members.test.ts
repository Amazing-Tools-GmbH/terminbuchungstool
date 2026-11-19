/**
 * Phase 3: Nutzerverwaltung (Freischalten/Sperren, Rollen), "mindestens ein
 * owner", Kapazitätsprüfung und die Server-Funktionen für den Pipedrive-Login.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { setupTestDb, tbCode, type TestDb } from "./helpers";

let db: TestDb;
let tenantA: string;
let tenantB: string;
let ownerA: DbActor;
let ownerB: DbActor;
let salesA: DbActor;
let salesAId: string;
let adminA: DbActor;
let adminAId: string;

async function newUser(email: string): Promise<string> {
  const [u] = await db.admin<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return u!.id;
}

async function expectTb(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(tbCode(err)).toBe(code);
}

async function expectDenied(p: Promise<unknown>) {
  const err = (await p.then(() => null, (e: unknown) => e)) as { code?: string; message?: string } | null;
  expect(err, "Zugriff hätte verweigert werden müssen").not.toBeNull();
  // 42501 = insufficient_privilege bzw. RLS-Verletzung
  expect(err!.code).toBe("42501");
}

beforeAll(async () => {
  db = await setupTestDb();
  const tenants = await db.admin<{ id: string; slug: string }>("select id, slug from tenants");
  tenantA = tenants.find((t) => t.slug === "antennevorarlberg")!.id;
  tenantB = tenants.find((t) => t.slug === "demo")!.id;
  const owners = await db.admin<{ tenant_id: string; user_id: string }>(
    "select tenant_id, user_id from tenant_members where role = 'owner'",
  );
  ownerA = { role: "authenticated", userId: owners.find((m) => m.tenant_id === tenantA)!.user_id };
  ownerB = { role: "authenticated", userId: owners.find((m) => m.tenant_id === tenantB)!.user_id };
  const [s] = await db.admin<{ user_id: string }>(
    "select user_id from tenant_members where tenant_id = $1 and role = 'sales'",
    [tenantA],
  );
  salesAId = s!.user_id;
  salesA = { role: "authenticated", userId: salesAId };
  adminAId = await newUser("admin-test@a.example");
  await db.admin("insert into tenant_members (tenant_id, user_id, role, pipedrive_user_id) values ($1, $2, 'admin', 990001)", [
    tenantA,
    adminAId,
  ]);
  adminA = { role: "authenticated", userId: adminAId };
});

afterAll(async () => {
  await db?.close();
});

describe("Freischalten und Sperren", () => {
  it("ein gesperrtes Mitglied verliert sofort jeden Zugriff", async () => {
    const before = await db.as(salesA, (c) => c.query("select id from events"));
    expect(before.rowCount).toBeGreaterThan(0);

    await db.as(ownerA, (c) => c.query("update tenant_members set status = 'disabled' where user_id = $1", [salesAId]));
    const events = await db.as(salesA, (c) => c.query("select id from events"));
    const team = await db.as(salesA, (c) => c.query("select user_id from tenant_members"));
    expect(events.rowCount).toBe(0);
    expect(team.rowCount).toBe(0);

    await db.as(ownerA, (c) => c.query("update tenant_members set status = 'active' where user_id = $1", [salesAId]));
    const again = await db.as(salesA, (c) => c.query("select id from events"));
    expect(again.rowCount).toBeGreaterThan(0);
  });

  it("owner schaltet einen neuen Benutzer frei", async () => {
    const uid = await newUser("neu@a.example");
    await db.as(ownerA, (c) =>
      c.query(
        `insert into tenant_members (tenant_id, user_id, role, pipedrive_user_id, display_name, email)
         values ($1, $2, 'sales', 990002, 'Neu', 'neu@a.example')`,
        [tenantA, uid],
      ),
    );
    const rows = await db.admin("select 1 from tenant_members where user_id = $1 and status = 'active'", [uid]);
    expect(rows).toHaveLength(1);
  });

  it("sales darf niemanden freischalten oder ändern", async () => {
    const uid = await newUser("sales-versuch@a.example");
    await expectDenied(
      db.as(salesA, (c) => c.query("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'sales')", [tenantA, uid])),
    );
    const upd = await db.as(salesA, (c) => c.query("update tenant_members set role = 'admin' where user_id = $1", [salesAId]));
    expect(upd.rowCount).toBe(0);
  });

  it("Mitglied von A kann niemanden in B freischalten", async () => {
    const uid = await newUser("fremd@b.example");
    await expectDenied(
      db.as(ownerA, (c) => c.query("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')", [tenantB, uid])),
    );
    const upd = await db.as(ownerA, (c) => c.query("update tenant_members set status = 'disabled' where tenant_id = $1", [tenantB]));
    expect(upd.rowCount).toBe(0);
  });

  it("user_id und pipedrive_user_id sind nach dem Anlegen nicht änderbar", async () => {
    await expectDenied(
      db.as(ownerA, (c) => c.query("update tenant_members set user_id = $1 where user_id = $2", [adminAId, salesAId])),
    );
    await expectDenied(
      db.as(ownerA, (c) => c.query("update tenant_members set pipedrive_user_id = 1 where user_id = $1", [salesAId])),
    );
  });
});

describe("Rollen: admin vs. owner", () => {
  it("admin verwaltet sales/admin, aber keine owner", async () => {
    const upd = await db.as(adminA, (c) => c.query("update tenant_members set role = 'admin' where user_id = $1", [salesAId]));
    expect(upd.rowCount).toBe(1);
    await db.as(adminA, (c) => c.query("update tenant_members set role = 'sales' where user_id = $1", [salesAId]));

    // sich selbst oder andere zum owner machen: verweigert
    await expectDenied(db.as(adminA, (c) => c.query("update tenant_members set role = 'owner' where user_id = $1", [adminAId])));
    const uid = await newUser("admin-macht-owner@a.example");
    await expectDenied(
      db.as(adminA, (c) => c.query("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')", [tenantA, uid])),
    );

    // owner ändern/sperren: keine Zeile betroffen
    const own = await db.as(adminA, (c) =>
      c.query("update tenant_members set status = 'disabled' where tenant_id = $1 and role = 'owner'", [tenantA]),
    );
    expect(own.rowCount).toBe(0);
  });
});

describe("mindestens ein aktiver owner", () => {
  it("der letzte owner kann weder gesperrt, herabgestuft noch entfernt werden", async () => {
    await expectTb(
      db.as(ownerB, (c) => c.query("update tenant_members set status = 'disabled' where tenant_id = $1 and role = 'owner'", [tenantB])),
      "last_owner",
    );
    await expectTb(
      db.as(ownerB, (c) => c.query("update tenant_members set role = 'admin' where tenant_id = $1 and role = 'owner'", [tenantB])),
      "last_owner",
    );
    await expectTb(
      db.as(ownerB, (c) => c.query("delete from tenant_members where tenant_id = $1 and role = 'owner'", [tenantB])),
      "last_owner",
    );
  });

  it("mit einem zweiten owner darf der erste abgeben", async () => {
    const uid = await newUser("owner2@b.example");
    await db.as(ownerB, (c) => c.query("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')", [tenantB, uid]));
    const ownerBId = (ownerB as { userId: string }).userId;
    await db.as(ownerB, (c) => c.query("update tenant_members set role = 'admin' where user_id = $1 and tenant_id = $2", [ownerBId, tenantB]));
    const owners = await db.admin("select user_id from tenant_members where tenant_id = $1 and role = 'owner'", [tenantB]);
    expect(owners).toEqual([{ user_id: uid }]);
  });
});

describe("Kapazität", () => {
  it("nie unter die gebuchten Plätze; Erhöhen klappt; sales darf nicht", async () => {
    const [slot] = await db.admin<{ id: string; capacity: number; booked: number }>(
      `select s.id, s.capacity, app.slot_booked_seats(s.id) as booked
         from slots s where s.tenant_id = $1 and app.slot_booked_seats(s.id) > 0 limit 1`,
      [tenantA],
    );
    await expectTb(
      db.as(ownerA, (c) => c.query("update slots set capacity = $2 where id = $1", [slot!.id, slot!.booked - 1])),
      "capacity_below_booked",
    );
    await db.as(ownerA, (c) => c.query("update slots set capacity = capacity + 1 where id = $1", [slot!.id]));
    const [after] = await db.admin<{ capacity: number }>("select capacity from slots where id = $1", [slot!.id]);
    expect(after!.capacity).toBe(slot!.capacity + 1);

    const upd = await db.as(salesA, (c) => c.query("update slots set capacity = capacity + 1 where id = $1", [slot!.id]));
    expect(upd.rowCount).toBe(0);
  });
});

describe("Server-Funktionen", () => {
  it("Pipedrive-Domain nur für Mitglieder", async () => {
    await db.admin(
      `insert into pipedrive_connections (tenant_id, company_id, company_domain, api_domain, access_token_enc, refresh_token_enc, expires_at)
       values ($1, 4242, 'firma-a', 'https://firma-a.pipedrive.com', 'x', 'y', now())`,
      [tenantA],
    );
    const own = await db.as(ownerA, (c) => c.query("select public.get_pipedrive_company_domain($1) as d", [tenantA]));
    const other = await db.as(ownerB, (c) => c.query("select public.get_pipedrive_company_domain($1) as d", [tenantA]));
    expect(own.rows[0].d).toBe("firma-a");
    expect(other.rows[0].d).toBeNull();
    await expectDenied(db.as(ANON, (c) => c.query("select public.get_pipedrive_company_domain($1)", [tenantA])));
  });

  it("Login-Lookup und E-Mail-Suche nur für service_role", async () => {
    for (const actor of [ANON, ownerA]) {
      await expectDenied(db.as(actor, (c) => c.query("select * from public.member_login_lookup($1, 7200001)", [tenantA])));
      await expectDenied(db.as(actor, (c) => c.query("select public.auth_user_id_by_email('x@y.example')")));
    }
    const rows = await db.as({ role: "service_role" }, (c) =>
      c.query("select * from public.member_login_lookup($1, 7200001)", [tenantA]),
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ auth_email: "admin@antenne-vorarlberg.example", role: "owner", status: "active" }),
    ]);
    const id = await db.as({ role: "service_role" }, (c) =>
      c.query("select public.auth_user_id_by_email('ADMIN@antenne-vorarlberg.example') as id"),
    );
    expect(id.rows[0].id).toBe((ownerA as { userId: string }).userId);
  });
});
