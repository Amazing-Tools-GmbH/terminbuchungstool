/** Einstieg aus den Pipedrive-App-Einstellungen: JWT-Prüfung und Buchungslink-Pfad */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { settingsJwtSecret, verifySettingsToken, SETTINGS_TOKEN_MAX_AGE_SECONDS } from "@/lib/pipedrive/settings-token";
import { bookingTokenFromPath, decodeTenantKey, encodeTenantKey } from "@/lib/tenant/host";

const SECRET = "app-secret";
const now = Date.UTC(2026, 10, 19, 12, 0, 0);
const nowS = now / 1000;

function jwt(claims: object, { secret = SECRET, alg = "HS256" } = {}) {
  const h = Buffer.from(JSON.stringify({ typ: "JWT", alg })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
const claims = { userId: 14503375, companyId: 5537516, iat: nowS - 5, exp: nowS + 3595 };
const q = (token: string, userId = "14503375", companyId = "5537516") => ({ token, userId, companyId });

describe("Pipedrive-Settings-Token", () => {
  it("gültiges Token -> Benutzer + Firma", () => {
    expect(verifySettingsToken(q(jwt(claims)), SECRET, now)).toEqual({ ok: true, identity: { userId: 14503375, companyId: 5537516 } });
  });

  it.each([
    ["fremde Signatur", q(jwt(claims, { secret: "anders" })), "bad_signature"],
    ["alg none", q(jwt(claims, { alg: "none" })), "malformed"],
    ["abgelaufen", q(jwt({ ...claims, iat: nowS - 7200, exp: nowS - 3600 })), "expired"],
    ["zu alt (Link aus Verlauf)", q(jwt({ ...claims, iat: nowS - SETTINGS_TOKEN_MAX_AGE_SECONDS - 10 })), "too_old"],
    ["aus der Zukunft", q(jwt({ ...claims, iat: nowS + 600 })), "too_old"],
    ["userId vertauscht", q(jwt(claims), "1"), "mismatch"],
    ["companyId vertauscht", q(jwt(claims), "14503375", "1"), "mismatch"],
    ["kaputt", q("abc.def"), "malformed"],
    ["fehlt", { token: null, userId: "1", companyId: "1" }, "missing"],
  ] as const)("%s -> %s", (_label, input, error) => {
    expect(verifySettingsToken(input, SECRET, now)).toEqual({ ok: false, error });
  });

  it("ohne Geheimnis nicht konfiguriert; PIPEDRIVE_JWT_SECRET vor Client-Secret", () => {
    expect(verifySettingsToken(q(jwt(claims)), null, now)).toEqual({ ok: false, error: "not_configured" });
    expect(settingsJwtSecret({ PIPEDRIVE_CLIENT_SECRET: "c" })).toBe("c");
    expect(settingsJwtSecret({ PIPEDRIVE_CLIENT_SECRET: "c", PIPEDRIVE_JWT_SECRET: "j" })).toBe("j");
    expect(settingsJwtSecret({})).toBeNull();
  });
});

describe("Buchungslink im Pfad", () => {
  const tok = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-abcdefg";
  it("erkennt /b/<token> und /b/<token>/ics", () => {
    expect(bookingTokenFromPath(`/b/${tok}`)).toBe(tok);
    expect(bookingTokenFromPath(`/b/${tok}/ics`)).toBe(tok);
    expect(bookingTokenFromPath("/b/kurz")).toBeNull();
    expect(bookingTokenFromPath(`/admin/b/${tok}`)).toBeNull();
    expect(bookingTokenFromPath("/b/../../etc")).toBeNull();
  });
  it("Mandanten-Schlüssel mit Token (und optional Kundendomain) überlebt Kodierung", () => {
    for (const key of [
      { kind: "token" as const, token: tok, domain: null },
      { kind: "token" as const, token: tok, domain: "termine.kunde.at" },
    ]) {
      expect(decodeTenantKey(encodeTenantKey(key))).toEqual(key);
    }
    expect(decodeTenantKey("token:-:kurz")).toBeNull();
    expect(decodeTenantKey(`token:evil host:${tok}`)).toBeNull();
  });
});
