import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, parseTheme, themeInputSchema } from "@/lib/theme/schema";
import { themeToCssText, themeToCssVars } from "@/lib/theme/css";
import { checkThemeContrast } from "@/lib/theme/contrast";
import { SEED_TENANTS } from "@/seed/tenants";

describe("parseTheme", () => {
  it("leeres oder kaputtes Theme -> Defaults", () => {
    expect(parseTheme({})).toEqual(DEFAULT_THEME);
    expect(parseTheme(null)).toEqual(DEFAULT_THEME);
    expect(parseTheme("x")).toEqual(DEFAULT_THEME);
    expect(parseTheme([])).toEqual(DEFAULT_THEME);
  });

  it("ungültige Einzelwerte fallen auf Default zurück, gültige bleiben", () => {
    const t = parseTheme({ primary: "#111111", ink: "red", radius: "999px", fontBody: "Comic Sans" });
    expect(t.primary).toBe("#111111");
    expect(t.ink).toBe(DEFAULT_THEME.ink);
    expect(t.radius).toBe(DEFAULT_THEME.radius);
    expect(t.fontBody).toBe(DEFAULT_THEME.fontBody);
  });

  it("blockiert CSS-Injection", () => {
    const evil = [
      "#fff;} body{display:none",
      "url(https://evil.example/x.png)",
      "linear-gradient(90deg, #fff 0%, #000 100%); background:url(x)",
      "expression(alert(1))",
      "var(--x)",
    ];
    for (const v of evil) {
      const t = parseTheme({ heroBg: v, primary: v, accentStrip: v });
      expect(t.heroBg).toBe(DEFAULT_THEME.heroBg);
      expect(t.primary).toBe(DEFAULT_THEME.primary);
      expect(t.accentStrip).toBe(DEFAULT_THEME.accentStrip);
    }
  });

  it("erlaubt Verläufe aus Hex-Farben", () => {
    const g = "linear-gradient(100deg, #FFE500 0%, #FFE500 30%, #FFC70F 52%, #FD8F22 74%, #F96A2D 100%)";
    expect(parseTheme({ heroBg: g }).heroBg).toBe(g);
  });

  it("abgeleitete Felder folgen ihrer Basis", () => {
    const t = parseTheme({ primary: "#111111", heroInk: "#222222", headerBg: "#FFE500", line: "#E4E2DC" });
    expect(t.link).toBe("#111111");
    expect(t.heroSub).toBe("#222222");
    expect(t.headerLine).toBe("#FFE500");
    expect(t.selectedLine).toBe("#E4E2DC");
  });

  it("strenges Eingabeschema meldet Fehler statt Fallback", () => {
    expect(themeInputSchema.safeParse({ primary: "rot" }).success).toBe(false);
    expect(themeInputSchema.safeParse({ unbekannt: "#fff" }).success).toBe(false);
    expect(themeInputSchema.safeParse({ primary: "#FFFFFF", fontBody: "Overpass" }).success).toBe(true);
  });
});

describe("CSS-Variablen", () => {
  it("erzeugt --tb-* Variablen inkl. Schriftstapel", () => {
    const vars = themeToCssVars(parseTheme({ fontBody: "Overpass" }));
    expect(vars["--tb-primary"]).toBe(DEFAULT_THEME.primary);
    expect(vars["--tb-selected-bg"]).toBe(DEFAULT_THEME.selectedBg);
    expect(vars["--tb-font-body"]).toMatch(/^var\(--font-overpass\), /);
    expect(themeToCssText(parseTheme({}))).toMatch(/^:root\{--tb-/);
  });
});

describe("Seed-Themes", () => {
  it.each(SEED_TENANTS.map((t) => [t.slug, t] as const))("%s: gültig und Kontrast mind. 4.5:1", (_slug, t) => {
    expect(themeInputSchema.safeParse(t.theme).success).toBe(true);
    expect(checkThemeContrast(parseTheme(t.theme))).toEqual([]);
  });

  it("Default-Theme erfüllt Kontrast", () => {
    expect(checkThemeContrast(DEFAULT_THEME)).toEqual([]);
  });

  it("ANTENNE: Header-Farbe entspricht exakt dem Logo-Hintergrund", async () => {
    const { readFile } = await import("node:fs/promises");
    const svg = await readFile("seed/assets/logo-antenne-vorarlberg.svg", "utf8");
    const antenne = SEED_TENANTS.find((t) => t.slug === "antennevorarlberg")!;
    expect(svg).toContain(`fill="${antenne.theme.headerBg}"`);
  });
});
