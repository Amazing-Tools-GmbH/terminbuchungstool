/** Selbst gehostete Schriften: jede Allowlist-Schrift hat Dateien und eine CSS-Variable; kein Google beim Build */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { FONT_NAMES } from "@/lib/theme/font-names";
import { fontVarName } from "@/lib/theme/font-stack";

const css = readFileSync("app/fonts.css", "utf8");

describe("Schriften", () => {
  it.each(FONT_NAMES.map((n) => [n]))("%s: @font-face mit vorhandener woff2-Datei und Variable", (name) => {
    const faces = [...css.matchAll(new RegExp(`font-family: "${name}";[^}]*?src: url\\("([^"]+)"\\)`, "g"))];
    expect(faces.length).toBeGreaterThan(0);
    for (const [, url] of faces) {
      expect(url).toMatch(/^\/fonts\/[a-z0-9-]+\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(`public${url}`)).toBe(true);
    }
    expect(css).toContain(`${fontVarName(name)}: "${name}";`);
  });

  it("Download-Skript kennt genau die Allowlist", () => {
    const script = readFileSync("scripts/fonts-download.mjs", "utf8");
    for (const name of FONT_NAMES) expect(script).toContain(`["${name}", [`);
  });

  it("kein next/font/google mehr im Code (Build ohne Google)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : [],
      );
    const offenders = ["app", "lib", "components"].flatMap(walk).filter((f) => readFileSync(f, "utf8").includes("next/font/google"));
    expect(offenders).toEqual([]);
  });
});
