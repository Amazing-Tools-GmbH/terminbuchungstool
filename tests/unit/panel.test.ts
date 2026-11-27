/** Vertriebs-Panel: Einstieg aus Pipedrive, Panel-Sitzung, Pipedrive-CRM-Aufrufe */
import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { dealIdFrom, verifyPanelEntry } from "@/lib/panel/token";
import { panelSessionSchema, seal, sessionSchema, unseal } from "@/lib/auth/session";
import { activityBody, ApiPipedriveCrm } from "@/lib/pipedrive/crm";
import { PipedriveError } from "@/lib/pipedrive/client";
import { panelTexts, PANEL_ERRORS, ADMIN_TEXTS } from "@/lib/texts/admin";

const SECRET = "app-secret";
const now = Date.UTC(2026, 10, 19, 12, 0, 0);
const nowS = now / 1000;
function jwt(claims: object, secret = SECRET) {
  const h = Buffer.from(JSON.stringify({ typ: "JWT", alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
const token = jwt({ userId: 11, companyId: 22, iat: nowS - 5, exp: nowS + 300 });
const params = (extra: Record<string, string>) => new URLSearchParams({ userId: "11", companyId: "22", token, ...extra });

describe("Panel-Einstieg", () => {
  it("Deal aus selectedIds", () => {
    expect(dealIdFrom("deal", "1001")).toBe(1001);
    expect(dealIdFrom(null, "1001,1002")).toBe(1001);
    expect(dealIdFrom("person", "1001")).toBeNull();
    expect(dealIdFrom("deal", "")).toBeNull();
    expect(dealIdFrom("deal", "abc")).toBeNull();
    expect(dealIdFrom("deal", "0")).toBeNull();
  });

  it("gültiges Token + Deal", () => {
    expect(verifyPanelEntry(params({ resource: "deal", selectedIds: "1001" }), SECRET, now)).toEqual({
      ok: true,
      entry: { userId: 11, companyId: 22, dealId: 1001, personId: null },
    });
  });

  it("gültiges Token + Kontakt (Panel im Kontakt)", () => {
    expect(verifyPanelEntry(params({ resource: "person", selectedIds: "5001" }), SECRET, now)).toEqual({
      ok: true,
      entry: { userId: 11, companyId: 22, dealId: null, personId: 5001 },
    });
    expect(verifyPanelEntry(params({ resource: "contact", selectedIds: "5001" }), SECRET, now)).toMatchObject({ ok: true, entry: { personId: 5001 } });
    expect(verifyPanelEntry(params({ resource: "Persons", selectedIds: "5001" }), SECRET, now)).toMatchObject({ ok: true, entry: { personId: 5001 } });
    expect(verifyPanelEntry(params({ resource: "person" }), SECRET, now)).toEqual({ ok: false, error: "no_deal" });
    expect(verifyPanelEntry(params({ resource: "organization", selectedIds: "3" }), SECRET, now)).toEqual({ ok: false, error: "no_deal" });
  });

  it("ohne Deal / mit falscher Signatur / ohne Geheimnis abgelehnt", () => {
    expect(verifyPanelEntry(params({ resource: "deal" }), SECRET, now)).toEqual({ ok: false, error: "no_deal" });
    expect(verifyPanelEntry(params({ selectedIds: "1" }), "anders", now)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyPanelEntry(params({ selectedIds: "1" }), null, now)).toEqual({ ok: false, error: "not_configured" });
    expect(verifyPanelEntry(params({ selectedIds: "1", userId: "12" }), SECRET, now)).toEqual({ ok: false, error: "mismatch" });
  });
});

describe("Panel-Sitzung", () => {
  const key = randomBytes(32).toString("base64");
  const s = { uid: "4b0b8a3e-6a43-4c5b-9a3c-0f4f1b0f6c11", tid: "5c1c9b4f-7b54-4d6c-8b4d-1a5a2c1a7d22", pd: 11, deal: 1001 };

  it("eigener Zweck: Panel-Wert ist kein Admin-Cookie und umgekehrt", () => {
    const panel = seal("panel", s, 60, { key });
    expect(unseal("panel", panel, panelSessionSchema, { key })).toEqual(s);
    expect(unseal("session", panel, sessionSchema, { key })).toBeNull();
    const admin = seal("session", { uid: s.uid, tid: s.tid, pd: 11 }, 60, { key });
    expect(unseal("panel", admin, panelSessionSchema, { key })).toBeNull();
  });

  it("läuft ab", () => {
    const panel = seal("panel", s, 60, { key, now });
    expect(unseal("panel", panel, panelSessionSchema, { key, now: now + 61_000 })).toBeNull();
  });
});

describe("Panel-Texte", () => {
  it("alle Fehlercodes haben Texte; Wörterbuch enthält Panel- und Mailfehler-Texte", () => {
    for (const c of PANEL_ERRORS) expect(ADMIN_TEXTS).toHaveProperty(`panel.error.${c}`);
    const t = panelTexts();
    expect(t["panel.book"]).toBeTruthy();
    expect(t["panel.sendLink"]).toBeTruthy();
    expect(t["mailError.generic"]).toBeTruthy();
    expect(Object.keys(t).every((k) => k.startsWith("panel.") || k.startsWith("mailError."))).toBe(true);
  });
});

describe("Pipedrive-CRM", () => {
  const access = { apiDomain: "https://firma.pipedrive.com", accessToken: "tok" };
  const input = {
    subject: "Workshop (2 Pers.)",
    type: "call",
    attendees: [{ email: "eva@kunde.example", name: "Eva", personId: 5001 }, { email: "max@gast.example", name: null, personId: null }],
    ownerId: 7,
    dealId: 1001,
    personId: 5001,
    start: new Date(Date.UTC(2026, 11, 1, 8, 5)),
    durationMinutes: 125,
    note: "n",
  };

  it("Aktivität: Typ, UTC-Datum, Dauer HH:MM, Teilnehmer, Gäste, Besitzer", () => {
    expect(activityBody(input)).toEqual({
      subject: "Workshop (2 Pers.)",
      type: "call",
      deal_id: 1001,
      owner_id: 7,
      participants: [{ person_id: 5001, primary: true }],
      attendees: [{ email: "eva@kunde.example", name: "Eva", person_id: 5001 }, { email: "max@gast.example" }],
      due_date: "2026-12-01",
      due_time: "08:05",
      duration: "02:05",
      note: "n",
      done: false,
    });
    expect(activityBody({ ...input, ownerId: null, personId: null })).not.toHaveProperty("participants");
    // ohne Deal (nur Kontakt) kein deal_id; ohne Typ Standard meeting
    const noDeal = activityBody({ ...input, dealId: null, type: "", attendees: [] });
    expect(noDeal).not.toHaveProperty("deal_id");
    expect(noDeal).not.toHaveProperty("attendees");
    expect(noDeal.type).toBe("meeting");
  });

  function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") });
      const r = responses[`${method} ${new URL(url).pathname}`] ?? { status: 404 };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it("liest Deal, Person (primäre E-Mail), Organisation über API v2", async () => {
    const { f, calls } = fakeFetch({
      "GET /api/v2/deals/1001": { status: 200, body: { data: { id: 1001, title: "Deal", person_id: 5001, org_id: 3, owner_id: 7 } } },
      "GET /api/v2/persons/5001": {
        status: 200,
        body: { data: { id: 5001, name: "Maria", emails: [{ value: "x@a.at" }, { value: " Maria@B.AT ", primary: true }] } },
      },
      "GET /api/v2/organizations/3": { status: 200, body: { data: { name: "Muster GmbH" } } },
    });
    const crm = new ApiPipedriveCrm(f);
    expect(await crm.getDeal(access, 1001)).toEqual({ id: 1001, title: "Deal", personId: 5001, orgId: 3, ownerId: 7 });
    expect(await crm.getPerson(access, 5001)).toEqual({ id: 5001, name: "Maria", email: "maria@b.at", orgId: null });
    expect(await crm.getOrganizationName(access, 3)).toBe("Muster GmbH");
    expect(await crm.getDeal(access, 9)).toBeNull();
    expect(calls[0]!.auth).toBe("Bearer tok");
  });

  it("Aktivität anlegen/ändern/löschen, Notiz über v1", async () => {
    const { f, calls } = fakeFetch({
      "POST /api/v2/activities": { status: 201, body: { data: { id: 77 } } },
      "PATCH /api/v2/activities/77": { status: 200, body: { data: { id: 77 } } },
      "DELETE /api/v2/activities/77": { status: 200, body: { data: { id: 77 } } },
      "POST /api/v1/notes": { status: 201, body: { data: { id: 5 } } },
    });
    const crm = new ApiPipedriveCrm(f);
    expect(await crm.createActivity(access, input)).toBe(77);
    await crm.updateActivity(access, 77, input);
    expect(await crm.deleteActivity(access, 77)).toBe(true);
    expect(await crm.deleteActivity(access, 78)).toBe(false);
    await expect(crm.updateActivity(access, 78, input)).rejects.toMatchObject({ status: 404 });
    expect(await crm.addNote(access, { dealId: 1001, personId: 5001, html: "<b>x</b>" })).toBe(5);
    expect(calls.find((c) => c.url.endsWith("/api/v1/notes"))!.body).toEqual({ content: "<b>x</b>", deal_id: 1001, person_id: 5001 });
  });

  it("401 -> unauthorized, 5xx -> api-Fehler", async () => {
    const crm401 = new ApiPipedriveCrm(fakeFetch({ "GET /api/v2/deals/1": { status: 401 } }).f);
    await expect(crm401.getDeal(access, 1)).rejects.toMatchObject({ kind: "unauthorized" });
    const crm500 = new ApiPipedriveCrm(fakeFetch({ "GET /api/v2/deals/1": { status: 503 } }).f);
    await expect(crm500.getDeal(access, 1)).rejects.toBeInstanceOf(PipedriveError);
  });
});

import { companyDomainFromApiDomain } from "@/lib/pipedrive/domain-sync";
describe("Pipedrive-Adresse aus api_domain", () => {
  it("nur echte Firmenadressen", () => {
    expect(companyDomainFromApiDomain("https://antenne.pipedrive.com")).toBe("antenne");
    expect(companyDomainFromApiDomain("https://Antenne.pipedrive.com/")).toBe("antenne");
    expect(companyDomainFromApiDomain("https://api.pipedrive.com")).toBeNull();
    expect(companyDomainFromApiDomain("https://firma.example.com")).toBeNull();
    expect(companyDomainFromApiDomain("kein-url")).toBeNull();
  });
});
