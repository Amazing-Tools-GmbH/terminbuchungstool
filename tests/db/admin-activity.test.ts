/**
 * Verlauf: Schritte je Vorgang (Link erstellt, Mails, Buchung, Pipedrive,
 * Änderungen durch das Team), Fehler + „Erneut versuchen“, Hinweiszähler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON } from "@/lib/db/actor";
import { generateToken, hashToken } from "@/lib/booking/tokens";
import { bookSlot, cancelBooking } from "@/lib/booking/service";
import { processOutbox } from "@/lib/mail/outbox";
import { MailSendError, type MailSender } from "@/lib/mail/types";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let activity: typeof import("@/lib/admin/activity");
let maintenance: typeof import("@/lib/admin/maintenance");
let owner: AdminContext;
let sales: AdminContext;
let tenant: { id: string; slug: string };
let eventId: string;
let slotId: string;
let invitationId: string;
let token: string;
const anon = (fn: (c: import("pg").PoolClient) => Promise<unknown>) => db.as(ANON, fn);

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  activity = await import("@/lib/admin/activity");
  maintenance = await import("@/lib/admin/maintenance");
  const s = db.seed.find((x) => x.slug === "antennevorarlberg")!;
  tenant = { id: s.tenantId, slug: s.slug };
  const m = await db.admin<{ user_id: string; role: "owner" | "sales" }>(
    "select user_id, role::text as role from tenant_members where tenant_id = $1 and status = 'active'",
    [tenant.id],
  );
  const t = { id: tenant.id, timezone: "Europe/Vienna" } as AdminContext["tenant"];
  const ctx = (role: "owner" | "sales"): AdminContext => {
    const userId = m.find((x) => x.role === role)!.user_id;
    return { tenant: t, userId, actor: { role: "authenticated", userId }, role, name: null, email: null };
  };
  owner = ctx("owner");
  sales = ctx("sales");
  await db.admin("update tenant_members set display_name = 'Olga Owner' where user_id = $1", [owner.userId]);
  await db.admin("update tenant_members set display_name = 'Vera Vertrieb' where user_id = $1", [sales.userId]);
  [{ id: eventId }] = (await db.admin<{ id: string }>("select id from events where tenant_id = $1", [tenant.id])) as [{ id: string }];
  [{ id: slotId }] = (await db.admin<{ id: string }>(
    `insert into slots (tenant_id, event_id, starts_at, ends_at, capacity)
     values ($1, $2, now() + interval '30 days', now() + interval '30 days 2 hours', 20) returning id`,
    [tenant.id, eventId],
  )) as [{ id: string }];
  await db.admin("delete from email_outbox");
  await db.admin("delete from pipedrive_jobs");

  // Vorgang: Vertrieb erstellt Link (mit Einladungsmail), Kunde bucht mit Teilnehmer
  token = generateToken();
  [{ id: invitationId }] = (await db.admin<{ id: string }>(
    `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at, created_by, pipedrive_deal_id)
     values ($1, $2, $3, 'Karla Kunde', 'karla@kunde.example', now() + interval '30 days', $4, 4711) returning id`,
    [tenant.id, eventId, hashToken(token), sales.userId],
  )) as [{ id: string }];
  await db.admin("insert into email_outbox (tenant_id, type, to_email, payload) values ($1, 'invitation', 'karla@kunde.example', $2)", [
    tenant.id,
    { invitation_id: invitationId },
  ]);
  await db.admin("update email_outbox set status = 'sent', sent_at = now(), send_channel = 'pipedrive' where type = 'invitation'");
  await bookSlot(anon as never, tenant, {
    token,
    slotId,
    seats: 2,
    name: "Karla Kunde",
    email: "karla@kunde.example",
    extraAttendees: ["Gustav Gast"],
    guests: [{ name: "Gustav Gast", email: "gustav@gast.example" }],
  });
  // Versand scheitert dauerhaft (Empfänger abgelehnt)
  const failing: MailSender = {
    send: async () => {
      throw new MailSendError("permanent", "550 Empfänger abgelehnt");
    },
  };
  await processOutbox(db.pool, { senderFactory: () => failing });
  await db.admin("update pipedrive_jobs set status = 'failed', last_error = 'Pipedrive 500', attempts = 5");
});
afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

describe("Verlauf", () => {
  it("zeigt den Vorgang mit seinen Schritten und Fehlern", async () => {
    const { runs } = await activity.loadActivity(owner, { onlyErrors: false, eventId: null, page: 0, invitationId });
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r).toMatchObject({ customer: "Karla Kunde", direct: false, status: "error" });
    const texts = r.steps.map((s) => `${s.status}:${s.text}`);
    expect(texts[0]).toBe("ok:Buchungslink erstellt von Vera Vertrieb");
    expect(texts).toContain("ok:Einladung an karla@kunde.example");
    expect(texts.some((t) => /^ok:Gebucht: .*, 2 Personen$/.test(t))).toBe(true);
    expect(texts).toContain("error:Buchungsbestätigung an karla@kunde.example");
    expect(texts).toContain("error:Einladung an Teilnehmer gustav@gast.example");
    expect(texts).toContain("error:Aktivität im Deal angelegt/aktualisiert");
    const booked = r.steps.find((s) => s.text.startsWith("Gebucht"))!;
    expect(booked.note).toBe("Kunde selbst");
    const mail = r.steps.find((s) => s.text.startsWith("Buchungsbestätigung"))!;
    expect(mail.note).toContain("fehlgeschlagen");
    expect(mail.retry?.source).toBe("mail");
    expect(r.steps.find((s) => s.text.startsWith("Einladung an karla"))!.note).toContain("Pipedrive-Postfach");
  });

  it("Filter „Nur mit Fehlern“, Hinweiszähler, sales ohne Zugriff", async () => {
    const { runs } = await activity.loadActivity(owner, { onlyErrors: true, eventId: null, page: 0 });
    expect(runs.map((r) => r.invitationId)).toContain(invitationId);
    expect(runs.every((r) => r.status === "error")).toBe(true);
    expect(await activity.activityProblemCount(owner)).toBeGreaterThanOrEqual(3);
    expect(await activity.activityProblemCount(sales)).toBe(0);
    await expect(activity.loadActivity(sales, { onlyErrors: false, eventId: null, page: 0 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("Erneut versuchen: Mail und Pipedrive-Eintrag wieder in die Warteschlange", async () => {
    const { runs } = await activity.loadActivity(owner, { onlyErrors: false, eventId: null, page: 0, invitationId });
    const failed = runs[0]!.steps.filter((s) => s.retry);
    for (const s of failed) expect(await activity.retryActivity(owner, s.retry!.source, s.retry!.id)).toBe(true);
    const after = await activity.loadActivity(owner, { onlyErrors: false, eventId: null, page: 0, invitationId });
    expect(after.runs[0]!.status).toBe("pending");
    // zweimal geht nicht (nicht mehr fehlgeschlagen)
    expect(await activity.retryActivity(owner, failed[0]!.retry!.source, failed[0]!.retry!.id)).toBe(false);
  });

  it("Änderungen durch das Team und Storno erscheinen mit Namen", async () => {
    const date = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);
    await maintenance.updateSlot(owner, { slotId, date, from: "09:00", to: "10:00", location: "Saal 2", notify: false });
    await cancelBooking(anon as never, tenant, token);
    const { runs } = await activity.loadActivity(owner, { onlyErrors: false, eventId: null, page: 0, invitationId });
    const texts = runs[0]!.steps.map((s) => s.text);
    expect(texts.some((t) => t.startsWith("Termin geändert von Olga Owner:"))).toBe(true);
    expect(runs[0]!.steps.find((s) => s.text.startsWith("Termin geändert"))!.note).toBe("Ort: Saal 2");
    expect(texts).toContain("Storniert durch den Kunden");
    const [b] = await db.admin<{ cancelled_by: string | null }>("select cancelled_by from bookings where invitation_id = $1", [invitationId]);
    expect(b!.cancelled_by).toBeNull();
  });

  it("Storno durch das Team: cancelled_by = Mitarbeiter", async () => {
    const t2 = generateToken();
    await db.admin(
      `insert into invitations (tenant_id, event_id, token_hash, name, email, expires_at) values ($1, $2, $3, 'Tim', 'tim@x.example', now() + interval '30 days')`,
      [tenant.id, eventId, hashToken(t2)],
    );
    const r = await bookSlot(anon as never, tenant, { token: t2, slotId, seats: 1, name: "Tim", email: "tim@x.example", extraAttendees: [] });
    await maintenance.cancelBookingByTeam(owner, r.bookingId, false);
    const [inv] = await db.admin<{ invitation_id: string }>("select invitation_id from bookings where id = $1", [r.bookingId]);
    const { runs } = await activity.loadActivity(owner, { onlyErrors: false, eventId: null, page: 0, invitationId: inv!.invitation_id });
    expect(runs[0]!.direct).toBe(false);
    expect(runs[0]!.steps.map((s) => s.text)).toContain("Storniert von Olga Owner (Team)");
  });
});
