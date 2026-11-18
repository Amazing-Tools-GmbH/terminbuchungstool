import { describe, expect, it } from "vitest";
import { bookingIcsUrl, bookingUrl } from "@/lib/links";

describe("Öffentliche Links", () => {
  it("Entwicklung: APP_BASE_URL + ?tenant=", () => {
    expect(bookingUrl({ slug: "demo" }, "tok", { APP_BASE_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000/b/tok?tenant=demo",
    );
  });
  it("Vorlage mit {slug} (Subdomain oder Pfad)", () => {
    expect(bookingUrl({ slug: "antennevorarlberg" }, "tok", { TENANT_BASE_URL_TEMPLATE: "https://{slug}.termine.example.at" })).toBe(
      "https://antennevorarlberg.termine.example.at/b/tok",
    );
    expect(bookingIcsUrl({ slug: "demo" }, "tok", { TENANT_BASE_URL_TEMPLATE: "https://termine.example.at/{slug}/" })).toBe(
      "https://termine.example.at/demo/b/tok/ics",
    );
  });
  it("eigene Domain hat Vorrang", () => {
    expect(bookingUrl({ slug: "demo", customDomain: "buchen.kunde.at" }, "tok", { TENANT_BASE_URL_TEMPLATE: "https://{slug}.x.at" })).toBe(
      "https://buchen.kunde.at/b/tok",
    );
  });
});
