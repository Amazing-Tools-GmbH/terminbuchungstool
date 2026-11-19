/**
 * Allowlist der Schriften, die ein Mandant wählen kann.
 * Neue Schrift = hier eintragen UND in lib/theme/fonts.ts laden.
 * (Getrennt von fonts.ts, damit Schema/Tests ohne next/font auskommen.)
 */
export const FONT_NAMES = [
  "Overpass",
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Source Sans 3",
  "Nunito Sans",
  "Work Sans",
  "IBM Plex Sans",
  "Merriweather",
  "Lora",
] as const;

export type FontName = (typeof FONT_NAMES)[number];
