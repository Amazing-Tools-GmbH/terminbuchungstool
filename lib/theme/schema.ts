/**
 * Theme-System: Jeder Mandant hat ein Theme-JSON (tenants.theme).
 * - Alle Felder optional; fehlende ODER ungültige Werte fallen auf den
 *   Default zurück (ein kaputtes Theme darf nie die Seite brechen).
 * - Werte werden streng geprüft, weil sie als CSS-Variablen in die Seite
 *   geschrieben werden (Schutz gegen CSS-Injection).
 * - Schriften nur aus der Allowlist (lib/theme/fonts.ts).
 */
import { z } from "zod";
import { FONT_NAMES, type FontName } from "./font-names";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// linear-gradient(<winkel>, <hex> <n>%, ...) – nur Hex-Farben und Prozentwerte
const GRADIENT =
  /^linear-gradient\(\s*\d{1,3}deg\s*(?:,\s*#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?:\s+\d{1,3}(?:\.\d+)?%)?\s*){2,8}\)$/;
const LENGTH = /^(?:0|\d{1,2}(?:\.\d+)?(?:px|rem))$/;

const color = (fallback: string) => z.string().trim().regex(HEX).catch(fallback);
const paint = (fallback: string) =>
  z
    .string()
    .trim()
    .refine((v) => HEX.test(v) || GRADIENT.test(v))
    .catch(fallback);
const length = (fallback: string) => z.string().trim().regex(LENGTH).catch(fallback);
const font = (fallback: FontName) => z.enum(FONT_NAMES).catch(fallback);

/** Neutrales Standard-Theme (entspricht "Standard (White-Label)" im Mock-up). */
export const DEFAULT_THEME = {
  fontBody: "Inter",
  fontDisplay: "Inter",
  primary: "#1F4FB4",
  onPrimary: "#FFFFFF",
  link: "#1F4FB4",
  headerBg: "#FFFFFF",
  headerInk: "#1B1F24",
  headerLine: "#E3E6EA",
  heroBg: "#FFFFFF",
  heroInk: "#1B1F24",
  heroSub: "#5B6470",
  accentStrip: "#1F4FB4",
  bg: "#F6F7F9",
  surface: "#FFFFFF",
  ink: "#1B1F24",
  muted: "#5B6470",
  line: "#E3E6EA",
  field: "#8A929C",
  dayColor: "#1F4FB4",
  selectedBg: "#EEF3FC",
  selectedLine: "#BFD0F0",
  footerBg: "#FFFFFF",
  footerInk: "#3D4550",
  radius: "12px",
  radiusSm: "8px",
} as const satisfies Record<string, string>;

export const themeSchema = z
  .object({
    fontBody: font(DEFAULT_THEME.fontBody),
    fontDisplay: font(DEFAULT_THEME.fontDisplay),
    primary: color(DEFAULT_THEME.primary),
    onPrimary: color(DEFAULT_THEME.onPrimary),
    link: color(DEFAULT_THEME.link),
    headerBg: color(DEFAULT_THEME.headerBg),
    headerInk: color(DEFAULT_THEME.headerInk),
    headerLine: color(DEFAULT_THEME.headerLine),
    heroBg: paint(DEFAULT_THEME.heroBg),
    heroInk: color(DEFAULT_THEME.heroInk),
    heroSub: color(DEFAULT_THEME.heroSub),
    accentStrip: paint(DEFAULT_THEME.accentStrip),
    bg: color(DEFAULT_THEME.bg),
    surface: color(DEFAULT_THEME.surface),
    ink: color(DEFAULT_THEME.ink),
    muted: color(DEFAULT_THEME.muted),
    line: color(DEFAULT_THEME.line),
    field: color(DEFAULT_THEME.field),
    dayColor: color(DEFAULT_THEME.dayColor),
    selectedBg: color(DEFAULT_THEME.selectedBg),
    selectedLine: color(DEFAULT_THEME.selectedLine),
    footerBg: color(DEFAULT_THEME.footerBg),
    footerInk: color(DEFAULT_THEME.footerInk),
    radius: length(DEFAULT_THEME.radius),
    radiusSm: length(DEFAULT_THEME.radiusSm),
  })
  // Felder, die im Theme fehlen, bekommen ihren Default; unbekannte werden verworfen
  .partial()
  .transform((t) => {
    const given = stripUndefined(t);
    const merged = { ...DEFAULT_THEME, ...given };
    // Abgeleitete Felder: fehlen sie, aber ist ihre "Basis" gesetzt, folgen
    // sie der Basis statt dem neutralen Default (ein Mandant muss nur die
    // Grundfarben pflegen).
    return {
      ...merged,
      link: given.link ?? given.primary ?? DEFAULT_THEME.link,
      heroSub: given.heroSub ?? given.heroInk ?? DEFAULT_THEME.heroSub,
      headerLine: given.headerLine ?? given.headerBg ?? DEFAULT_THEME.headerLine,
      selectedLine: given.selectedLine ?? given.line ?? DEFAULT_THEME.selectedLine,
    };
  });

export type Theme = { [K in keyof typeof DEFAULT_THEME]: K extends "fontBody" | "fontDisplay" ? FontName : string };

/**
 * Für die strikte Prüfung beim SPEICHERN (Admin/Onboarding): meldet
 * ungültige Felder, statt still auf Defaults zurückzufallen.
 */
export const themeInputSchema = z
  .object({
    fontBody: z.enum(FONT_NAMES),
    fontDisplay: z.enum(FONT_NAMES),
    heroBg: z.string().refine((v) => HEX.test(v) || GRADIENT.test(v), "Farbe (#RRGGBB) oder linear-gradient"),
    accentStrip: z.string().refine((v) => HEX.test(v) || GRADIENT.test(v), "Farbe (#RRGGBB) oder linear-gradient"),
    radius: z.string().regex(LENGTH, "z. B. 6px"),
    radiusSm: z.string().regex(LENGTH, "z. B. 4px"),
    ...Object.fromEntries(
      (Object.keys(DEFAULT_THEME) as (keyof typeof DEFAULT_THEME)[])
        .filter((k) => !["fontBody", "fontDisplay", "heroBg", "accentStrip", "radius", "radiusSm"].includes(k))
        .map((k) => [k, z.string().regex(HEX, "Farbe im Format #RRGGBB")]),
    ),
  })
  .partial()
  .strict();

/** Liest ein Theme aus der DB robust ein (nie Exception). */
export function parseTheme(raw: unknown): Theme {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return themeSchema.parse(input) as Theme;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
