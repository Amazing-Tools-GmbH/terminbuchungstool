import { describe, expect, it } from "vitest";
import { appBaseUrl, bookingIcsUrl, bookingUrl } from "@/lib/links";
import { appUrl } from "@/lib/auth/urls";
import { oauthConfig } from "@/lib/pipedrive/client";

const PROD = { APP_BASE_URL: "https://meetings.atools.de" };

describe("Öffentliche Links (Root, Mandant aus dem Token)", () => {
  it("unter APP_BASE_URL, ohne Slug, ohne Unterpfad", () => {
    expect(bookingUrl({ slug: "demo" }, "tok", PROD)).toBe("https://meetings.atools.de/b/tok");
    expect(bookingIcsUrl({ slug: "demo" }, "tok", PROD)).toBe("https://meetings.atools.de/b/tok/ics");
    expect(bookingUrl({ slug: "demo" }, "tok", { APP_BASE_URL: "http://localhost:3000/" })).toBe("http://localhost:3000/b/tok");
  });
  it("eigene Domain des Kunden hat Vorrang", () => {
    expect(bookingUrl({ slug: "demo", customDomain: "buchen.kunde.at" }, "tok", PROD)).toBe("https://buchen.kunde.at/b/tok");
  });
  it("nur der Origin zählt (abschließender Schrägstrich, versehentlicher Pfad)", () => {
    expect(appBaseUrl({ APP_BASE_URL: "https://meetings.atools.de/" })).toBe("https://meetings.atools.de");
    expect(appBaseUrl({ APP_BASE_URL: "https://meetings.atools.de/meetings" })).toBe("https://meetings.atools.de");
  });
  it("Redirects und Pipedrive-Callback", () => {
    expect(appUrl("/admin/login", { error: "cancelled" }, PROD)).toBe("https://meetings.atools.de/admin/login?error=cancelled");
    expect(oauthConfig({ ...PROD, PIPEDRIVE_CLIENT_ID: "a", PIPEDRIVE_CLIENT_SECRET: "b" })?.redirectUri).toBe(
      "https://meetings.atools.de/api/auth/pipedrive/callback",
    );
  });
});
