# Terminbuchungstool

Mandantenfähiges Terminbuchungstool mit Pipedrive-Integration. Vertriebsmitarbeiter senden
aus einem Pipedrive-Deal einen persönlichen Buchungslink; der Kunde bucht auf einer
gebrandeten Seite einen Termin und bekommt eine Bestätigung mit Kalenderdatei.

Eine Installation für alle Kunden – ein neuer Kunde ist ein Datensatz (Mandant), keine
Code-Kopie. Architektur und Regeln: [`CLAUDE.md`](CLAUDE.md). Auftrag und Phasen:
[`docs/claude-code-prompt.md`](docs/claude-code-prompt.md). Design: [`docs/mockup/`](docs/mockup/).

**Stack:** Next.js (App Router, TypeScript strict) · Supabase (Postgres, Auth, Storage; EU) ·
Vercel (fra1) · zod · Vitest

## Projektstruktur

```
app/                 Next.js-Routen (Buchungsseite, später Admin, Pipedrive-Panel, Onboarding)
components/          UI-Komponenten (nutzen nur Theme-Variablen --tb-*)
lib/
  db/                Datenzugriff mit RLS (withActor), lokaler Migrations-Runner
  tenant/            Mandantenauflösung (Host / custom_domain / ?tenant=)
  theme/             Theme-Schema (zod), CSS-Variablen, Schriften-Allowlist, Kontrastprüfung
  texts/             Texte je Anrede (Sie/Ihr) + Overrides
  booking/           Buchungslink-Tokens
  crypto/            AES-256-GCM für gespeicherte Zugangsdaten
  storage/           Asset-Ablage (lokal bzw. Supabase Storage)
middleware.ts        ermittelt den Mandanten-Schlüssel je Request
supabase/
  migrations/        reguläre Migrationen (laufen unverändert auf Supabase)
  dev-shims/         NUR lokal: Nachbildung von auth-Schema und Supabase-Rollen
seed/                Seed-Mandanten (ANTENNE VORARLBERG, demo) und Assets
scripts/             db-dev-start.sh, db-reset.ts, seed.ts
tests/unit/          Theme, Texte, Host-Auflösung, Krypto/Tokens
tests/db/            RLS-Isolation (Mandant A/B/anonym), Buchungsfunktionen, parallele Buchungen
```

## Entwicklung in der Cloud (Claude Code im Web)

Es gibt keine lokale Supabase-Instanz und kein Docker. Es gibt zwei Ziele, die immer
**explizit** gewählt werden (nie implizit über gesetzte `SUPABASE_*`-Variablen):

| | lokal | Supabase-Projekt `rktitpxdwajstxlurkgq` |
|---|---|---|
| Datenbank | vorinstalliertes Postgres 16 + Dev-Shims (`DATABASE_URL`) | Management API (HTTPS) bzw. `SUPABASE_DB_URL` in Vercel |
| Migrationen | `npm run db:reset` | `npm run supabase:migrate` |
| Seed | `npm run db:seed` (`--target=local`) | `npm run supabase:seed` (`--target=supabase`) |
| Logos | `.data/dev-assets/` (`ASSET_STORAGE=local`) | Bucket `tenant-assets` (`ASSET_STORAGE=supabase`) |
| Admin-Benutzer | per SQL in den `auth.users`-Shim | keine per SQL – ab Phase 3 über die Auth-Admin-API |
| Tests | **immer** gegen `TEST_DATABASE_URL` (lokal) | nie |

### Lokale Entwicklungsdatenbank

Läuft gegen das in der Cloud-Umgebung vorinstallierte PostgreSQL 16 – auch wenn die
Supabase-Variablen gesetzt sind.

In Claude-Code-Cloud-Sessions erledigt der SessionStart-Hook
(`.claude/hooks/session-start.sh`) die folgenden Schritte automatisch: `npm install`,
`.env.local` anlegen (mit frischem `ENCRYPTION_KEY`), Postgres starten, Datenbanken
anlegen und – falls die Dev-Datenbank leer ist – Migrationen und Seed einspielen.
Manuell bzw. außerhalb der Cloud:

```bash
npm install
```

```bash
cp .env.example .env.local
```

In `.env.local` den `ENCRYPTION_KEY` setzen:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
npm run db:start
```

```bash
npm run db:reset
```

```bash
npm test
```

```bash
npm run dev
```

`db:reset` gibt am Ende persönliche Test-Buchungslinks für beide Mandanten aus.
Mandant lokal wählen: `http://localhost:3000/?tenant=antennevorarlberg` bzw. `?tenant=demo`
oder per Subdomain `http://demo.localhost:3000`.

Was die Shims (`supabase/dev-shims/`) nachbilden: Schema `auth` mit `auth.users`,
`auth.uid()`, `auth.role()`, `auth.jwt()` (aus `request.jwt.claims`), die Rollen `anon`,
`authenticated`, `service_role` und die Supabase-Standardrechte im Schema `public`.
Logos landen lokal unter `.data/dev-assets/` (gitignored, ausgeliefert über `/dev-assets/…`); Storage-Migration ist lokal ein No-op.

### Supabase-Projekt (`rktitpxdwajstxlurkgq`, EU)

Aus der Cloud-Umgebung gibt es **keine direkte DB-Verbindung** (nur HTTPS über den
Proxy; erlaubte Hosts `rktitpxdwajstxlurkgq.supabase.co`, `api.supabase.com`). Darum
laufen die Betriebsskripte unter `scripts/supabase/` über die Management API
(`SUPABASE_ACCESS_TOKEN`) bzw. die Projekt-API (`SUPABASE_SERVICE_ROLE_KEY`).
`SUPABASE_DB_URL` wird nur in Vercel gesetzt.

```bash
npm run supabase:inspect                 # Bestandsaufnahme, nur lesend
npm run supabase:migrate -- --dry-run    # zeigt offene Migrationen, schreibt nichts
npm run supabase:migrate                 # wendet offene Migrationen an
npm run supabase:seed                    # Seed-Mandanten + Logos in Bucket tenant-assets
```

- `supabase:migrate` wendet jede Datei aus `supabase/migrations/` zusammen mit ihrem
  Eintrag in `supabase_migrations.schema_migrations` in **einer** Abfrage an (implizite
  Transaktion: scheitert sie, bleibt nichts zurück). Damit ist die Historie dieselbe,
  die die Supabase-CLI führt – `npx supabase db push --db-url "$SUPABASE_DB_URL"`
  arbeitet später konsistent weiter. Die Dev-Shims werden **nie** angewendet.
  Bricht ab, wenn remote Versionen eingetragen sind, die lokal fehlen, oder wenn eine
  neue Migration älter ist als die zuletzt angewendete.
- `supabase:seed` ist idempotent (ersetzt die Seed-Mandanten, entfernt deren alte
  Logos) und läuft als ein atomares SQL-Skript.
- `npm run supabase:wipe -- --confirm=<projekt-ref>` leert das Projekt vollständig
  (public-Objekte, eigene Schemas, Migrationshistorie, Vault, Buckets, Auth-Benutzer).
  Nicht umkehrbar – nur auf ausdrückliche Anweisung.
- DB-Tests laufen immer gegen `TEST_DATABASE_URL` und brechen ab, wenn die URL auf
  Supabase zeigt (sie setzen die Datenbank komplett zurück).

### Vercel

- Repo mit Vercel verbinden, Function-Region **fra1**.
- Umgebungsvariablen: `SUPABASE_DB_URL` (Pooler-URL, Transaction-Modus),
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ASSET_STORAGE=supabase`, `ENCRYPTION_KEY`, `APP_DOMAIN`, `APP_BASE_URL`, `CRON_SECRET`
  (`SUPABASE_ACCESS_TOKEN` gehört **nicht** nach Vercel); für **Preview** zusätzlich `ALLOW_TENANT_QUERY_PARAM=true`,
  damit `?tenant=<slug>` funktioniert (in Production ist der Fallback immer aus).
- Production: Wildcard-Domain `*.<APP_DOMAIN>` und die Kundendomains
  (`tenants.custom_domain`, siehe „Mandanten und Domains“) im Vercel-Projekt eintragen.

## Buchungsseite & E-Mails (Phase 2)

- Buchungsseite: `/b/<token>` (persönlicher Link aus der Einladung). Lokal mit
  `?tenant=<slug>`; `npm run db:reset` gibt fertige Links aus.
- API: `POST /api/bookings` (buchen/umbuchen), `POST /api/bookings/cancel`,
  `.ics`: `GET /b/<token>/ics`.
- Mails laufen immer über `email_outbox`. Direkt nach einer Buchung wird die Outbox des
  Mandanten im Hintergrund abgearbeitet (`after()`), zusätzlich per Cron
  `GET /api/cron/outbox` (Header `Authorization: Bearer $CRON_SECRET`).
  `vercel.json` plant alle 5 Minuten – das braucht einen Vercel-Pro-Plan
  (Hobby erlaubt nur tägliche Cron-Jobs).
- Versand über das Postfach des Mandanten (`mail_connections`): `dev` (nur DB, Ansicht unter
  `/dev/mails`, braucht `DEV_TOOLS_ENABLED=true`) und `smtp`. Google/Microsoft folgen.
- Links in Mails: `lib/links.ts` + `TENANT_BASE_URL_TEMPLATE` (Domain-Struktur noch offen).
- Recherche Pipedrive-Mailversand: [`docs/research/pipedrive-mailversand.md`](docs/research/pipedrive-mailversand.md).

## Mandanten und Domains

Der Slug eines Mandanten ist seine **Pipedrive-Unternehmensdomain**
(`antennevorarlberg.pipedrive.com` → `antennevorarlberg`). Pipedrive-Domains sind
eindeutig, damit ist es auch der Slug. Die Buchungsseite ist intern unter
`antennevorarlberg.<APP_DOMAIN>` erreichbar.
Der Slug wird bei der Installation der Pipedrive-App einmal gesetzt und bleibt danach
stabil. Der Seed-Mandant `demo` hat keine Pipedrive-Verbindung.

**Entschieden (Variante A): eigene Subdomain des Kunden.** Jeder Kunde wählt frei eine
Subdomain seiner eigenen Domain (z. B. `termine.`, `events.`, `webinare.kunde.at`) und
setzt einen CNAME auf unsere App. Die Domain steht in `tenants.custom_domain` und wird
im Vercel-Projekt eingetragen; ab Phase 5 automatisiert im Onboarding (inkl. DNS-Prüfung).
Die Mandantenauflösung über `custom_domain` gibt es bereits (`resolve_tenant`).
Keine Einbettung per iframe (vorerst).

## Umgebungsvariablen

Siehe [`.env.example`](.env.example). Keine Secrets committen.

| Variable | Zweck |
|---|---|
| `DATABASE_URL` | lokale Dev-Datenbank |
| `TEST_DATABASE_URL` | lokale Testdatenbank, wird bei jedem Testlauf zurückgesetzt (nie Supabase) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase-Projekt (Service-Key nur serverseitig) |
| `SUPABASE_DB_URL` | nur Vercel: DB-Verbindung, hat Vorrang vor `DATABASE_URL` |
| `SUPABASE_ACCESS_TOKEN` | nur Betriebsskripte (`npm run supabase:*`), nie in Vercel |
| `ASSET_STORAGE` | `local` (Standard) oder `supabase` – Ablage der Mandanten-Logos |
| `APP_DOMAIN` | Basis-Domain für `<slug>.<APP_DOMAIN>` |
| `APP_BASE_URL` | öffentliche Basis-URL für Links in Mails |
| `ALLOW_TENANT_QUERY_PARAM` | `?tenant=`-Fallback (nur Dev/Preview) |
| `TENANT_BASE_URL_TEMPLATE` | Vorlage für Mandanten-URLs in Mails, z. B. `https://{slug}.termine.example.at` |
| `DEV_TOOLS_ENABLED` | `/dev/mails` u. Ä. (in Production immer aus) |
| `ENCRYPTION_KEY` | 32 Byte base64, verschlüsselt Tokens/Passwörter |
| `CRON_SECRET` | schützt den Outbox-Cron-Endpunkt |
