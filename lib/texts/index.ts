/**
 * Oberflächentexte der Buchungsseite und Mails.
 * - Jeder Text hat eine Variante je Anrede ("sie" | "ihr"), Quelle: Mock-up (COPY).
 * - Ein Mandant kann einzelne Texte über tenants.text_overrides überschreiben.
 * - Platzhalter: {name} -> wird aus vars ersetzt.
 * Kein kundenspezifischer Text im Code – nur Varianten je Anrede.
 */
import { z } from "zod";

export type Anrede = "sie" | "ihr";

type Variants = { sie: string; ihr: string };
const same = (s: string): Variants => ({ sie: s, ihr: s });

export const TEXTS = {
  "page.title": same("Terminbuchung"),
  "header.invited": same("Eingeladen:"),
  "hero.eyebrow": same("Einladung"),
  "hero.intro": {
    ihr: "Wählt euren Wunschtermin. Bei jedem Termin seht ihr, wie viele Plätze noch frei sind.",
    sie: "Wählen Sie Ihren Wunschtermin. Bei jedem Termin sehen Sie, wie viele Plätze noch frei sind.",
  },
  "slots.title": same("Termine"),
  "slots.free": same("{free} von {capacity} Plätzen frei"),
  "slots.freeOne": same("1 von {capacity} Plätzen frei"),
  "slots.full": same("Ausgebucht"),
  "slots.empty": same("Aktuell sind keine Termine verfügbar."),
  "aside.title": { ihr: "Eure Buchung", sie: "Ihre Buchung" },
  "aside.noSelection": { ihr: "Bitte wählt links einen Termin.", sie: "Bitte wählen Sie links einen Termin." },
  "aside.seats": same("Anzahl Teilnehmer"),
  "aside.seatsLess": same("Weniger Teilnehmer"),
  "aside.seatsMore": same("Mehr Teilnehmer"),
  "aside.seatsMax": same("max. {max}"),
  "aside.name": same("Name"),
  "aside.email": same("E-Mail"),
  "aside.extra": same("Namen weiterer Teilnehmer (optional)"),
  "aside.extraPlaceholder": same("z. B. Max Beispiel, Eva Probe"),
  "aside.submit": same("Verbindlich buchen"),
  "aside.help": {
    ihr: "Ihr bekommt sofort eine Bestätigung mit Kalenderdatei per E-Mail.",
    sie: "Sie erhalten sofort eine Bestätigung mit Kalenderdatei per E-Mail.",
  },
  "done.title": { ihr: "Danke, euer Termin ist gebucht!", sie: "Danke, Ihr Termin ist gebucht." },
  "done.text": {
    ihr: "Eure Bestätigung mit Kalenderdatei ist unterwegs an",
    sie: "Ihre Bestätigung mit Kalenderdatei ist unterwegs an",
  },
  "done.date": same("Datum"),
  "done.time": same("Uhrzeit"),
  "done.place": same("Ort"),
  "done.seats": same("Teilnehmer"),
  "done.ics": same("Kalenderdatei (.ics)"),
  "done.google": same("Google Kalender"),
  "done.outlook": same("Outlook"),
  "done.change": same("Buchung ändern"),
  "done.cancel": same("Buchung stornieren"),
  "footer.legal": same("Rechtliches"),
  "home.useLink": {
    ihr: "Bitte nutzt den persönlichen Buchungslink aus eurer Einladung.",
    sie: "Bitte nutzen Sie den persönlichen Buchungslink aus Ihrer Einladung.",
  },
} as const satisfies Record<string, Variants>;

export type TextKey = keyof typeof TEXTS;
export const TEXT_KEYS = Object.keys(TEXTS) as TextKey[];

/** Prüfschema für tenants.text_overrides beim Speichern (nur bekannte Schlüssel) */
export const textOverridesSchema = z.record(z.enum(TEXT_KEYS as [TextKey, ...TextKey[]]), z.string().trim().min(1).max(500));
export type TextOverrides = Partial<Record<TextKey, string>>;

/** Liest Overrides aus der DB robust ein: unbekannte/ungültige Einträge werden ignoriert. */
export function parseTextOverrides(raw: unknown): TextOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TextOverrides = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k in TEXTS && typeof v === "string" && v.trim() && v.length <= 500) out[k as TextKey] = v;
  }
  return out;
}

export type Translator = (key: TextKey, vars?: Record<string, string | number>) => string;

export function createTranslator(anrede: Anrede, overrides: TextOverrides = {}): Translator {
  return (key, vars) => {
    const template = overrides[key] ?? TEXTS[key][anrede];
    return vars ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : template;
  };
}
