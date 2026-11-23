/**
 * Allowlist der Schriften, die ein Mandant wählen kann.
 * Neue Schrift = hier eintragen UND in scripts/fonts-download.mjs ergänzen,
 * Skript ausführen (legt public/fonts/… und app/fonts.css an), Ergebnis committen.
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
