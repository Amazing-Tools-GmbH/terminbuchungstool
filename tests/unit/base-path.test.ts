/** Unterpfad (basePath) aus APP_BASE_URL: Links, Mail-Links, OAuth-Callbacks */
import { describe, expect, it } from "vitest";
import { basePathFrom, cookiePath, normalizeBasePath, withBasePath } from "@/lib/base-path";
import { bookingIcsUrl, bookingUrl } from "@/lib/links";
import { appUrl } from "@/lib/auth/urls";
import { oauthConfig } from "@/lib/pipedrive/client";
import { mailOAuthConfig } from "@/lib/mail/oauth";

const PROD = { APP_BASE_URL: "https://atools.de/meetings" };

describe("Unterpfad", () => {
  it("aus APP_BASE_URL abgeleitet", () => {
    expect(basePathFrom(PROD)).toBe("/meetings");
    expect(basePathFrom({ APP_BASE_URL: "https://atools.de/meetings/" })).toBe("/meetings");
    expect(basePathFrom({ APP_BASE_URL: "http://localhost:3000" })).toBe("");
    expect(basePathFrom({})).toBe("");
    // NEXT_PUBLIC_BASE_PATH (aus next.config) hat Vorrang
    expect(basePathFrom({ NEXT_PUBLIC_BASE_PATH: "/x", APP_BASE_URL: "https://a.de/meetings" })).toBe("/x");
  });

  it("nur sichere Pfade", () => {
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("/a/b")).toBe("/a/b");
    expect(() => normalizeBasePath("/a b")).toThrow();
    expect(() => normalizeBasePath("javascript:alert(1)")).toThrow();
  });

  it("Pfade und Cookie-Pfade", () => {
    expect(withBasePath("/api/bookings", "/meetings")).toBe("/meetings/api/bookings");
    expect(withBasePath("/api/bookings", "")).toBe("/api/bookings");
    expect(() => withBasePath("api", "/meetings")).toThrow();
    expect(cookiePath("", "/meetings")).toBe("/meetings");
    expect(cookiePath("/api/auth", "/meetings")).toBe("/meetings/api/auth");
    expect(cookiePath("", "")).toBe("/");
  });
});

describe("Links in Mails und Redirects mit Unterpfad", () => {
  it("Buchungslinks: zentral bzw. eigene Domain, jeweils mit Unterpfad", () => {
    expect(bookingUrl({ slug: "antenne" }, "TOK", PROD)).toBe("https://atools.de/meetings/b/TOK");
    expect(bookingIcsUrl({ slug: "antenne" }, "TOK", PROD)).toBe("https://atools.de/meetings/b/TOK/ics");
    expect(bookingUrl({ slug: "antenne", customDomain: "termine.kunde.at" }, "TOK", PROD)).toBe("https://termine.kunde.at/meetings/b/TOK");
  });

  it("Redirects (Login, Admin) zentral inkl. Unterpfad", () => {
    expect(appUrl("/admin/login", { error: "expired" }, PROD)).toBe("https://atools.de/meetings/admin/login?error=expired");
    expect(appUrl("/settings", {}, PROD)).toBe("https://atools.de/meetings/settings");
  });

  it("OAuth-Callbacks unter dem Unterpfad", () => {
    expect(oauthConfig({ ...PROD, PIPEDRIVE_CLIENT_ID: "c", PIPEDRIVE_CLIENT_SECRET: "s" })?.redirectUri).toBe(
      "https://atools.de/meetings/api/auth/pipedrive/callback",
    );
    expect(mailOAuthConfig("google", { ...PROD, GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s" })?.redirectUri).toBe(
      "https://atools.de/meetings/api/mail/oauth/google/callback",
    );
  });
});
