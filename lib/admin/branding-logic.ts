/**
 * Erscheinungsbild: welche Theme-Felder im Admin pflegbar sind und wie sie
 * gespeichert werden (reine Logik, auch im Browser für Vorschau/Prüfung).
 */
import { z } from "zod";
import { DEFAULT_THEME, parseTheme, themeInputSchema, type Theme } from "@/lib/theme/schema";
import { FONT_NAMES } from "@/lib/theme/font-names";
import { checkThemeContrast, TEXT_PAIRS, type ContrastIssue } from "@/lib/theme/contrast";

/** Im Admin pflegbare Farben; paint = Farbe ODER linear-gradient */
export const BRANDING_COLORS = [
  { key: "headerBg", group: "header" },
  { key: "headerInk", group: "header" },
  { key: "accentStrip", group: "header", paint: true },
  { key: "heroBg", group: "hero", paint: true },
  { key: "heroInk", group: "hero" },
  { key: "primary", group: "buttons" },
  { key: "onPrimary", group: "buttons" },
  { key: "link", group: "buttons" },
  { key: "bg", group: "page" },
  { key: "surface", group: "page" },
  { key: "ink", group: "page" },
] as const satisfies readonly { key: keyof typeof DEFAULT_THEME; group: string; paint?: boolean }[];

export type BrandingColorKey = (typeof BRANDING_COLORS)[number]["key"];
export const BRANDING_GROUPS = ["header", "hero", "buttons", "page"] as const;

/** Felder, die aus anderen folgen und beim Speichern entfernt werden */
const DERIVED: (keyof typeof DEFAULT_THEME)[] = ["heroSub", "headerLine"];

export const brandingInputSchema = z.object({
  claim: z
    .string()
    .trim()
    .max(120)
    .transform((v) => v || null),
  fontBody: z.enum(FONT_NAMES),
  fontDisplay: z.enum(FONT_NAMES),
  colors: z.record(z.enum(BRANDING_COLORS.map((c) => c.key) as [BrandingColorKey, ...BrandingColorKey[]]), z.string().trim().max(300)),
});
export type BrandingInput = z.infer<typeof brandingInputSchema>;

/** Paare (Text/Hintergrund), die das Admin-Formular beeinflusst */
const EDITABLE = new Set<string>([...BRANDING_COLORS.map((c) => c.key), ...DERIVED]);
const RELEVANT_PAIRS = TEXT_PAIRS.filter(([fg, bg]) => EDITABLE.has(fg) || EDITABLE.has(bg));

/** Kontrastprobleme der pflegbaren Farben (für Formular und Speichern) */
export function brandingContrastIssues(theme: Theme): ContrastIssue[] {
  const relevant = new Set(RELEVANT_PAIRS.map(([fg, bg]) => `${fg}|${bg}`));
  return checkThemeContrast(theme as unknown as Record<string, string>).filter((i) => relevant.has(`${i.fg}|${i.bg.split(" ")[0]}`));
}

export type MergeResult = { ok: true; theme: Record<string, string> } | { ok: false; error: "invalid_input" | "contrast_too_low" };

/**
 * Bestehendes Theme + Eingaben -> zu speicherndes Theme. Ungültige Altwerte
 * werden verworfen, abgeleitete Felder folgen danach wieder ihrer Basis.
 */
export function mergeBrandingTheme(current: unknown, input: BrandingInput): MergeResult {
  const base: Record<string, string> = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [k, v] of Object.entries(current)) {
      if (typeof v !== "string" || DERIVED.includes(k as keyof typeof DEFAULT_THEME)) continue;
      if (themeInputSchema.safeParse({ [k]: v }).success) base[k] = v;
    }
  }
  const next: Record<string, string> = { ...base, fontBody: input.fontBody, fontDisplay: input.fontDisplay };
  for (const c of BRANDING_COLORS) {
    const v = input.colors[c.key];
    if (v) next[c.key] = normalizeColor(v);
  }
  if (!themeInputSchema.safeParse(next).success) return { ok: false, error: "invalid_input" };
  if (brandingContrastIssues(parseTheme(next)).length) return { ok: false, error: "contrast_too_low" };
  return { ok: true, theme: next };
}

/** #abc -> #AABBCC (einheitlich für Farbwähler) */
export function normalizeColor(v: string): string {
  const s = v.trim();
  const m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) return `#${[...m[1]!].map((c) => c + c).join("")}`.toUpperCase();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : s;
}
