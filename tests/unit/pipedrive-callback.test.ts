/** Zentrale Pipedrive-Callback-Route: Abbruch, fehlender State, Adressen im Root */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const BASE = "https://meetings.atools.de";
let GET: typeof import("@/app/api/auth/pipedrive/callback/route").GET;

beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("PIPEDRIVE_CLIENT_ID", "cid");
  vi.stubEnv("PIPEDRIVE_CLIENT_SECRET", "csecret");
  ({ GET } = await import("@/app/api/auth/pipedrive/callback/route"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const call = (q: string) => GET(new NextRequest(`${BASE}/api/auth/pipedrive/callback${q}`));

describe("Pipedrive-Callback", () => {
  it.each([
    ["?error=user_denied", "cancelled"],
    ["?error=user_denied&state=abc", "cancelled"],
    ["?error=access_denied", "cancelled"],
    ["?error=server_error", "oauth_failed"],
  ])("%s -> Login-Seite mit Meldung, ohne Token-Anfrage", async (q, code) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(q);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=${code}`);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nonce-Cookie des Logins wird gelöscht
    expect(res.headers.get("set-cookie")).toMatch(/tb_login_nonce=;.*Path=\/api\/auth/);
  });

  it("Login mit ungültigem State -> abgelaufen", async () => {
    const res = await call("?code=x&state=kaputt");
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=expired`);
  });

  it("Installation ohne Code -> abgebrochen", async () => {
    const res = await call("");
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=cancelled`);
  });
});
