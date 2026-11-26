# CLAUDE.md – Terminbuchungstool

Mandantenfähiges Terminbuchungstool mit Pipedrive-Integration. Auftrag und Phasen:
`docs/claude-code-prompt.md`. Maßgebliches Design: `docs/mockup/` (Lesehilfe: `docs/mockup/README.md`).

## Architekturprinzipien (nicht verhandelbar)

1. **Eine Installation für alle Kunden.** Ein neuer Kunde ist ein Datensatz in `tenants`,
   niemals eine Code-Kopie, ein Branch oder ein `if (slug === "…")`.
2. **Kein kundenspezifischer Code.** Individualisierung ausschließlich über Einstellungen:
   `tenants.theme` (Theme-JSON), `anrede`, `text_overrides`, `legal_links`, `claim`,
   `contact_line`, Logo im Storage. Kundennamen/-farben stehen nur in `seed/` und in der DB.
3. **Isolation über `tenant_id` + RLS.** Jede fachliche Tabelle hat `tenant_id` (mit FK auf
   `tenants`). Zugriff wird in Postgres per Row Level Security erzwungen – App-Code darf sich
   NIE allein auf `where tenant_id = …` verlassen. Neue Tabelle ⇒ RLS + Policies + Test in
   `tests/db/rls.test.ts` im selben Commit.
4. **Öffentliche Zugriffe nur token-gebunden.** `anon` hat keinen Tabellenzugriff; die
   Buchungsseite nutzt ausschließlich `SECURITY DEFINER`-Funktionen, die Mandant + Token
   verlangen (`resolve_tenant`, `get_invitation_context`, `book_slot_once`, `get_booking_contact`;
   für weitere Teilnehmer `get_guest_context`).
5. **Buchen nur über `public.book_slot()`** (öffentlich über `book_slot_once`) (Slot-Sperre `FOR UPDATE`, Prüfung, Schreiben in
   einer Transaktion). Kein direktes `insert into bookings` – auch nicht im Admin.
6. **Mails nur über `email_outbox`**, nie direkt im Request. Eine Buchung scheitert nie an
   einer Mail. Versand über das Postfach des Mandanten; kein stiller Absenderwechsel.
7. **Secrets** (OAuth-Tokens, SMTP-Passwörter) nur verschlüsselt (`lib/crypto/secretbox.ts`)
   und für `authenticated` nicht lesbar (Spaltenrechte). Buchungslinks nur als SHA-256-Hash.

## Mandanten-Slug = Pipedrive-Unternehmensdomain

- Slug = Pipedrive-Unternehmensdomain, z. B. `antennevorarlberg.pipedrive.com` →
  `antennevorarlberg`. Ableitung nur über `lib/pipedrive/domain.ts`. Der Slug ist eine
  interne Kennung (Dateinamen, Seed) – er steht in KEINER öffentlichen Adresse.
- Wird einmal bei der Pipedrive-Installation gesetzt und danach nicht automatisch geändert
  (verschickte Links bleiben gültig). Stabiler Schlüssel des Mandanten bleibt `company_id`;
  die aktuelle Domain steht in `pipedrive_connections.company_domain` und wird bei Login,
  Installation und jeder Token-Erneuerung aus der `api_domain` nachgezogen
  (`lib/pipedrive/domain-sync.ts`) – eine Adressänderung in Pipedrive bricht nichts.
- Adressen (entschieden): alles zentral unter `APP_BASE_URL` (`https://meetings.atools.de`, Root, kein basePath),
  keine Kunden-Subdomains. Buchungsseite `/b/<token>`: Mandant aus dem Token (Middleware →
  `resolve_tenant_by_token`; API-Routen aus dem Token im Body). Admin `/admin`: Mandant aus
  der Sitzung (`resolve_tenant_by_id`, nur Mitglieder). Pipedrive-Login: Mandant über die
  `company_id` der Pipedrive-Firma. Einstieg aus den Pipedrive-App-Einstellungen:
  `/settings?userId&companyId&token` (JWT HS256, `lib/pipedrive/settings-token.ts`,
  Geheimnis `PIPEDRIVE_JWT_SECRET` bzw. Client-Secret, max. 15 Min. alt).
- Optional eigene Domain des Kunden (`tenants.custom_domain`, z. B. `termine.kunde.at` per
  CNAME) – nur für Buchungsseiten; Einrichtung später in den
  Pipedrive-App-Einstellungen (Phase 5, DNS-Prüfung, automatisches HTTPS). Kein iframe.

## Datenzugriff

- Server-Code nutzt `withActor(actor, fn)` aus `lib/db` (Paket `pg`). Jede Abfrage läuft in
  einer Transaktion mit `SET LOCAL ROLE anon|authenticated|service_role` und
  `request.jwt.claims` – exakt wie PostgREST bei Supabase. So gilt RLS lokal und auf Supabase
  identisch, und derselbe Code läuft unverändert gegen `SUPABASE_DB_URL`.
- `service_role` umgeht RLS: nur für Server-Jobs (Outbox, Pipedrive-Installation, Seed).
- Anmeldung nur über Pipedrive (OAuth, eine zentrale Callback-URL) oder per Einstieg aus den
  Pipedrive-App-Einstellungen (`/settings`, signiertes Token) – keine Passwörter, keine
  Einladungsmails, kein `supabase-js`. Sitzung = versiegeltes Cookie (`lib/auth/session.ts`,
  je Zweck eigener HKDF-Schlüssel) mit Benutzer + Mandant; Mitgliedschaft und Rolle werden pro
  Request frisch gelesen (`lib/auth/admin.ts`). Login prüft: Mandant zur Pipedrive-Firma
  (`company_id`), freigeschaltet (`tenant_members.status = active`), E-Mail = auth-Benutzer.
- Nutzerverwaltung (`/admin/benutzer`, später auch in den Pipedrive-App-Einstellungen): listet
  die Pipedrive-Benutzer der Firma; neue Benutzer haben keinen Zugriff, bis owner/admin sie
  freischalten. owner verwaltet alle, admin alle außer owner, sales nichts (RLS). Immer
  mindestens ein aktiver owner (Trigger, `TB:last_owner`). Pipedrive-Admins werden
  automatisch Admin (`lib/pipedrive/admin-sync.ts`: bei Installation, Login, Panel,
  App-Einstellungen, `/settings` und beim Laden der Nutzerverwaltung; neu anlegen bzw. sales
  anheben, gesperrt bleibt gesperrt, owner bleibt owner, kein automatisches Herabstufen;
  von Hand gesetzte Rolle bleibt: `tenant_members.role_manual`, per Trigger gesetzt, wenn ein
  angemeldeter Benutzer die Rolle setzt).
  Ohne Zugriff nennt die Meldung die aktiven Owner (`ownerContacts`; Login-Seite über
  versiegelten Parameter `hint`, Zweck `login-hint`). auth-Benutzer entstehen beim Freischalten (`lib/auth/users.ts`,
  `AUTH_ADMIN=local|supabase`), ohne Mail.
- Pipedrive-App: Installation/Deinstallation über die Callback-Route (`lib/pipedrive/install.ts`;
  Installierende:r = owner, Deinstallation ⇒ `pipedrive_connections.status = revoked`, Daten
  bleiben; ein vorbereiteter Mandant mit gleichem Slug, der nie verbunden war, wird übernommen). Panel im Deal `/panel` (JWT wie `/settings`, Panel-Sitzung als Bearer, Zweck
  `panel`; `lib/panel`, `components/panel`), Einladungen nur über `public.create_invitation`.
  Einträge in Pipedrive (Aktivität, Notizen) nur über die Warteschlange `pipedrive_jobs`
  (`lib/pipedrive/jobs.ts`, `crm.ts`), nie im Request. Aktivitätstyp `tenants.pd_activity_type`,
  Kunde + weitere Teilnehmer als Gäste (`attendees`). Panel zeigt Einladung/Buchung nur zum
  aktuellen Kontakt des Deals. Panel im Kontakt (`resource=person`, Sitzung ohne Deal) nur mit
  `tenants.panel_person_enabled`; Einträge dann am Kontakt. Einstellungen unter
  Admin → Pipedrive-Verbindung (`lib/admin/pipedrive-settings.ts`). Übersicht/Dashboard
  `/admin/uebersicht` (`lib/admin/dashboard.ts`).
- Zugriffsanfragen (`access_requests`, `lib/access-requests.ts`): Pipedrive-Benutzer ohne
  Freischaltung (Installation/Login, Panel, App-Einstellungen) ⇒ `record_access_request` +
  Mail an alle aktiven Owner/Admins (Outbox `access_request`, System-Adresse); Freischalten
  schließt die Anfrage (`close_access_request`, Mail `access_granted`). Eingebettete
  App-Einstellungen `/app-settings` (Custom UI in Pipedrive, iframe, Bearer Zweck `app-settings`,
  `lib/app-settings.ts`, API `/api/app-settings`): Nutzerverwaltung für owner/admin; `/settings`
  bleibt der Einstieg ins Admin (neuer Tab).
- Admin-Backend `/admin` (Server Components + Server Actions, zod, `lib/admin`), Texte in
  `lib/texts/admin.ts`. Buchungen `/admin/buchungen` („Gebucht von“ = `bookings.booked_by`, per
  Trigger aus `auth.uid()`: Mitarbeiter bei Direktbuchung, null = Kunde selbst). E-Mail-Vorlagen
  `/admin/vorlagen` (Mailtexte als `text_overrides`, nur Platzhalter des Standardtexts,
  `lib/admin/mail-templates.ts`). Pipedrive-Verbindung `/admin/pipedrive` (`lib/pipedrive/manage.ts`:
  Status/Test; owner: trennen = Tokens widerrufen + `revoked`, neu verbinden per OAuth-State
  `relink` an Mandant + Owner gebunden, andere Firma ⇒ umhängen, übrige Mitglieder neu freischalten). Pflege (`lib/admin/maintenance.ts`, DB-Funktionen
  `admin_cancel_booking`/`admin_update_slot`/`admin_cancel_slot`/`admin_delete_event`): Mails an
  Gebuchte nur mit Haken „Teilnehmer informieren“ (Event löschen: Standard aus); Event ohne
  Buchungen wird gelöscht, sonst storniert + archiviert. Firmendaten & Rechtliches
  `/admin/einstellungen` (`lib/admin/settings.ts`: Name, Absender, Reply-To, Anrede, Frist,
  Kontaktzeile, Rechtslinks, Löschfrist). Löschfrist `tenants.retention_months` (Standard 12):
  `public.purge_expired_data()` aus dem Server-Cron (`lib/retention.ts`, je Mandant max. 1×/Tag)
  anonymisiert Buchungen/Links nach Termin + Frist (`anonymized_at`), löscht Teilnehmer, alte
  Mails, Pipedrive-Aufträge und Verlaufseinträge; Termine/Platzzahlen bleiben. Verlauf `/admin/verlauf` (owner/admin, `lib/admin/activity.ts`):
  Schritte je Vorgang aus Buchungen, `email_outbox`, `pipedrive_jobs` plus `bookings.cancelled_by`
  und `activity_log` (Terminänderungen, per Trigger); Lesen nur über `activity_runs`/`activity_items`,
  „Erneut versuchen“ über `activity_retry`, Fehler-Hinweis oben im Admin (`activity_problem_count`).
  Pipedrive-Benutzerliste über `lib/pipedrive/directory.ts`
  (`PIPEDRIVE_DIRECTORY=api|fake`; `fake` = Seed-Daten, nur lokal).
- Hosting: Hetzner, kein Docker/Vercel. Deployment per GitHub Actions (`.github/workflows/deploy.yml`,
  Push auf `main`): Tests → Build `output: "standalone"` → SSH als `deploy-meetings` nach
  `/srv/meetings/releases/<Zeitstempel>` → `deploy/activate.sh` (Symlink `/srv/meetings/current`,
  `sudo systemctl restart meetings`, Health-Check, Rücksprung). Dienst als `meetings` unter systemd:
  `/usr/bin/node /srv/meetings/current/server.js`, `HOSTNAME=127.0.0.1`, `PORT=3003`,
  `EnvironmentFile=/etc/meetings/env`, `ProtectSystem=strict` (nur `/var/cache/meetings`
  beschreibbar), Caddy davor unter `https://meetings.atools.de`, Cron per systemd-Timer.
  `/panel` muss im Pipedrive-iframe laufen: Einbettungs-Header setzt die App
  (`next.config.ts`), nie im Proxy überschreiben. Zur Laufzeit nichts ins Release schreiben.
- Kein basePath: die App läuft im Root (`APP_BASE_URL` ohne Pfad, sonst bricht der Build ab).
  Absolute Links nur über `lib/links.ts` (`appBaseUrl`, `bookingUrl`) bzw. `lib/auth/urls.ts`.
  Nie `req.nextUrl.origin` verwenden (hinter Caddy = http://127.0.0.1:3003): Redirects über
  `appUrl()`, Herkunft der Anfrage über `requestOrigin()`/`isAppOrigin()` (X-Forwarded-*).
- Produktionsmodus: `lib/env-mode.ts` (`APP_ENV`, sonst `NODE_ENV`) – dort sind Dev-Login,
  `/dev/*`, `?tenant=` und Dev-Mailversand immer aus.

## Datenbank & Migrationen

- Migrationen: `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, müssen **unverändert auf
  Supabase** laufen. Nichts verwenden, was es dort nicht gibt. Bestehende Migrationen nach
  dem Push auf Supabase nicht mehr ändern – neue Migration anlegen.
- Lokal: vorinstalliertes Postgres 16 + Shims in `supabase/dev-shims/` (auth-Schema,
  Rollen, Supabase-Standardrechte). Shims NIE in `supabase/migrations/` und NIE auf Supabase.
- Supabase-Projekt `pkegcsgnyicdxzivnijw`: aus der Cloud nur per HTTPS erreichbar.
  Migrationen mit `npm run supabase:migrate` (Management API, trägt in
  `supabase_migrations.schema_migrations` ein → kompatibel zu `supabase db push`),
  Seed mit `npm run supabase:seed`. `SUPABASE_DB_URL` gibt es nur auf dem Produktionsserver.
- Ziel lokal vs. Supabase immer explizit wählen (`--target=…`, `ASSET_STORAGE=…`),
  nie aus dem Vorhandensein von `SUPABASE_URL` ableiten. DB-Tests laufen immer gegen
  das lokale `TEST_DATABASE_URL`. Auf Supabase keine `auth.users` per SQL anlegen.
- `npm run supabase:wipe` (leert das Projekt) nur auf ausdrückliche Anweisung.
- Funktionen: `security definer` immer mit `set search_path = ''` und voll qualifizierten
  Namen; Rechte explizit (`revoke … from public` + gezieltes `grant execute`).
- Fehler aus DB-Funktionen: `raise exception using errcode = 'P0001', message = 'TB:<code>'`.
- Sperrreihenfolge: erst `invitations`, dann `slots` (Deadlocks vermeiden).
- Zeiten immer `timestamptz`; Anzeige in `tenants.timezone` (Standard Europe/Vienna).

## Buchungsseite & Mails

- **Kein Umbuchen/Stornieren durch Kunden (entschieden, hohe Hemmschwelle zum Nicht-Kommen):**
  Über den Link wird genau einmal gebucht (`public.book_slot_once` → `book_slot`; `book_slot`,
  `cancel_booking`, `cancel_guest` sind für anon/authenticated entzogen). Danach zeigt die Seite
  nur Bestätigung + Ansprechpartner (`get_booking_contact` = einladender Mitarbeiter); Mails
  haben statt Änderungslink den Hinweis `mail.contact`. Änderungen/Storno nur durch das Team
  (Admin). Nach Storno durch das Team kann über den Link neu gewählt werden.
- Öffentlicher Event-Link (Admin → Event, `events.public_token_hash`/`public_link_enc`, auch `/b/<token>`):
  `get_public_event_context`, Buchen über `public.book_public` (legt Einladung `source = 'public'`
  mit eigenem persönlichen Link an → `book_slot`; je E-Mail und Event einmal). Danach Auftrag
  `link_contact` (`lib/pipedrive/jobs.ts`): Kontakt per E-Mail suchen (Dublettencheck), offenen
  Deal nehmen, sonst Kontakt/Firma/Deal anlegen (`tenants.new_deal_pipeline_id/stage_id`), dann
  Aktivität. Mails dazu immer über die System-Adresse (kein einladender Mitarbeiter).
- Buchungsseite: erst Tag, dann Termine des Tages (wie im Panel). `events.show_seats` = Platzzahlen
  für Kunden (aus ⇒ nur Datum/Uhrzeit der buchbaren Termine; keine Zahlen, keine Belegung, kein
  „ausgebucht“, ausgebuchte Termine erscheinen nicht; Zahlen werden nicht ausgeliefert).
- Buchungsseite `/b/[token]`: Server lädt Kontext über `get_invitation_context` (als `anon`),
  Client-Komponente `components/booking/BookingApp.tsx`; Texte als aufgelöstes Wörterbuch
  (`resolveTexts`), Datums-Formatierung serverseitig in der Mandanten-Zeitzone.
- Weitere Teilnehmer: Namen in `bookings.extra_attendees`; wer eine E-Mail angibt (Haken
  „eigene Einladung“, Buchungsseite + Panel), steht in `booking_guests` mit eigenem Link
  (`/b/<token>`, nur Hash; Ansicht + Kalender, kein Absagen). Storno durch das Team ⇒ alle
  bekommen eine Absage.
- API-Routen validieren mit zod, rufen `lib/booking/service.ts` und stoßen danach per
  `after()` die Outbox an. Fehlercodes `TB:*` → `lib/booking/errors.ts`.
- Mails: `lib/mail` – `MailSender`-Interface (`dev`, `smtp`, `google` = Gmail API,
  `microsoft` = Graph; OAuth nur mit Sende-Recht, `lib/mail/oauth.ts`),
  Vorlagen in `templates.ts` (Inline-Styles, kein SVG/Verlauf), Verarbeitung in `outbox.ts`
  (SKIP LOCKED, Backoff, Postfach-Fehler ⇒ Mail bleibt queued). Links in Mails nur über
  `lib/links.ts`; der Buchungslink steht verschlüsselt im Outbox-Payload (`link_enc`).
- **Kein Mailversand über die Pipedrive-App (entschieden, nicht erneut vorschlagen):** Pipedrive
  bietet Apps nur die Scopes `mail:read`/`mail:full` (lesen/ändern), KEINEN Scope zum Senden
  (`mail-sending:full` ist im Developer Hub nicht wählbar; der Live-Versand am 19.11.2026 lief nur
  über den Claude-MCP-Connector). Mails gehen daher nie „über das Pipedrive-Postfach“.
- Versandweg je Mandant (`tenants.mail_route`, Admin → E-Mail, `lib/mail/routing.ts`):
  `system` (Standard; System-SMTP `SYSTEM_MAIL_*`, Einladung mit Anzeigename + Reply-To =
  Mitarbeiter, Bestätigung/Stornierung Reply-To = Einladender) | `employee` (Einladung,
  Bestätigung und Stornierung über das eigene Postfach des einladenden Mitarbeiters unter
  „Mein Postfach“: Google/Microsoft/SMTP). Interne Mails (Zugriffsanfragen) immer System.
  Fällt der Weg aus: `email_outbox.error_code` + Meldung (Verlauf, Panel-Hinweis), NIE ein
  stiller Wechsel des Weges. Smart BCC (`tenants.smart_bcc_email`, nur
  `@pipedrivemail.com`) bringt Kundenmails in den Deal. Signatur je Mitarbeiter
  (`tenant_members.mail_signature`, Klartext) unter Einladungen.
- Pipedrive-Scopes der App (Developer Hub): base, deals:full, activities:full, **contacts:full**
  (öffentlicher Event-Link legt Kontakte/Firmen an), mail:full, **users:read** (Nutzerverwaltung;
  fehlt er ⇒ Hinweis `users.dir.missing_scope`).
  Neue Scopes gelten erst nach erneuter Autorisierung.
- Postfach verbinden (`/admin/postfach`, genutzt beim Weg `employee`): Speichern über
  `public.save_mail_connection` (Status `pending`), aktiv erst nach zugestellter Testmail.
  OAuth wie der Login: Start auf Mandanten-Host (Nonce), zentraler Callback →
  `mail_oauth_pending` (nur service_role) → Abschluss mit Sitzung + Nonce.

## Theme & Texte

- Theme-Schema: `lib/theme/schema.ts` (zod). Lesen mit `parseTheme()` (robust, Fallback auf
  Defaults), Speichern mit `themeInputSchema` (streng). Werte sind auf sichere Muster
  beschränkt (Hex, `linear-gradient` aus Hex, px/rem) – Schutz gegen CSS-Injection.
- Zur Laufzeit als CSS-Variablen `--tb-*` (`lib/theme/css.ts`). Komponenten-CSS nutzt nur
  diese Variablen, keine festen Mandantenfarben.
- Schriften nur aus der Allowlist (`lib/theme/font-names.ts`), selbst gehostet als Dateien im
  Repository (`public/fonts/`, `app/fonts.css`, erzeugt von `scripts/fonts-download.mjs`) –
  keine Anfragen an Google, weder beim Build noch zur Laufzeit. Nicht `next/font/google`.
- Admin → Erscheinungsbild (`/admin/erscheinungsbild`, owner/admin): Logo (PNG/JPG/WebP/SVG ≤ 1 MB,
  Typ am Inhalt geprüft, SVG ohne aktive Inhalte, `lib/admin/branding.ts` → Asset-Storage +
  `tenants.logo_path`), Claim, Schriften und Grundfarben (`lib/admin/branding-logic.ts`:
  Merge ins Theme, `themeInputSchema`, Live-Vorschau). Farbwahl liegt beim Kunden: KEIN
  Kontrast-Check, keine Warnung, kein Blockieren (entschieden).
- Texte: `lib/texts` mit Varianten `sie`/`ihr`; Mandanten können einzelne Schlüssel über
  `text_overrides` ersetzen. Neue UI-Texte immer dort anlegen, nie hart im JSX.
- Barrierefreiheit: echte Buttons/Labels, Kontrast ≥ 4.5:1 für unsere Standard- und
  Seed-Themes (`lib/theme/contrast.ts`, in Tests geprüft; Kundenfarben werden nicht geprüft), responsiv bis 320 px.

## Konventionen

- TypeScript strict, zod für alle Eingaben an Systemgrenzen, Oberfläche auf Deutsch.
- Tests: Vitest. `npm test` (alles), `npm run test:unit`, `npm run test:db`.
  DB-Tests setzen `TEST_DATABASE_URL` komplett zurück.
- Vor neuen Abhängigkeiten oder Abweichungen vom Stack kurz beim Auftraggeber nachfragen.
- Keine Secrets committen; neue Umgebungsvariablen in `.env.example` dokumentieren.
- Commits/PRs auf Deutsch oder Englisch, kleine nachvollziehbare Schritte.

## Häufige Befehle

```bash
# Der SessionStart-Hook (.claude/hooks/session-start.sh) erledigt in Cloud-Sessions
# automatisch: npm install, .env.local, Postgres-Start, Migration+Seed bei leerer DB.
npm run db:start   # Postgres 16 starten, DBs anlegen (lokal)
npm run db:reset   # Shims + Migrationen + Seed (lokal), gibt Test-Buchungslinks aus
npm run supabase:inspect            # Supabase-Bestand (nur lesend)
npm run supabase:migrate [-- --dry-run]
npm run supabase:seed
npm test           # Unit- + DB-Tests
npm run dev        # http://localhost:3000/admin (Dev-Login), Buchungslinks gibt db:reset aus
```
