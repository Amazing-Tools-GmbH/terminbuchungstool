import type { Theme } from "./schema";
import { fontStack } from "./font-stack";

/** Theme-Schlüssel -> CSS-Variable (camelCase -> --tb-kebab-case) */
export function cssVarName(key: string): string {
  return `--tb-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Erzeugt die CSS-Variablen eines Themes. Die Werte sind durch das
 * zod-Schema bereits auf sichere Muster beschränkt.
 */
export function themeToCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (key === "fontBody" || key === "fontDisplay") continue;
    vars[cssVarName(key)] = value;
  }
  vars["--tb-font-body"] = fontStack(theme.fontBody);
  vars["--tb-font-display"] = fontStack(theme.fontDisplay);
  return vars;
}

/** Als CSS-Regelblock, z. B. für <style>:root{...}</style> */
export function themeToCssText(theme: Theme, selector = ":root"): string {
  const body = Object.entries(themeToCssVars(theme))
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  return `${selector}{${body}}`;
}
