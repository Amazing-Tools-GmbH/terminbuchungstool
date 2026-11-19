/**
 * Phase 3: Sitzung/Login-Siegel, Pipedrive-Client, Login-Entscheidung,
 * Nutzerverwaltung (Zusammenführung) und Terminlogik.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { loginStateSchema, seal, sessionSchema, unseal } from "@/lib/auth/session";
import { authorizeUrl, exchangeCode, getMe, listUsers, oauthConfig, PipedriveError, type PipedriveMe } from "@/lib/pipedrive/client";
import { completePipedriveLogin, type LoginDeps } from "@/lib/auth/pipedrive-login";
import { mergeTeam, type MemberRow } from "@/lib/admin/team";
import { dealUrl, kpis, slotLevel } from "@/lib/admin/slot-logic";
import { createSlotSchema } from "@/lib/admin/input";
import { tenantUrl } from "@/lib/auth/urls";
import { authAdminTarget } from "@/lib/auth/users-target";
import { ADMIN_TEXTS, loginErrorText } from "@/lib/texts/admin";
import { ADMIN_ERROR_CODES } from "@/lib/admin/errors";

const KEY = randomBytes(32).toString("base64");
const TID = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";

describe("Siegel (Sitzung, Login-State, Ticket)", () => {
  const session = { uid: UID, tid: TID, pd: 7 };

  it("versiegelt und öffnet eine Sitzung", () => {
    const s = seal("session", session, 60, { key: KEY });
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, cookie-/URL-tauglich
    expect(unseal("session", s, sessionSchema, { key: KEY })).toEqual(session);
  });

  it("lehnt Ablauf, Manipulation, fremden Schlüssel und fremden Zweck ab", () => {
    const s = seal("session", session, 60, { key: KEY });
    expect(unseal("session", s, sessionSchema, { key: KEY, now: Date.now() + 61_000 })).toBeNull();
    expect(unseal("session", s.slice(0, -2) + (s.endsWith("A") ? "BB" : "AA"), sessionSchema, { key: KEY })).toBeNull();
    expect(unseal("session", s, sessionSchema, { key: randomBytes(32).toString("base64") })).toBeNull();
    // ein Login-Ticket/State ist nie als Sitzung verwendbar
    expect(unseal("login-ticket", s, sessionSchema, { key: KEY })).toBeNull();
    expect(unseal("session", null, sessionSchema, { key: KEY })).toBeNull();
    expect(unseal("session", "x".repeat(5000), sessionSchema, { key: KEY })).toBeNull();
  });

  it("prüft den Inhalt per Schema", () => {
    const s = seal("login-state", { purpose: "install", tid: TID, nonce: "n".repeat(20) }, 60, { key: KEY });
    expect(unseal("login-state", s, loginStateSchema, { key: KEY })).toBeNull();
    const ok = seal("login-state", { purpose: "login", tid: TID, nonce: "n".repeat(20) }, 60, { key: KEY });
    expect(unseal("login-state", ok, loginStateSchema, { key: KEY })?.tid).toBe(TID);
    expect(unseal("login-state", ok, z.object({ other: z.string() }), { key: KEY })).toBeNull();
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Pipedrive-Client", () => {
  const cfg = { clientId: "cid", clientSecret: "secret", redirectUri: "https://app.example/api/auth/pipedrive/callback" };

  it("OAuth-Konfiguration nur mit Client-ID und Secret; eine zentrale Callback-URL", () => {
    expect(oauthConfig({})).toBeNull();
    expect(oauthConfig({ PIPEDRIVE_CLIENT_ID: "a", PIPEDRIVE_CLIENT_SECRET: "b", APP_BASE_URL: "https://termine.example/" })).toEqual({
      clientId: "a",
      clientSecret: "b",
      redirectUri: "https://termine.example/api/auth/pipedrive/callback",
    });
    const u = new URL(authorizeUrl(cfg, "STATE"));
    expect(u.origin).toBe("https://oauth.pipedrive.com");
    expect(u.searchParams.get("state")).toBe("STATE");
    expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
  });

  it("tauscht den Code mit Basic-Auth gegen Tokens", async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, api_domain: "https://firma.pipedrive.com/" }),
    );
    const t = await exchangeCode(cfg, "CODE", f as unknown as typeof fetch);
    expect(t.apiDomain).toBe("https://firma.pipedrive.com");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://oauth.pipedrive.com/oauth/token");
    expect((init!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(String(init!.body)).toContain("grant_type=authorization_code");
    await expect(exchangeCode(cfg, "X", (async () => jsonResponse(400, {})) as unknown as typeof fetch)).rejects.toBeInstanceOf(PipedriveError);
  });

  it("liest /users/me und /users (Flags als boolean oder 0/1, E-Mail klein)", async () => {
    const f = (async (url: string | URL | Request) =>
      String(url).endsWith("/users/me")
        ? jsonResponse(200, {
            success: true,
            data: { id: 5, name: "Eva", email: "Eva@Firma.example", is_admin: 1, active_flag: true, company_id: 99, company_domain: "Firma" },
          })
        : jsonResponse(200, {
            success: true,
            data: [
              { id: 5, name: "Eva", email: "eva@firma.example", is_admin: true, active_flag: true },
              { id: 6, name: "Kaputt" }, // ungültig -> übersprungen
              { id: 7, name: "Max", email: "max@firma.example", is_admin: 0, active_flag: 0 },
            ],
          })) as unknown as typeof fetch;
    const me = await getMe("https://firma.pipedrive.com", "t", f);
    expect(me).toMatchObject({ id: 5, email: "eva@firma.example", isAdmin: true, companyId: 99, companyDomain: "firma" });
    const users = await listUsers("https://firma.pipedrive.com", "t", f);
    expect(users).toEqual([
      { id: 5, name: "Eva", email: "eva@firma.example", isAdmin: true, active: true },
      { id: 7, name: "Max", email: "max@firma.example", isAdmin: false, active: false },
    ]);
    await expect(getMe("https://x", "t", (async () => jsonResponse(401, {})) as unknown as typeof fetch)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});

describe("Login über Pipedrive", () => {
  const state = { purpose: "login" as const, tid: TID, nonce: "n".repeat(20) };
  const me: PipedriveMe = { id: 5, name: "Eva", email: "eva@firma.example", isAdmin: false, active: true, companyId: 99, companyDomain: "firma" };

  function deps(over: Partial<LoginDeps> = {}): LoginDeps {
    return {
      exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: new Date(), scope: null, apiDomain: "https://firma.pipedrive.com" }),
      getMe: async () => me,
      connectedCompanyId: async () => 99,
      lookupMember: async () => ({ userId: UID, authEmail: "eva@firma.example", status: "active" }),
      refreshMemberCache: async () => {},
      ...over,
    };
  }

  it("freigeschalteter Benutzer der richtigen Firma bekommt eine Sitzung", async () => {
    const refresh = vi.fn(async () => {});
    const r = await completePipedriveLogin(state, "code", deps({ refreshMemberCache: refresh }));
    expect(r).toEqual({ ok: true, session: { uid: UID, tid: TID, pd: 5 } });
    expect(refresh).toHaveBeenCalledWith(TID, UID, me);
  });

  it.each([
    ["oauth_failed", { exchangeCode: async () => Promise.reject(new Error("x")) }],
    ["not_connected", { connectedCompanyId: async (): Promise<number | null> => null }],
    ["wrong_company", { connectedCompanyId: async (): Promise<number | null> => 12 }],
    ["no_access", { lookupMember: async (): Promise<null> => null }],
    ["disabled", { lookupMember: async () => ({ userId: UID, authEmail: "eva@firma.example", status: "disabled" as const }) }],
    ["email_mismatch", { lookupMember: async () => ({ userId: UID, authEmail: "andere@firma.example", status: "active" as const }) }],
  ] as const)("verweigert: %s", async (error, over) => {
    expect(await completePipedriveLogin(state, "code", deps(over as Partial<LoginDeps>))).toEqual({ ok: false, error });
  });

  it("jede Login-Fehlermeldung hat einen Text", () => {
    for (const e of ["oauth_failed", "not_connected", "wrong_company", "no_access", "disabled", "email_mismatch", "expired", "cancelled", "not_configured"]) {
      expect(loginErrorText(e)).toBeTruthy();
    }
    expect(loginErrorText("<script>")).toBeNull();
  });
});

describe("Nutzerverwaltung: Pipedrive-Benutzer + Mitgliedschaften", () => {
  const users = [
    { id: 1, name: "Zora Owner", email: "z@f.example", isAdmin: true, active: true },
    { id: 2, name: "Anna Neu", email: "a@f.example", isAdmin: false, active: true },
    { id: 3, name: "Inaktiv Ohne", email: "i@f.example", isAdmin: false, active: false },
    { id: 4, name: "Inaktiv Mit", email: "m@f.example", isAdmin: false, active: false },
  ];
  const member = (userId: string, pd: number | null, role: MemberRow["role"], status: MemberRow["status"] = "active"): MemberRow => ({
    userId,
    role,
    status,
    pipedriveUserId: pd,
    name: `M${userId}`,
    email: `${userId}@f.example`,
  });

  it("führt zusammen, blendet inaktive ohne Zugriff aus, zeigt Verwaiste und sortiert", () => {
    const team = mergeTeam(users, [member("u1", 1, "owner"), member("u4", 4, "sales", "disabled"), member("u9", 9, "admin")], "u1");
    expect(team.map((e) => [e.name, e.member?.role ?? null, e.pipedrive ? "pd" : "-", e.isSelf])).toEqual([
      ["Zora Owner", "owner", "pd", true],
      ["Mu9", "admin", "-", false], // nicht mehr in Pipedrive
      ["Inaktiv Mit", "sales", "pd", false], // gesperrt
      ["Anna Neu", null, "pd", false], // kein Zugriff
    ]);
  });
});

describe("Termine", () => {
  it("Status wie auf der Buchungsseite (fast voll ab 3 freien Plätzen)", () => {
    expect(slotLevel("open", 10, 10)).toBe("full");
    expect(slotLevel("open", 10, 7)).toBe("low");
    expect(slotLevel("open", 10, 6)).toBe("ok");
    expect(slotLevel("closed", 10, 0)).toBe("closed");
    expect(slotLevel("cancelled", 10, 0)).toBe("cancelled");
  });

  it("KPIs ohne abgesagte Termine", () => {
    expect(
      kpis([
        { level: "ok", capacity: 10, booked: 4 },
        { level: "full", capacity: 10, booked: 10 },
        { level: "cancelled", capacity: 50, booked: 0 },
      ]),
    ).toEqual({ slots: 2, capacity: 20, booked: 14, pct: 70 });
    expect(kpis([])).toEqual({ slots: 0, capacity: 0, booked: 0, pct: 0 });
  });

  it("Deal-Link nur mit Pipedrive-Domain und Deal", () => {
    expect(dealUrl("firma", "42")).toBe("https://firma.pipedrive.com/deal/42");
    expect(dealUrl(null, "42")).toBeNull();
    expect(dealUrl("firma", null)).toBeNull();
  });

  it("Eingaben für neue Termine", () => {
    const base = { eventId: TID, date: "2027-01-21", from: "10:00", to: "12:00", location: " ", capacity: "12", open: true };
    expect(createSlotSchema.parse(base)).toMatchObject({ location: null, capacity: 12 });
    expect(createSlotSchema.safeParse({ ...base, to: "09:00" }).success).toBe(false);
    expect(createSlotSchema.safeParse({ ...base, from: "25:00" }).success).toBe(false);
    expect(createSlotSchema.safeParse({ ...base, capacity: "0" }).success).toBe(false);
  });
});

describe("Konfiguration und Texte", () => {
  it("AUTH_ADMIN muss explizit gesetzt sein", () => {
    expect(authAdminTarget({ AUTH_ADMIN: "local" })).toBe("local");
    expect(authAdminTarget({ AUTH_ADMIN: "supabase" })).toBe("supabase");
    expect(() => authAdminTarget({})).toThrow(/AUTH_ADMIN/);
  });

  it("Login führt auf die kanonische Adresse des Mandanten zurück", () => {
    expect(tenantUrl({ slug: "firma" }, "/admin", {}, { TENANT_BASE_URL_TEMPLATE: "https://{slug}.termine.example" })).toBe(
      "https://firma.termine.example/admin",
    );
    expect(tenantUrl({ slug: "firma", customDomain: "termine.kunde.at" }, "/admin/login", { error: "no_access" }, {})).toBe(
      "https://termine.kunde.at/admin/login?error=no_access",
    );
    expect(tenantUrl({ slug: "demo" }, "/api/auth/session", { ticket: "T" }, { APP_BASE_URL: "http://localhost:3000" })).toBe(
      "http://localhost:3000/api/auth/session?tenant=demo&ticket=T",
    );
  });

  it("jeder Admin-Fehlercode hat einen Text", () => {
    for (const code of ADMIN_ERROR_CODES) expect(ADMIN_TEXTS[`error.${code}`]).toBeTruthy();
  });
});
