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

describe("Installationslink", () => {
  it("leitet ohne state zur Pipedrive-Freigabe mit zentralem Callback", async () => {
    const { GET: install } = await import("@/app/api/auth/pipedrive/install/route");
    const res = await install();
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://oauth.pipedrive.com/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/pipedrive/callback`);
    expect(loc.searchParams.has("state")).toBe(false);
  });

  it("ohne OAuth-App -> Login-Seite mit Hinweis", async () => {
    vi.stubEnv("PIPEDRIVE_CLIENT_ID", "");
    const { GET: install } = await import("@/app/api/auth/pipedrive/install/route");
    const res = await install();
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=not_configured`);
  });
});
