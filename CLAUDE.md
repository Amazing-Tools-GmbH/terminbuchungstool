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
   verlangen (`resolve_tenant`, `get_invitation_context`, `book_slot`, `cancel_booking`).
5. **Buchen nur über `public.book_slot()`** (Slot-Sperre `FOR UPDATE`, Prüfung, Schreiben in
   einer Transaktion). Kein direktes `insert into bookings` – auch nicht im Admin.
6. **Mails nur über `email_outbox`**, nie direkt im Request. Eine Buchung scheitert nie an
   einer Mail. Versand über das Postfach des Mandanten; kein stiller Absenderwechsel.
7. **Secrets** (OAuth-Tokens, SMTP-Passwörter) nur verschlüsselt (`lib/crypto/secretbox.ts`)
   und für `authenticated` nicht lesbar (Spaltenrechte). Buchungslinks nur als SHA-256-Hash.

## Mandanten-Slug = Pipedrive-Unternehmensdomain

- Slug (Subdomain `<slug>.<APP_DOMAIN>`) = Pipedrive-Unternehmensdomain, z. B.
  `antennevorarlberg.pipedrive.com` → `antennevorarlberg`. Ableitung nur über
  `lib/pipedrive/domain.ts` (reservierte Subdomains bekommen `-pd`).
- Wird einmal bei der Pipedrive-Installation gesetzt und danach nicht automatisch geändert
  (verschickte Links bleiben gültig). Stabiler Schlüssel des Mandanten bleibt `company_id`;
  die aktuelle Domain steht in `pipedrive_connections.company_domain`.
- Öffentliche Domain (entschieden, Variante A): Kunde wählt frei eine Subdomain seiner
  eigenen Domain (z. B. `termine.kunde.at`) per CNAME auf die App → `tenants.custom_domain`
  + Domain in Vercel (ab Phase 5 automatisiert mit DNS-Prüfung). Kein iframe-Embedding.

## Datenzugriff

- Server-Code nutzt `withActor(actor, fn)` aus `lib/db` (Paket `pg`). Jede Abfrage läuft in
  einer Transaktion mit `SET LOCAL ROLE anon|authenticated|service_role` und
  `request.jwt.claims` – exakt wie PostgREST bei Supabase. So gilt RLS lokal und auf Supabase
  identisch, und derselbe Code läuft unverändert gegen `SUPABASE_DB_URL`.
- `service_role` umgeht RLS: nur für Server-Jobs (Outbox, Pipedrive-Installation, Seed).
- `supabase-js` nur für Auth (ab Phase 3).

## Datenbank & Migrationen

- Migrationen: `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, müssen **unverändert auf
  Supabase** laufen. Nichts verwenden, was es dort nicht gibt. Bestehende Migrationen nach
  dem Push auf Supabase nicht mehr ändern – neue Migration anlegen.
- Lokal: vorinstalliertes Postgres 16 + Shims in `supabase/dev-shims/` (auth-Schema,
  Rollen, Supabase-Standardrechte). Shims NIE in `supabase/migrations/` und NIE auf Supabase.
- Supabase-Projekt `rktitpxdwajstxlurkgq`: aus der Cloud nur per HTTPS erreichbar.
  Migrationen mit `npm run supabase:migrate` (Management API, trägt in
  `supabase_migrations.schema_migrations` ein → kompatibel zu `supabase db push`),
  Seed mit `npm run supabase:seed`. `SUPABASE_DB_URL` gibt es nur in Vercel.
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

- Buchungsseite `/b/[token]`: Server lädt Kontext über `get_invitation_context` (als `anon`),
  Client-Komponente `components/booking/BookingApp.tsx`; Texte als aufgelöstes Wörterbuch
  (`resolveTexts`), Datums-Formatierung serverseitig in der Mandanten-Zeitzone.
- API-Routen validieren mit zod, rufen `lib/booking/service.ts` und stoßen danach per
  `after()` die Outbox an. Fehlercodes `TB:*` → `lib/booking/errors.ts`.
- Mails: `lib/mail` – `MailSender`-Interface (`dev`, `smtp`; Google/Microsoft folgen),
  Vorlagen in `templates.ts` (Inline-Styles, kein SVG/Verlauf), Verarbeitung in `outbox.ts`
  (SKIP LOCKED, Backoff, Postfach-Fehler ⇒ Mail bleibt queued). Links in Mails nur über
  `lib/links.ts`; der Buchungslink steht verschlüsselt im Outbox-Payload (`link_enc`).

## Theme & Texte

- Theme-Schema: `lib/theme/schema.ts` (zod). Lesen mit `parseTheme()` (robust, Fallback auf
  Defaults), Speichern mit `themeInputSchema` (streng). Werte sind auf sichere Muster
  beschränkt (Hex, `linear-gradient` aus Hex, px/rem) – Schutz gegen CSS-Injection.
- Zur Laufzeit als CSS-Variablen `--tb-*` (`lib/theme/css.ts`). Komponenten-CSS nutzt nur
  diese Variablen, keine festen Mandantenfarben.
- Schriften nur aus der Allowlist (`lib/theme/font-names.ts` + `fonts.ts`, selbst gehostet
  über next/font – keine Laufzeit-Anfragen an Google).
- Texte: `lib/texts` mit Varianten `sie`/`ihr`; Mandanten können einzelne Schlüssel über
  `text_overrides` ersetzen. Neue UI-Texte immer dort anlegen, nie hart im JSX.
- Barrierefreiheit: echte Buttons/Labels, Kontrast ≥ 4.5:1 (`lib/theme/contrast.ts`,
  Seed-Themes werden in Tests geprüft), responsiv bis 320 px.

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
npm run dev        # http://localhost:3000/?tenant=antennevorarlberg
```
