# Terminbuchungstool

Mandantenfähiges Terminbuchungstool mit Pipedrive-Integration. Vertriebsmitarbeiter senden
aus einem Pipedrive-Deal einen persönlichen Buchungslink; der Kunde bucht auf einer
gebrandeten Seite einen Termin und bekommt eine Bestätigung mit Kalenderdatei.

Eine Installation für alle Kunden – ein neuer Kunde ist ein Datensatz (Mandant), keine
Code-Kopie. Architektur und Regeln: [`CLAUDE.md`](CLAUDE.md). Auftrag und Phasen:
[`docs/claude-code-prompt.md`](docs/claude-code-prompt.md). Design: [`docs/mockup/`](docs/mockup/).

**Stack:** Next.js (App Router, TypeScript strict) · Supabase (Postgres, Auth, Storage; EU) ·
eigener Server bei Hetzner (EU) · zod · Vitest

## Projektstruktur

```
app/                 Next.js-Routen (Buchungsseite, Admin /admin, Login /api/auth/*, später Panel/Onboarding)
components/          UI-Komponenten (nutzen nur Theme-Variablen --tb-*)
lib/
  db/                Datenzugriff mit RLS (withActor), lokaler Migrations-Runner
  tenant/            Mandantenauflösung (Host / custom_domain / ?tenant=)
  theme/             Theme-Schema (zod), CSS-Variablen, Schriften-Allowlist, Kontrastprüfung
  texts/             Texte je Anrede (Sie/Ihr) + Overrides
  auth/              Sitzung (versiegeltes Cookie), Pipedrive-Login, auth-Benutzer anlegen
  admin/             Admin-Backend: Termine/Kapazitäten, Nutzerverwaltung (Datenzugriff + Logik)
  pipedrive/         OAuth/API-Client, Verbindung (Token-Refresh), Benutzerverzeichnis, Slug
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

| | lokal | Supabase-Projekt `pkegcsgnyicdxzivnijw` |
|---|---|---|
| Datenbank | vorinstalliertes Postgres 16 + Dev-Shims (`DATABASE_URL`) | Management API (HTTPS) bzw. `SUPABASE_DB_URL` auf dem Server |
| Migrationen | `npm run db:reset` | `npm run supabase:migrate` |
| Seed | `npm run db:seed` (`--target=local`) | `npm run supabase:seed` (`--target=supabase`) |
| Logos | `.data/dev-assets/` (`ASSET_STORAGE=local`) | Bucket `tenant-assets` (`ASSET_STORAGE=supabase`) |
| Benutzer | Seed per SQL in den `auth.users`-Shim (`AUTH_ADMIN=local`) | nie per SQL – beim Freischalten über die Auth-Admin-API (`AUTH_ADMIN=supabase`) |
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

### Supabase-Projekt (`pkegcsgnyicdxzivnijw`, EU)

Aus der Cloud-Umgebung gibt es **keine direkte DB-Verbindung** (nur HTTPS über den
Proxy; erlaubte Hosts `pkegcsgnyicdxzivnijw.supabase.co`, `api.supabase.com`). Darum
laufen die Betriebsskripte unter `scripts/supabase/` über die Management API
(`SUPABASE_ACCESS_TOKEN`) bzw. die Projekt-API (`SUPABASE_SERVICE_ROLE_KEY`).
`SUPABASE_DB_URL` wird nur auf dem Produktionsserver gesetzt.

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

### Hosting: eigener Server bei Hetzner (entschieden)

Die App läuft als Node-Prozess (`next build` + `next start`) auf einem eigenen
Hetzner-Server in der EU; Supabase bleibt für Datenbank, Auth und Storage. Vercel wird
nicht verwendet (`vercel.json` ist ein Überbleibsel und entfällt mit dem Server-Setup).
Noch umzusetzen (eigener Schritt, vor dem ersten echten Kunden):

- Reverse Proxy mit automatischem HTTPS auch für Kundendomains (`tenants.custom_domain`),
  z. B. Caddy mit On-Demand-TLS, das vor jedem Zertifikat bei der App nachfragt, ob die
  Domain einem Mandanten gehört.
- Outbox-Cron: Server-Cron/systemd-Timer ruft `GET /api/cron/outbox`
  (Header `Authorization: Bearer $CRON_SECRET`) z. B. jede Minute auf – kein Tarif-Limit.
- Umgebungsvariablen auf dem Server: `SUPABASE_DB_URL` (Pooler-URL, Transaction-Modus),
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ASSET_STORAGE=supabase`, `ENCRYPTION_KEY`, `APP_DOMAIN`, `APP_BASE_URL`, `CRON_SECRET`
  (`SUPABASE_ACCESS_TOKEN` gehört **nicht** auf den Server).
- Statt Vercel-Previews: eine Staging-Instanz mit `ALLOW_TENANT_QUERY_PARAM=true`.

## Buchungsseite & E-Mails (Phase 2)

- Buchungsseite: `/b/<token>` (persönlicher Link aus der Einladung). Lokal mit
  `?tenant=<slug>`; `npm run db:reset` gibt fertige Links aus.
- API: `POST /api/bookings` (buchen/umbuchen), `POST /api/bookings/cancel`,
  `.ics`: `GET /b/<token>/ics`.
- Mails laufen immer über `email_outbox`. Direkt nach einer Buchung wird die Outbox des
  Mandanten im Hintergrund abgearbeitet (`after()`), zusätzlich per Cron
  `GET /api/cron/outbox` (Header `Authorization: Bearer $CRON_SECRET`).
  Auf dem Hetzner-Server per Cron/systemd-Timer (siehe „Hosting“).
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
im Reverse Proxy freigeschaltet (automatisches HTTPS); ab Phase 5 automatisiert im Onboarding (inkl. DNS-Prüfung).
Die Mandantenauflösung über `custom_domain` gibt es bereits (`resolve_tenant`).
Keine Einbettung per iframe (vorerst).

## Admin-Backend und Benutzer (Phase 3)

- **Admin-Backend:** `/admin` auf der Adresse des Mandanten (`<slug>.<APP_DOMAIN>/admin`,
  lokal `http://localhost:3000/admin?tenant=antennevorarlberg`). Termine & Kapazitäten
  (KPIs, Belegung, Kapazität +1, Buchungen je Termin mit Deal-Link, Termin anlegen) und
  Nutzerverwaltung. Weitere Bereiche (Buchungen, Veranstaltungsarten, E-Mail-Vorlagen,
  Pipedrive-Verbindung) folgen.
- **Anmeldung nur über Pipedrive** („Mit Pipedrive anmelden“, OAuth). Ablauf: Start auf der
  Mandanten-Adresse (Nonce-Cookie) → Pipedrive → zentraler Callback
  `<APP_BASE_URL>/api/auth/pipedrive/callback` → Einmal-Ticket zurück auf die
  Mandanten-Adresse → Sitzungs-Cookie (12 h). Keine Passwörter, keine Einladungsmails –
  darum braucht Supabase Auth auch **keinen eigenen SMTP-Server**.
- **Nutzerverwaltung** (`/admin/benutzer`): zeigt alle Benutzer der Pipedrive-Firma. Neue
  Benutzer haben keinen Zugriff, bis ein Owner oder Admin sie freischaltet und eine Rolle
  vergibt (Owner / Admin / Vertrieb). Admins verwalten alle außer Owner; es bleibt immer
  mindestens ein aktiver Owner. Gesperrte Benutzer verlieren sofort jeden Zugriff (RLS).
  Wer die Pipedrive-App installiert, wird Owner (Phase 4). Dieselbe Verwaltung kommt
  später zusätzlich in die Einstellungen der Pipedrive-App (eingebettet, Anmeldung dort
  über das Pipedrive-JWT statt Cookie).
- **Lokal ohne OAuth-App:** Die Login-Seite bietet mit `DEV_TOOLS_ENABLED=true` einen
  Dev-Login als freigeschaltetes Mitglied; die Pipedrive-Benutzer kommen aus dem Seed
  (`PIPEDRIVE_DIRECTORY=fake`). Seed: je Mandant ein Owner, bei ANTENNE VORARLBERG
  zusätzlich ein Vertriebsmitarbeiter und zwei Benutzer ohne Zugriff.
- **Für den echten Login nötig:** OAuth-App im Pipedrive Developer Hub
  (`PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET`, Callback-URL siehe oben) und eine
  Pipedrive-Verbindung des Mandanten (`pipedrive_connections`, entsteht bei der Installation
  in Phase 4).

## Umgebungsvariablen

Siehe [`.env.example`](.env.example). Keine Secrets committen.

| Variable | Zweck |
|---|---|
| `DATABASE_URL` | lokale Dev-Datenbank |
| `TEST_DATABASE_URL` | lokale Testdatenbank, wird bei jedem Testlauf zurückgesetzt (nie Supabase) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase-Projekt (Service-Key nur serverseitig) |
| `SUPABASE_DB_URL` | nur Produktionsserver: DB-Verbindung, hat Vorrang vor `DATABASE_URL` |
| `SUPABASE_ACCESS_TOKEN` | nur Betriebsskripte (`npm run supabase:*`), nie auf dem Server |
| `ASSET_STORAGE` | `local` (Standard) oder `supabase` – Ablage der Mandanten-Logos |
| `APP_DOMAIN` | Basis-Domain für `<slug>.<APP_DOMAIN>` |
| `APP_BASE_URL` | öffentliche Basis-URL für Links in Mails |
| `ALLOW_TENANT_QUERY_PARAM` | `?tenant=`-Fallback (nur Dev/Preview) |
| `TENANT_BASE_URL_TEMPLATE` | Vorlage für Mandanten-URLs in Mails, z. B. `https://{slug}.termine.example.at` |
| `DEV_TOOLS_ENABLED` | `/dev/mails` u. Ä. (in Production immer aus) |
| `ENCRYPTION_KEY` | 32 Byte base64, verschlüsselt Tokens/Passwörter |
| `CRON_SECRET` | schützt den Outbox-Cron-Endpunkt |
| `AUTH_ADMIN` | `local` (Shim per SQL) oder `supabase` (Auth-Admin-API) – Anlegen von Benutzern beim Freischalten |
| `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` | OAuth-App aus dem Pipedrive Developer Hub (Login, Installation) |
| `PIPEDRIVE_DIRECTORY` | `api` (Pipedrive, Server) oder `fake` (Seed-Benutzer, nur lokal) – Benutzerliste der Nutzerverwaltung |
