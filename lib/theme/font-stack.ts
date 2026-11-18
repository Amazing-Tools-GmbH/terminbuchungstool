import type { FontName } from "./font-names";

const SERIF: ReadonlySet<FontName> = new Set(["Merriweather", "Lora"]);

/**
 * CSS-Schriftstapel für eine Allowlist-Schrift. Verweist auf die
 * CSS-Variable, die next/font für die selbst gehostete Schrift setzt
 * (lib/theme/fonts.ts), mit Systemschrift als Fallback.
 */
export function fontStack(name: FontName): string {
  const fallback = SERIF.has(name) ? "Georgia, 'Times New Roman', serif" : "system-ui, -apple-system, 'Segoe UI', sans-serif";
  return `var(${fontVarName(name)}), ${fallback}`;
}

export function fontVarName(name: FontName): string {
  return `--font-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
