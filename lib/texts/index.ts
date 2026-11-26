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
  "hero.introNoSeats": {
    ihr: "Wählt zuerst einen Tag und dann euren Wunschtermin.",
    sie: "Wählen Sie zuerst einen Tag und dann Ihren Wunschtermin.",
  },
  "slots.title": same("Termine"),
  "slots.free": same("{free} von {capacity} Plätzen frei"),
  "slots.freeOne": same("1 von {capacity} Plätzen frei"),
  "slots.full": same("Ausgebucht"),
  "slots.available": same("Plätze frei"),
  "slots.days": same("Verfügbare Tage"),
  "slots.onDay": same("Termine am {day}"),
  "slots.empty": same("Aktuell sind keine Termine verfügbar."),
  "aside.title": { ihr: "Eure Buchung", sie: "Ihre Buchung" },
  "aside.noSelection": { ihr: "Bitte wählt links einen Termin.", sie: "Bitte wählen Sie links einen Termin." },
  "aside.noSelectionStacked": { ihr: "Bitte wählt oben einen Termin.", sie: "Bitte wählen Sie oben einen Termin." },
  "aside.seats": same("Anzahl Teilnehmer"),
  "aside.seatsLess": same("Weniger Teilnehmer"),
  "aside.seatsMore": same("Mehr Teilnehmer"),
  "aside.seatsMax": same("max. {max}"),
  "aside.name": same("Name"),
  "aside.email": same("E-Mail"),
  "aside.organization": same("Firma (optional)"),
  "hero.public": same("Termin buchen"),
  "aside.extra": same("Weitere Teilnehmer (optional)"),
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
  "footer.legal": same("Rechtliches"),
  "slots.almostFull": same("Nur noch {free} Plätze frei"),
  "slots.selected": same("Ausgewählt"),
  "hero.expired": {
    ihr: "Dieser Buchungslink ist leider abgelaufen. Bitte meldet euch bei uns, wir schicken euch gern einen neuen.",
    sie: "Dieser Buchungslink ist leider abgelaufen. Bitte melden Sie sich bei uns, wir senden Ihnen gern einen neuen.",
  },
  "hero.unavailable": same("Für dieses Event sind derzeit keine Buchungen möglich."),
  "aside.submitting": same("Wird gebucht …"),
  "error.generic": {
    ihr: "Das hat leider nicht geklappt. Bitte versucht es noch einmal.",
    sie: "Das hat leider nicht geklappt. Bitte versuchen Sie es noch einmal.",
  },
  "error.not_enough_seats": {
    ihr: "Für diesen Termin sind nicht mehr genug Plätze frei. Bitte wählt weniger Teilnehmer oder einen anderen Termin.",
    sie: "Für diesen Termin sind nicht mehr genug Plätze frei. Bitte wählen Sie weniger Teilnehmer oder einen anderen Termin.",
  },
  "error.slot_not_available": {
    ihr: "Dieser Termin ist nicht mehr buchbar. Bitte wählt einen anderen.",
    sie: "Dieser Termin ist nicht mehr buchbar. Bitte wählen Sie einen anderen.",
  },
  "error.invitation_expired": {
    ihr: "Euer Buchungslink ist abgelaufen.",
    sie: "Ihr Buchungslink ist abgelaufen.",
  },
  "error.already_booked": {
    ihr: "Über diesen Link wurde bereits gebucht. Für Änderungen meldet euch bitte bei eurem Ansprechpartner.",
    sie: "Über diesen Link wurde bereits gebucht. Für Änderungen wenden Sie sich bitte an Ihren Ansprechpartner.",
  },
  "error.change_deadline_passed": {
    ihr: "Die Frist für Änderungen ist abgelaufen. Bitte ruft uns an.",
    sie: "Die Frist für Änderungen ist abgelaufen. Bitte kontaktieren Sie uns.",
  },
  "error.invalid_email": {
    ihr: "Bitte gebt eine gültige E-Mail-Adresse ein.",
    sie: "Bitte geben Sie eine gültige E-Mail-Adresse ein.",
  },
  "error.invalid_name": {
    ihr: "Bitte gebt euren Namen ein.",
    sie: "Bitte geben Sie Ihren Namen ein.",
  },
  "error.invalid_attendees": same("Es sind mehr weitere Teilnehmer eingetragen als Plätze gewählt."),
  "error.invalid_guest_email": same("Bitte gültige, unterschiedliche E-Mail-Adressen für die Teilnehmer angeben (nicht die eigene)."),
  "error.missing_guest_name": same("Bitte zu jeder E-Mail-Adresse auch den Namen angeben."),
  "done.seatsValue": same("{n}"),
  "done.attendees": same("Weitere Teilnehmer"),
  "done.contact": {
    ihr: "Ihr könnt nicht kommen oder müsst etwas ändern? Bitte meldet euch bei {name}.",
    sie: "Sie können nicht kommen oder müssen etwas ändern? Bitte wenden Sie sich an {name}.",
  },
  "done.contactFallback": {
    ihr: "Ihr könnt nicht kommen oder müsst etwas ändern? Bitte meldet euch direkt bei uns.",
    sie: "Sie können nicht kommen oder müssen etwas ändern? Bitte wenden Sie sich direkt an uns.",
  },
  "aside.guestsInvite": same("Weitere Teilnehmer erhalten eine eigene Einladung"),
  "aside.guestsInviteHint": same("Wer eine E-Mail-Adresse hat, bekommt den Termin per E-Mail mit Kalendereintrag."),
  "aside.guestName": same("Name Teilnehmer {n}"),
  "aside.guestEmail": same("E-Mail Teilnehmer {n} (optional)"),
  "done.guestInvited": same("Einladung an {email}"),
  "guest.eyebrow": same("Einladung"),
  "guest.title": same("Anmeldung bestätigt"),
  "guest.text": {
    ihr: "{booker} hat euch für diesen Termin angemeldet.",
    sie: "{booker} hat Sie für diesen Termin angemeldet.",
  },
  "guest.bookingEnded.title": same("Termin nicht mehr aktuell"),
  "guest.bookingEnded.text": same("Dieser Termin wurde abgesagt oder geändert. Bei einer Änderung kommt eine neue Einladung per E-Mail."),
  "notFound.title": same("Link ungültig"),
  "notFound.text": {
    ihr: "Diesen Buchungslink kennen wir leider nicht. Bitte prüft den Link aus eurer Einladung.",
    sie: "Diesen Buchungslink kennen wir leider nicht. Bitte prüfen Sie den Link aus Ihrer Einladung.",
  },
  // ---------------- E-Mails ----------------
  "mail.greeting": same("Hallo {name},"),
  "mail.invitation.subject": {
    ihr: "Euer Termin bei {tenant} – bitte wählt euer Datum",
    sie: "Ihr Termin bei {tenant} – bitte wählen Sie Ihr Datum",
  },
  "mail.invitation.text": {
    ihr: "wie besprochen laden wir euch zu „{event}“ ein. Über den folgenden Link seht ihr alle verfügbaren Termine mit den freien Plätzen und könnt direkt für euch und euer Team buchen.",
    sie: "wie besprochen laden wir Sie zu „{event}“ ein. Über den folgenden Link sehen Sie alle verfügbaren Termine mit den freien Plätzen und können direkt für sich und Ihr Team buchen.",
  },
  "mail.invitation.button": same("Termin auswählen"),
  "mail.invitation.validity": same("Der Link ist persönlich und {days} Tage gültig."),
  "mail.regards": same("Beste Grüße"),
  "mail.confirmation.subject": same("Buchungsbestätigung: {event} am {date}"),
  "mail.confirmation.changedSubject": same("Geänderte Buchung: {event} am {date}"),
  "mail.confirmation.title": { ihr: "Eure Buchung ist bestätigt", sie: "Ihre Buchung ist bestätigt" },
  "mail.confirmation.changedTitle": { ihr: "Eure Buchung wurde geändert", sie: "Ihre Buchung wurde geändert" },
  "mail.persons": same("{n} Personen"),
  "mail.person": same("1 Person"),
  "mail.ics.hint": same("Anhang · Outlook, Google, Apple Kalender"),
  "mail.contact": {
    ihr: "Ihr könnt nicht kommen oder müsst etwas ändern? Bitte meldet euch bei {name} – am einfachsten per Antwort auf diese E-Mail.",
    sie: "Sie können nicht kommen oder müssen etwas ändern? Bitte wenden Sie sich an {name} – am einfachsten per Antwort auf diese E-Mail.",
  },
  "mail.contactFallback": {
    ihr: "Ihr könnt nicht kommen oder müsst etwas ändern? Bitte meldet euch per Antwort auf diese E-Mail.",
    sie: "Sie können nicht kommen oder müssen etwas ändern? Bitte antworten Sie einfach auf diese E-Mail.",
  },
  "mail.changeLink": { ihr: "euren Buchungslink", sie: "Ihren Buchungslink" },
  "mail.cancellation.subject": same("Stornierung: {event} am {date}"),
  "mail.cancellation.title": { ihr: "Eure Buchung wurde storniert", sie: "Ihre Buchung wurde storniert" },
  "mail.cancellation.text": {
    ihr: "Über {link} könnt ihr jederzeit einen neuen Termin wählen.",
    sie: "Über {link} können Sie jederzeit einen neuen Termin wählen.",
  },
  "mail.rescheduled": {
    ihr: "der Termin wurde von uns geändert. Bitte beachtet die neuen Angaben unten – die Kalenderdatei im Anhang aktualisiert euren Eintrag.",
    sie: "der Termin wurde von uns geändert. Bitte beachten Sie die neuen Angaben unten – die Kalenderdatei im Anhang aktualisiert Ihren Eintrag.",
  },
  "mail.cancellation.byOrganizer": {
    ihr: "leider müssen wir diesen Termin absagen. Bitte entschuldigt die Umstände.",
    sie: "leider müssen wir diesen Termin absagen. Bitte entschuldigen Sie die Umstände.",
  },
  "mail.guestCancelled": {
    ihr: "{name} hat die Teilnahme abgesagt. Eure Buchung umfasst jetzt {persons}.",
    sie: "{name} hat die Teilnahme abgesagt. Ihre Buchung umfasst jetzt {persons}.",
  },
  "mail.guest.subject": same("Einladung: {event} am {date}"),
  "mail.guest.changedSubject": same("Geänderter Termin: {event} am {date}"),
  "mail.guest.title": same("Anmeldung bestätigt"),
  "mail.guest.changedTitle": same("Der Termin wurde geändert"),
  "mail.guest.text": {
    ihr: "{booker} hat euch für diesen Termin angemeldet.",
    sie: "{booker} hat Sie für diesen Termin angemeldet.",
  },
  "mail.guest.cancelled.subject": same("Abgesagt: {event} am {date}"),
  "mail.guest.cancelled.title": same("Teilnahme abgesagt"),
  "mail.guest.cancelled.text": {
    ihr: "eure Teilnahme an diesem Termin ist abgesagt.",
    sie: "Ihre Teilnahme an diesem Termin ist abgesagt.",
  },
  "mail.test.subject": same("Testnachricht: Postfach verbunden"),
  "mail.test.text": same("Dieses Postfach ist jetzt mit der Terminbuchung verbunden. Einladungen und Buchungsbestätigungen werden ab sofort von hier versendet."),
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

/** Ersetzt {platzhalter} – auch clientseitig nutzbar */
export function formatText(template: string, vars?: Record<string, string | number>): string {
  return vars ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : template;
}

export type ResolvedTexts = Record<TextKey, string>;

/** Alle Texte eines Mandanten aufgelöst (für Client-Komponenten) */
export function resolveTexts(anrede: Anrede, overrides: TextOverrides = {}): ResolvedTexts {
  return Object.fromEntries(TEXT_KEYS.map((k) => [k, overrides[k] ?? TEXTS[k][anrede]])) as ResolvedTexts;
}
