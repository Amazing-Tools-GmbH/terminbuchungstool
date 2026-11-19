import { describe, expect, it } from "vitest";
import { bookingIcsUrl, bookingUrl } from "@/lib/links";

describe("Öffentliche Links (zentral, Mandant aus dem Token)", () => {
  it("unter APP_BASE_URL, ohne Slug und ohne ?tenant=", () => {
    expect(bookingUrl({ slug: "demo" }, "tok", { APP_BASE_URL: "http://localhost:3000/" })).toBe("http://localhost:3000/b/tok");
    expect(bookingIcsUrl({ slug: "demo" }, "tok", { APP_BASE_URL: "https://atools.de/meetings" })).toBe("https://atools.de/meetings/b/tok/ics");
  });
  it("eigene Domain des Kunden hat Vorrang (mit Unterpfad)", () => {
    expect(bookingUrl({ slug: "demo", customDomain: "buchen.kunde.at" }, "tok", { APP_BASE_URL: "https://atools.de/meetings" })).toBe(
      "https://buchen.kunde.at/meetings/b/tok",
    );
  });
});
