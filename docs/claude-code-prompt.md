# Projekt: Mandantenfähiges Terminbuchungstool mit Pipedrive-Integration

## Kontext
Wir bauen ein Terminbuchungstool, das wir mehreren Kunden (Mandanten) anbieten. Erster Kunde
ist der Radiosender ANTENNE VORARLBERG. Vertriebsmitarbeiter senden aus einem Pipedrive-Deal
heraus einen persönlichen Buchungslink; der eingeladene Kunde bucht auf einer gebrandeten
Buchungsseite einen Termin (mit Teilnehmerzahl), bekommt eine Bestätigung mit .ics-Datei, und
im Deal entsteht ein Verlaufseintrag.

Oberstes Ziel: EINE Installation für alle Kunden. Ein neuer Kunde ist ein neuer Mandant
(Datensatz), niemals eine Code-Kopie. Individualisierung ausschließlich über Einstellungen
(Theme, Texte, Links), nie über kundenspezifischen Code. Der Einrichtungsaufwand pro Kunde
soll minimal sein.

## Entwicklungsumgebung
Entwicklung läuft vollständig in der Cloud (Claude Code im Web). Es gibt KEINE lokale
Supabase-Instanz und kein Docker.

### Übergangslösung: noch kein Supabase-Projekt
Solange die Umgebungsvariablen SUPABASE_URL / SUPABASE_DB_URL fehlen, entwickeln wir gegen
das in der Cloud-Umgebung vorinstallierte PostgreSQL 16:
- Postgres in der Sitzung starten (bei Bedarf über ein Setup-Skript) und eine Datenbank
  `terminbuchung_dev` anlegen; Verbindungs-URL in `.env.local` (nicht committen).
- Eine Shim-Migration NUR für diese Umgebung (`supabase/dev-shims/`, nicht in
  `supabase/migrations/`) bildet nach: Schema `auth` mit `auth.users` und `auth.uid()`
  (liest `request.jwt.claims` aus `current_setting`), Rollen `anon`, `authenticated`,
  `service_role`.
- Alle regulären Migrationen müssen später unverändert auf Supabase laufen. Nichts
  verwenden, was es dort nicht gibt.
- RLS-Tests setzen die Rolle und `request.jwt.claims` pro Test, um Zugriffe als Mandant A,
  Mandant B und anonym zu prüfen (Mandant A darf Daten von B nie sehen).
- Supabase Storage ist noch nicht verfügbar: Logo-Upload im Seed hinter ein Interface legen
  und vorerst die Datei aus `seed/assets/` referenzieren.
- In Phase 1 Fokus auf Schema, RLS, Buchungsfunktion und Tests. Die UI aus Phase 2 nur so
  weit bauen, wie sie ohne Vercel-Vorschau sinnvoll prüfbar ist, und mir dann Bescheid geben.
- Sobald die Supabase-Variablen gesetzt sind: Shims weglassen, `supabase db push`, Seed
  einspielen, Tests gegen Supabase wiederholen.

## Stack (fest)
- Next.js (App Router, TypeScript strict), eine einzige App für Buchungsseite, Admin-Backend,
  Pipedrive-Panel und Onboarding
- Supabase (Postgres, Auth, Storage), Region EU (Frankfurt). Wir entwickeln gegen ein
  gehostetes Supabase-Dev-Projekt. Zugangsdaten liegen als Umgebungsvariablen vor
  (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL).
  Supabase CLI per `npx supabase`; Migrationen als Dateien im Repo, Anwendung per
  `supabase db push`.
- Vorschau über Vercel Preview Deployments (Region fra1)
- E-Mail-Versand über das eigene Postfach des Mandanten (siehe Abschnitt "E-Mail-Versand"),
  kein zentraler Versanddienst für Kundenmails
- Validierung mit zod, Tests mit Vitest
- Zeitzone Europe/Vienna, Oberfläche auf Deutsch

## Design-Referenz
Das abgenommene Mock-up liegt unter `docs/mockup/` (Lesehilfe: `docs/mockup/README.md`).
Es ist die maßgebliche Referenz für Aufbau, Texte und Zustände aller Oberflächen.
`docs/mockup/3-buchungsseite.dc.html` enthält zusätzlich die Theme-Werte beider Seed-Mandanten.

## Architektur
- Jede fachliche Tabelle hat `tenant_id`; Isolation über Row Level Security in Postgres.
  Kein Datenzugriff darf sich allein auf Filter im App-Code verlassen.
- Mandantenauflösung per Middleware über den Host: `<slug>.<APP_DOMAIN>` oder eine
  hinterlegte `custom_domain`. Für Vercel-Vorschauen zusätzlich ein Fallback über einen
  Pfad- oder Query-Parameter (z. B. `?tenant=<slug>`), der nur außerhalb von Produktion greift.
- Theme-System: Jeder Mandant hat ein Theme-JSON (zod-Schema mit Defaults), das zur Laufzeit
  als CSS-Variablen gesetzt wird. Schriften nur aus einer Allowlist (Google Fonts).
- Texte hängen an der Mandanten-Einstellung `anrede` ("sie" | "ihr"), einzelne Texte
  können pro Mandant überschrieben werden.
- Pipedrive (spätere Phase, aber jetzt im Datenmodell vorsehen): EINE private Pipedrive-App
  mit nicht öffentlichem Installationslink für alle Kunden. OAuth-Installation legt den
  Mandanten automatisch an (Schlüssel: Pipedrive company_id). Das Vertriebs-Panel wird als
  Custom UI Extension (Custom Panel, Deal-Detailansicht) eingebunden; das mitgeschickte JWT
  wird im Backend validiert. Tokens verschlüsselt speichern, Refresh berücksichtigen.

## Datenmodell (Vorschlag, gern verbessern und begründen)
- tenants: id, slug (unique), name, custom_domain, theme (jsonb), anrede, text_overrides (jsonb),
  legal_links (jsonb), contact_line, sender_name, reply_to_email, created_at
- tenant_members: tenant_id, user_id, role (owner | admin | sales)
- pipedrive_connections: tenant_id, company_id (unique), api_domain, access_token_enc,
  refresh_token_enc, expires_at
- events: id, tenant_id, title, description, location, status
- slots: id, tenant_id, event_id, starts_at, ends_at (timestamptz), capacity, status
- invitations: id, tenant_id, event_id, token_hash, name, email, pipedrive_deal_id,
  pipedrive_person_id, allowed_slot_ids (nullable = alle), status, expires_at, sent_at
- bookings: id, tenant_id, slot_id, invitation_id, name, email, seats, extra_attendees (text[]),
  status (confirmed | cancelled), created_at, cancelled_at

- mail_connections: id, tenant_id, scope (tenant | user), user_id (nullable), provider
  (google | microsoft | smtp), sender_email, sender_name, credentials_enc, status
  (active | error | revoked), last_error, last_verified_at
- email_outbox: id, tenant_id, type (invitation | confirmation | …), to_email, payload (jsonb),
  status (queued | sent | failed), attempts, next_attempt_at, sent_at, provider_message_id,
  last_error

Überbuchungsschutz: Buchen ausschließlich über eine Postgres-Funktion, die den Slot sperrt
(SELECT … FOR UPDATE), freie Plätze prüft und die Buchung in einer Transaktion schreibt.
Dazu ein Test, der parallele Buchungen auf den letzten Platz simuliert.

Buchungslinks: zufälliges Token, in der DB nur als Hash gespeichert, mit Ablaufdatum.

## E-Mail-Versand: über das Postfach des Kunden
Jeder Mandant verbindet sein eigenes E-Mail-Postfach. Einladungen und Buchungsbestätigungen
gehen von dort raus, liegen in dessen "Gesendet"-Ordner, und Antworten kommen direkt beim
Kunden an. Wir betreiben keinen eigenen Absender für Kundenmails.

- Interface `MailSender` mit drei Implementierungen:
  - Google Workspace/Gmail: OAuth, Gmail API, Scope `gmail.send`
  - Microsoft 365/Outlook: OAuth (Multi-Tenant-App), Microsoft Graph, `Mail.Send` + `offline_access`
  - SMTP: Host, Port, Benutzer, (App-)Passwort – Fallback für alle anderen Anbieter
  - zusätzlich eine `dev`-Implementierung, die Mails nur in der DB ablegt und unter
    `/dev/mails` anzeigt (kein Docker, kein Mailpit)
- Standard: ein Postfach pro Mandant (scope = tenant). Das Datenmodell erlaubt später ein
  eigenes Postfach je Vertriebsmitarbeiter für Einladungen (scope = user).
- Zugangsdaten und Tokens verschlüsselt speichern, Token-Refresh berücksichtigen.
- Beim Verbinden eine Testmail an das Postfach selbst senden; erst dann status = active.
- Versand nie direkt im Request, sondern über `email_outbox` mit Retry (Cron-Job).
  Eine Buchung darf nie daran scheitern, dass eine Mail nicht rausgeht.
- Ist die Verbindung gestört (Token entzogen, Passwort geändert): status = error, deutlicher
  Hinweis im Admin-Backend und im Pipedrive-Panel, Mails bleiben in der Outbox, bis die
  Verbindung erneuert ist. Kein stiller Wechsel auf einen anderen Absender.
- Mail-Vorlagen folgen Theme und Anrede des Mandanten (Inhalte: `docs/mockup/2-emails.dc.html`),
  Bestätigung mit .ics-Anhang.
- Zu prüfen (nur recherchieren und berichten, nicht ohne Rückfrage einbauen): Ob die
  Pipedrive-API inzwischen das Senden über das in Pipedrive verbundene Postfach erlaubt
  (Mail-Entwürfe erstellen/senden). Vorteil wäre, dass Einladungen automatisch im Deal-Verlauf
  erscheinen.

## Phasen (gesamt)
1. Fundament: Projektgerüst, Supabase-Schema mit Migrationen, RLS-Policies, Mandantenauflösung,
   Theme-System, Seed-Daten
2. Buchungsseite + Buchungs-API + Bestätigungs-E-Mail mit .ics, Google-/Outlook-Kalenderlinks;
   E-Mail-Outbox mit `MailSender`-Interface, `dev`- und SMTP-Implementierung
3. Admin-Backend (KPIs, Termine, Belegung, Kapazität erhöhen, Buchungen je Termin, Termin anlegen)
4. Pipedrive-App (OAuth, Custom Panel, Einladung senden, Deal-Verlaufseintrag, Fokus-Aktivität)
5. Onboarding-Assistent in den Pipedrive-App-Einstellungen: Branding, Rechtslinks,
   E-Mail-Postfach verbinden (Google / Microsoft / SMTP inkl. Testmail), erste Veranstaltung

## Aufgabe JETZT: Phase 1 und 2
Bitte zuerst einen kurzen Plan vorlegen (Ordnerstruktur, Migrationen, offene Fragen) und auf
meine Freigabe warten. Danach umsetzen und nach jeder Phase stoppen und zusammenfassen.

Buchungsseite (Phase 2), Verhalten wie im abgenommenen Mock-up:
- Header mit Mandanten-Logo und Claim, darunter Hero mit Veranstaltungstitel und Intro-Text
- Kachel-Raster aller Termine: Wochentag, Datum, Uhrzeit, Ort, Auslastungsbalken,
  "X von Y Plätzen frei"; ausgebuchte Termine sichtbar, aber deaktiviert
- Seitenbox "Eure/Ihre Buchung": gewählter Termin, Teilnehmerzahl (1 bis freie Plätze),
  Name und E-Mail aus der Einladung vorbefüllt, optionale weitere Teilnehmer, Button
  "Verbindlich buchen"
- Bestätigungsansicht mit Zusammenfassung, .ics-Download, Google-/Outlook-Links,
  "Buchung ändern"
- Ohne Logo zeigt der Header den Mandantennamen als Text
- Barrierefrei (echte Buttons/Labels, Kontrast mind. 4.5:1), responsiv bis Handybreite

## Seed: Mandant ANTENNE VORARLBERG
- slug: antenne-vorarlberg, anrede: "ihr"
- Logo: `seed/assets/logo-antenne-vorarlberg.svg` → in Supabase Storage hochladen.
  Das Logo hat einen eigenen gelben Hintergrund (#FFE500); der Header nutzt exakt dieselbe
  Farbe, damit es nahtlos übergeht.
- Theme:
  {
    "fontBody": "Overpass", "fontDisplay": "Overpass",
    "primary": "#111111", "onPrimary": "#FFE500",
    "headerBg": "#FFE500", "headerInk": "#111111",
    "heroBg": "linear-gradient(100deg, #FFE500 0%, #FFE500 30%, #FFC70F 52%, #FD8F22 74%, #F96A2D 100%)",
    "heroInk": "#111111",
    "accentStrip": "linear-gradient(90deg, #FFE500 0%, #FFC70F 40%, #FD8F22 70%, #F96A2D 100%)",
    "bg": "#F6F5F1", "surface": "#FFFFFF", "ink": "#111111", "muted": "#4F5158",
    "line": "#E4E2DC", "field": "#9C9EA4", "dayColor": "#A63D0A",
    "selectedBg": "#FFF7BF", "footerBg": "#111111", "footerInk": "#F1F1F1",
    "radius": "6px", "radiusSm": "4px"
  }
- Claim: "Mehr Musik! Mehr Vielfalt!"; Kontaktzeile: "Fragen? Ruft uns an: 0800 10 36 36"
- Rechtslinks: Impressum https://www.antennevorarlberg.at/info/impressum/,
  AGB https://www.antennevorarlberg.at/info/agb/,
  Datenschutz https://www.antennevorarlberg.at/info/datenschutz/
- Beispiel-Veranstaltung "Kunden-Workshop Radiowerbung", Ort "Studio ANTENNE VORARLBERG",
  5 Termine mit unterschiedlicher Auslastung (einer ausgebucht, einer fast voll)
- Zusätzlich ein zweiter Mandant "demo" mit neutralem Theme und anrede "sie", um zu
  beweisen, dass alles über Einstellungen läuft

## Konventionen
- Lege eine CLAUDE.md mit Architekturprinzipien und Konventionen an (vor allem: kein
  kundenspezifischer Code, alles über tenant_id + RLS)
- .env.example pflegen, keine Secrets committen
- README mit Setup für Cloud-Entwicklung (Supabase-Dev-Projekt, Vercel, Umgebungsvariablen)
- Vor neuen Abhängigkeiten oder Abweichungen vom Stack kurz nachfragen
