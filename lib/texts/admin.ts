/**
 * Texte des Admin-Backends (interne Oberfläche für Mitarbeitende der
 * Mandanten). Neutral, ohne Anrede-Varianten und nicht je Mandant
 * überschreibbar. Platzhalter wie in lib/texts: {name}.
 */
import { formatText } from "./index";
import type { AdminErrorCode } from "@/lib/admin/errors";

export const ADMIN_TEXTS = {
  "app.title": "Terminbuchung · Admin",
  "nav.label": "Bereiche",
  "nav.slots": "Termine & Kapazitäten",
  "nav.bookings": "Buchungen",
  "nav.events": "Veranstaltungsarten",
  "nav.templates": "E-Mail-Vorlagen",
  "nav.pipedrive": "Pipedrive-Verbindung",
  "nav.users": "Nutzerverwaltung",
  "nav.soon": "folgt",
  "user.logout": "Abmelden",
  "role.owner": "Owner",
  "role.admin": "Admin",
  "role.sales": "Vertrieb",

  "login.title": "Anmelden",
  "login.intro": "Melde dich mit deinem Pipedrive-Konto an. Zugriff hat, wer in der Nutzerverwaltung freigeschaltet ist.",
  "login.pipedrive": "Mit Pipedrive anmelden",
  "login.dev.title": "Entwicklung: Anmelden als …",
  "login.dev.hint": "Nur sichtbar mit DEV_TOOLS_ENABLED. Ersetzt den Pipedrive-Login, solange keine OAuth-App eingerichtet ist.",
  "login.dev.none": "Keine freigeschalteten Benutzer.",
  "login.error.not_configured": "Die Anmeldung über Pipedrive ist noch nicht eingerichtet (OAuth-App fehlt).",
  "login.error.cancelled": "Die Anmeldung wurde in Pipedrive abgebrochen.",
  "login.error.expired": "Die Anmeldung ist abgelaufen. Bitte erneut anmelden.",
  "login.error.oauth_failed": "Pipedrive hat die Anmeldung nicht bestätigt. Bitte erneut versuchen.",
  "login.error.not_connected": "Für diese Firma ist noch keine Pipedrive-Verbindung eingerichtet.",
  "login.error.wrong_company": "Dein Pipedrive-Konto gehört nicht zur Firma dieses Terminbuchungstools.",
  "login.error.no_access": "Du hast noch keinen Zugriff. Bitte wende dich an einen Owner oder Admin deiner Firma.",
  "login.error.disabled": "Dein Zugriff wurde gesperrt. Bitte wende dich an einen Owner oder Admin deiner Firma.",
  "login.error.email_mismatch": "Deine E-Mail-Adresse in Pipedrive hat sich geändert. Bitte lass dich neu freischalten.",

  "slots.title": "Termine & Kapazitäten",
  "slots.event": "Veranstaltung",
  "slots.eventSwitch": "Anzeigen",
  "slots.noEvents": "Noch keine Veranstaltung angelegt.",
  "slots.empty": "Keine kommenden Termine.",
  "kpi.slots": "Termine",
  "kpi.capacity": "Plätze gesamt",
  "kpi.booked": "Gebucht",
  "kpi.pct": "Auslastung",
  "table.date": "Datum",
  "table.time": "Uhrzeit",
  "table.location": "Ort",
  "table.occupancy": "Belegung",
  "table.status": "Status",
  "table.actions": "Aktionen",
  "table.bookings": "Buchungen",
  "table.capacityUp": "+1 Platz",
  "table.capacityUpLabel": "Kapazität am {date} um einen Platz erhöhen",
  "status.ok": "Buchbar",
  "status.low": "Fast voll",
  "status.full": "Ausgebucht",
  "status.closed": "Nicht freigegeben",
  "status.cancelled": "Abgesagt",
  "bookings.title": "Buchungen am {date}",
  "bookings.empty": "Noch keine Buchungen.",
  "bookings.seats": "{n} Pers.",
  "bookings.extra": "Weitere: {names}",
  "bookings.deal": "Pipedrive-Deal",
  "bookings.noDeal": "ohne Deal",
  "bookings.close": "Schließen",
  "bookings.pick": "Bei einem Termin auf „Buchungen“ klicken, um die Buchungen zu sehen.",

  "form.title": "Neuen Termin anlegen",
  "form.event": "Veranstaltung",
  "form.date": "Datum",
  "form.from": "Von",
  "form.to": "Bis",
  "form.location": "Ort",
  "form.locationHint": "Leer lassen = Ort der Veranstaltung",
  "form.capacity": "Kapazität (max. Teilnehmer)",
  "form.open": "Sofort für Buchungslinks freigeben",
  "form.submit": "Termin speichern",
  "form.saved": "Termin angelegt und in der Liste ergänzt.",
  "form.readOnly": "Termine anlegen und Kapazitäten ändern können Owner und Admins.",
  "capacity.saved": "Kapazität erhöht.",

  "users.title": "Nutzerverwaltung",
  "users.intro":
    "Hier stehen alle Benutzer eurer Pipedrive-Firma. Neue Benutzer haben keinen Zugriff, bis sie freigeschaltet werden. Angemeldet wird mit dem Pipedrive-Konto.",
  "users.name": "Name",
  "users.email": "E-Mail",
  "users.access": "Zugriff",
  "users.role": "Rolle",
  "users.actions": "Aktionen",
  "users.pdAdmin": "Pipedrive-Admin",
  "users.pdInactive": "in Pipedrive deaktiviert",
  "users.pdMissing": "nicht mehr in Pipedrive",
  "users.self": "du",
  "users.state.active": "Freigeschaltet",
  "users.state.disabled": "Gesperrt",
  "users.state.none": "Kein Zugriff",
  "users.enable": "Freischalten",
  "users.reenable": "Wieder freischalten",
  "users.disable": "Sperren",
  "users.saveRole": "Rolle speichern",
  "users.roleFor": "Rolle für {name}",
  "users.saved": "Gespeichert.",
  "users.readOnly": "Nur Owner und Admins können Benutzer freischalten oder Rollen ändern.",
  "users.roles":
    "Owner: alles inkl. Owner verwalten · Admin: Termine, Kapazitäten und Benutzer (außer Owner) · Vertrieb: Einladungen senden und Belegung sehen.",
  "users.dir.not_connected": "Pipedrive ist für diese Firma noch nicht verbunden – es werden nur bereits freigeschaltete Benutzer angezeigt.",
  "users.dir.unavailable": "Die Benutzer konnten gerade nicht aus Pipedrive geladen werden. Bitte später erneut versuchen.",
  "users.dir.fake": "Entwicklung: Beispiel-Benutzer aus dem Seed statt Pipedrive (PIPEDRIVE_DIRECTORY=fake).",

  "placeholder.title": "Folgt",
  "placeholder.text": "Dieser Bereich folgt in einer späteren Phase.",

  "error.forbidden": "Dafür fehlen dir die Rechte.",
  "error.not_found": "Nicht gefunden.",
  "error.invalid_input": "Bitte die Eingaben prüfen.",
  "error.last_owner": "Es muss immer mindestens einen aktiven Owner geben.",
  "error.capacity_below_booked": "Die Kapazität darf nicht unter die gebuchten Plätze sinken.",
  "error.slot_in_past": "Der Termin liegt in der Vergangenheit.",
  "error.self": "Deinen eigenen Zugriff und deine eigene Rolle kannst du nicht ändern.",
  "error.already_member": "Dieser Benutzer ist bereits freigeschaltet.",
  "error.pipedrive_unavailable": "Pipedrive ist gerade nicht erreichbar. Bitte später erneut versuchen.",
  "error.pipedrive_user_not_found": "Dieser Benutzer ist in Pipedrive nicht (mehr) aktiv.",
  "error.generic": "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
} as const;

export type AdminTextKey = keyof typeof ADMIN_TEXTS;

export function at(key: AdminTextKey, vars?: Record<string, string | number>): string {
  return formatText(ADMIN_TEXTS[key], vars);
}

export function adminErrorText(code: AdminErrorCode): string {
  return at(`error.${code}`);
}

const LOGIN_ERRORS = [
  "not_configured",
  "cancelled",
  "expired",
  "oauth_failed",
  "not_connected",
  "wrong_company",
  "no_access",
  "disabled",
  "email_mismatch",
] as const;

export function loginErrorText(code: string | undefined): string | null {
  return code && (LOGIN_ERRORS as readonly string[]).includes(code) ? at(`login.error.${code}` as AdminTextKey) : null;
}
