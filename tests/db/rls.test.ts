/**
 * Mandantenisolation über RLS: Zugriffe als Mitglied von Mandant A,
 * Mitglied von Mandant B und anonym. A darf Daten von B nie sehen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON, type DbActor } from "@/lib/db/actor";
import { setupTestDb, type TestDb } from "./helpers";

const TABLES = [
  "tenants",
  "tenant_members",
  "events",
  "slots",
  "invitations",
  "bookings",
  "pipedrive_connections",
  "mail_connections",
  "email_outbox",
  "mail_oauth_pending",
  "pipedrive_jobs",
] as const;

/** Nur service_role (Tokens/Zugangsdaten): für Mitglieder gar nicht lesbar */
const SERVICE_ONLY: readonly string[] = ["pipedrive_connections", "mail_oauth_pending", "pipedrive_jobs"];

let db: TestDb;
let tenantA: string;
let tenantB: string;
let userA: DbActor;
let userB: DbActor;
let salesA: DbActor;

beforeAll(async () => {
  db = await setupTestDb();
  const tenants = await db.admin<{ id: string; slug: string }>("select id, slug from tenants");
  tenantA = tenants.find((t) => t.slug === "antennevorarlberg")!.id;
  tenantB = tenants.find((t) => t.slug === "demo")!.id;
  const members = await db.admin<{ tenant_id: string; user_id: string }>("select tenant_id, user_id from tenant_members");
  userA = { role: "authenticated", userId: members.find((m) => m.tenant_id === tenantA)!.user_id };
  userB = { role: "authenticated", userId: members.find((m) => m.tenant_id === tenantB)!.user_id };

  // zusätzlicher Vertriebsmitarbeiter (sales) in A
  const [u] = await db.admin<{ id: string }>("insert into auth.users (email) values ('sales@a.example') returning id");
  await db.admin("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'sales')", [tenantA, u!.id]);
  salesA = { role: "authenticated", userId: u!.id };

  // Pipedrive-Verbindung + eine Outbox-Mail je Mandant, damit alle Tabellen Daten haben
  for (const [i, t] of [tenantA, tenantB].entries()) {
    await db.admin(
      `insert into pipedrive_connections (tenant_id, company_id, company_domain, api_domain, access_token_enc, refresh_token_enc, expires_at)
       values ($1, $2::bigint, 'firma' || $2::text, 'https://firma' || $2::text || '.pipedrive.com', 'v1:a:b:c', 'v1:a:b:c', now() + interval '1 hour')`,
      [t, 1000 + i],
    );
    await db.admin("insert into email_outbox (tenant_id, type, to_email) values ($1, 'test', 'x@y.example')", [t]);
  }
});

afterAll(() => db?.close());

async function tenantIdsVisible(actor: DbActor, table: string): Promise<string[]> {
  const col = table === "tenants" ? "id" : "tenant_id";
  return db.as(actor, async (c) => (await c.query(`select distinct ${col} as t from public.${table}`)).rows.map((r) => r.t));
}

describe("Lesen", () => {
  it.each(TABLES.filter((t) => !SERVICE_ONLY.includes(t)))("Mitglied A sieht in %s nur Daten von A", async (table) => {
    const seen = await tenantIdsVisible(userA, table);
    expect(seen).toEqual([tenantA]);
  });

  it.each(TABLES.filter((t) => !SERVICE_ONLY.includes(t)))("Mitglied B sieht in %s nur Daten von B", async (table) => {
    const seen = await tenantIdsVisible(userB, table);
    expect(seen).toEqual([tenantB]);
  });

  it.each(TABLES)("anon hat auf %s keinen Zugriff", async (table) => {
    await expect(db.as(ANON, (c) => c.query(`select 1 from public.${table} limit 1`))).rejects.toThrow(/permission denied/);
  });

  it.each(SERVICE_ONLY)("%s (Tokens/Zugangsdaten) sind für Mitglieder unsichtbar", async (table) => {
    await expect(db.as(userA, (c) => c.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
  });

  it("Zugangsdaten von Postfächern und Token-Hashes sind nicht lesbar", async () => {
    await expect(db.as(userA, (c) => c.query("select credentials_enc from public.mail_connections"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.as(userA, (c) => c.query("select token_hash from public.invitations"))).rejects.toThrow(/permission denied/);
  });

  it("Benutzer ohne Mitgliedschaft sieht nichts", async () => {
    const [u] = await db.admin<{ id: string }>("insert into auth.users (email) values ('fremd@x.example') returning id");
    const stranger: DbActor = { role: "authenticated", userId: u!.id };
    for (const table of TABLES.filter((t) => !SERVICE_ONLY.includes(t))) {
      expect(await tenantIdsVisible(stranger, table)).toEqual([]);
    }
  });
});

describe("pipedrive_user_connections (Pipedrive-Zugang je Mitarbeiter)", () => {
  it("Mitglied sieht nur den eigenen Zugang, owner/admin den ihres Mandanten, nie Tokens", async () => {
    const uA = (userA as { userId: string }).userId;
    const uB = (userB as { userId: string }).userId;
    for (const [tid, uid] of [
      [tenantA, uA],
      [tenantB, uB],
    ] as const) {
      await db.admin(
        `insert into pipedrive_user_connections (tenant_id, user_id, pipedrive_user_id, api_domain, access_token_enc, refresh_token_enc, expires_at)
         values ($1, $2, 1, 'https://x.pipedrive.com', 'enc', 'enc', now()) on conflict do nothing`,
        [tid, uid],
      );
    }
    expect(await tenantIdsVisible(userA, "pipedrive_user_connections")).toEqual([tenantA]);
    expect(await tenantIdsVisible(userB, "pipedrive_user_connections")).toEqual([tenantB]);
    // sales sieht nur den eigenen (hat keinen) -> nichts
    expect(await tenantIdsVisible(salesA, "pipedrive_user_connections")).toEqual([]);
    await expect(db.as(userA, (c) => c.query("select access_token_enc from pipedrive_user_connections"))).rejects.toThrow(/permission denied/);
    await expect(db.as(ANON, (c) => c.query("select 1 from pipedrive_user_connections"))).rejects.toThrow(/permission denied/);
    await expect(
      db.as(userA, (c) => c.query("update pipedrive_user_connections set status = 'error'")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("Schreiben", () => {
  it("A kann keine Veranstaltung für B anlegen", async () => {
    await expect(
      db.as(userA, (c) => c.query("insert into events (tenant_id, title) values ($1, 'Fremd')", [tenantB])),
    ).rejects.toThrow(/row-level security/);
  });

  it("A kann Daten von B weder ändern noch löschen (0 Zeilen betroffen)", async () => {
    const updated = await db.as(userA, (c) => c.query("update events set title = 'gehackt' where tenant_id = $1", [tenantB]));
    const deleted = await db.as(userA, (c) => c.query("delete from slots where tenant_id = $1", [tenantB]));
    const tenantUpd = await db.as(userA, (c) => c.query("update tenants set name = 'gehackt' where id = $1", [tenantB]));
    expect([updated.rowCount, deleted.rowCount, tenantUpd.rowCount]).toEqual([0, 0, 0]);
    const [b] = await db.admin<{ name: string }>("select name from tenants where id = $1", [tenantB]);
    expect(b!.name).toBe("Demo GmbH");
  });

  it("A kann keinen Slot an eine Veranstaltung von B hängen", async () => {
    const [evB] = await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantB]);
    await expect(
      db.as(userA, (c) =>
        c.query(
          "insert into slots (tenant_id, event_id, starts_at, ends_at, capacity) values ($1, $2, now() + interval '1 day', now() + interval '2 days', 5)",
          [tenantA, evB!.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("niemand kann Buchungen direkt einfügen (nur über book_slot)", async () => {
    const [slot] = await db.admin<{ id: string }>("select id from slots where tenant_id = $1 limit 1", [tenantA]);
    const [inv] = await db.admin<{ id: string }>("select id from invitations where tenant_id = $1 limit 1", [tenantA]);
    for (const actor of [userA, ANON]) {
      await expect(
        db.as(actor, (c) =>
          c.query("insert into bookings (tenant_id, slot_id, invitation_id, name, email, seats) values ($1, $2, $3, 'x', 'x@y.at', 1)", [
            tenantA,
            slot!.id,
            inv!.id,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("sales darf Einladungen anlegen, aber keine Termine ändern", async () => {
    const [ev] = await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenantA]);
    await db.as(salesA, (c) =>
      c.query(
        `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at)
         values ($1, $2, decode(repeat('ab', 32), 'hex'), 'Neu', 'neu@kunde.example', now() + interval '7 days')`,
        [tenantA, ev!.id],
      ),
    );
    const upd = await db.as(salesA, (c) => c.query("update slots set capacity = 99 where tenant_id = $1", [tenantA]));
    expect(upd.rowCount).toBe(0);
  });

  it("owner von A kann Kapazität in A ändern", async () => {
    const res = await db.as(userA, (c) =>
      c.query("update slots set capacity = capacity where tenant_id = $1", [tenantA]),
    );
    expect(res.rowCount).toBeGreaterThan(0);
  });
});
