/** WCAG-2.x-Kontrast (für Prüfung von Themes, Ziel: mind. 4.5:1 für Text) */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alle Hex-Farben eines Werts (Farbe oder linear-gradient) */
export function colorsOf(paint: string): string[] {
  return paint.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [];
}

/** Text-/Hintergrund-Paare eines Themes, die mind. 4.5:1 erreichen müssen */
export const TEXT_PAIRS = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["muted", "surface"],
  ["muted", "bg"],
  ["link", "surface"],
  ["dayColor", "surface"],
  ["onPrimary", "primary"],
  ["headerInk", "headerBg"],
  ["heroInk", "heroBg"],
  ["heroSub", "heroBg"],
  ["footerInk", "footerBg"],
  ["ink", "selectedBg"],
] as const;

export type ContrastIssue = { fg: string; bg: string; ratio: number };

/** Liefert alle Paare unter dem Mindestkontrast (bei Verläufen: jede Farbstufe) */
export function checkThemeContrast(theme: Record<string, string>, min = 4.5): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const [fgKey, bgKey] of TEXT_PAIRS) {
    const fg = theme[fgKey];
    const bgPaint = theme[bgKey];
    if (!fg || !bgPaint) continue;
    for (const bg of colorsOf(bgPaint)) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < min) issues.push({ fg: fgKey, bg: `${bgKey} (${bg})`, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return issues;
}
