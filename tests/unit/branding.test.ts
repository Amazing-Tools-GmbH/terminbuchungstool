/** Erscheinungsbild: Logo-Prüfung und Speichern der Farben */
import { describe, expect, it } from "vitest";
import { detectImageType, svgIsSafe } from "@/lib/admin/branding";
import { mergeBrandingTheme, normalizeColor } from "@/lib/admin/branding-logic";
import { DEFAULT_THEME, parseTheme } from "@/lib/theme/schema";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const colors = Object.fromEntries(
  (["headerBg", "headerInk", "accentStrip", "heroBg", "heroInk", "primary", "onPrimary", "link", "bg", "surface", "ink"] as const).map((k) => [k, DEFAULT_THEME[k]]),
);
const input = (over: Record<string, string> = {}) => ({ claim: null, fontBody: "Inter" as const, fontDisplay: "Inter" as const, colors: { ...colors, ...over } });

describe("Logo", () => {
  it("erkennt den Typ am Inhalt", () => {
    expect(detectImageType(PNG)?.ext).toBe("png");
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(detectImageType(Buffer.from("RIFF0000WEBPVP8 "))?.ext).toBe("webp");
    expect(detectImageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.ext).toBe("svg");
    expect(detectImageType(Buffer.from("<html><svg></svg></html>"))).toBeNull();
    expect(detectImageType(Buffer.from("GIF89a"))).toBeNull();
  });

  it("SVG nur ohne aktive Inhalte", () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>';
    expect(svgIsSafe(ok)).toBe(true);
    expect(svgIsSafe('<svg><script>alert(1)</script></svg>')).toBe(false);
    expect(svgIsSafe('<svg onload="alert(1)"></svg>')).toBe(false);
    expect(svgIsSafe('<svg><a href="javascript:alert(1)"/></svg>')).toBe(false);
    expect(svgIsSafe('<svg><image href="https://evil.example/x.png"/></svg>')).toBe(false);
    expect(svgIsSafe('<svg><foreignObject><div/></foreignObject></svg>')).toBe(false);
    expect(svgIsSafe('<svg style="background:url(https://x.example/a)"></svg>')).toBe(false);
  });
});

describe("Farben speichern", () => {
  it("übernimmt Eingaben, behält übrige Theme-Werte, abgeleitete folgen der Basis", () => {
    const current = { headerBg: "#FFE500", headerLine: "#FFE500", heroSub: "#111111", dayColor: "#111111", radius: "6px", kaputt: "x;}" };
    const r = mergeBrandingTheme(current, input({ headerBg: "#fff", heroBg: "linear-gradient(90deg, #FFFFFF 0%, #EEEEEE 100%)" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.theme.headerBg).toBe("#FFFFFF");
    expect(r.theme.heroBg).toBe("linear-gradient(90deg, #FFFFFF 0%, #EEEEEE 100%)");
    expect(r.theme.dayColor).toBe("#111111");
    expect(r.theme.radius).toBe("6px");
    expect(r.theme).not.toHaveProperty("kaputt");
    expect(r.theme).not.toHaveProperty("headerLine");
    expect(r.theme).not.toHaveProperty("heroSub");
  });

  it("lehnt CSS-Injection ab; Farbwahl (auch schwacher Kontrast) liegt beim Kunden", () => {
    expect(mergeBrandingTheme({}, input({ primary: "red;}body{x" }))).toEqual({ ok: false, error: "invalid_input" });
    expect(mergeBrandingTheme({}, input({ primary: "#FFFFFF", onPrimary: "#FFFF00" }))).toMatchObject({ ok: true, theme: { primary: "#FFFFFF", onPrimary: "#FFFF00" } });
  });

  it("Seed-Theme ANTENNE ist speicherbar", async () => {
    const { SEED_TENANTS } = await import("@/seed/tenants");
    for (const s of SEED_TENANTS) {
      const th = parseTheme(s.theme);
      const r = mergeBrandingTheme(s.theme, {
        claim: s.claim,
        fontBody: th.fontBody,
        fontDisplay: th.fontDisplay,
        colors: Object.fromEntries(Object.keys(colors).map((k) => [k, th[k as keyof typeof th]])),
      });
      expect(r.ok, s.slug).toBe(true);
    }
  });

  it("normalizeColor", () => {
    expect(normalizeColor("#abc")).toBe("#AABBCC");
    expect(normalizeColor(" #a1b2c3 ")).toBe("#A1B2C3");
    expect(normalizeColor("linear-gradient(90deg, #fff 0%, #000 100%)")).toBe("linear-gradient(90deg, #fff 0%, #000 100%)");
  });
});
