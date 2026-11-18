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

Es gibt keine lokale Supabase-Instanz und kein Docker.

### Übergangslösung: ohne Supabase-Projekt (aktueller Stand)

Solange `SUPABASE_URL` / `SUPABASE_DB_URL` fehlen, läuft alles gegen das in der
Cloud-Umgebung vorinstallierte PostgreSQL 16:

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
Mandant lokal wählen: `http://localhost:3000/?tenant=antenne-vorarlberg` bzw. `?tenant=demo`
oder per Subdomain `http://demo.localhost:3000`.

Was die Shims (`supabase/dev-shims/`) nachbilden: Schema `auth` mit `auth.users`,
`auth.uid()`, `auth.role()`, `auth.jwt()` (aus `request.jwt.claims`), die Rollen `anon`,
`authenticated`, `service_role` und die Supabase-Standardrechte im Schema `public`.
Logos landen lokal unter `public/dev-assets/` (gitignored); Storage-Migration ist lokal ein No-op.

### Mit Supabase-Dev-Projekt

1. Projekt in Region **EU (Frankfurt)** anlegen.
2. In den Einstellungen der Cloud-Umgebung als Umgebungsvariablen hinterlegen:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
   (Pooler-URL, Transaction-Modus) sowie `ENCRYPTION_KEY`, `APP_DOMAIN`, `APP_BASE_URL`,
   `CRON_SECRET`. Eine neue Session übernimmt sie.
3. Migrationen anwenden (Shims entfallen):

   ```bash
   npx supabase db push --db-url "$SUPABASE_DB_URL"
   ```

4. Seed einspielen (lädt das Logo in den Bucket `tenant-assets`):

   ```bash
   npm run db:seed
   ```

5. DB-Tests laufen weiterhin gegen eine separate Testdatenbank (`TEST_DATABASE_URL`),
   weil sie die Datenbank zurücksetzen – niemals gegen das Supabase-Projekt.

### Vercel

- Repo mit Vercel verbinden, Function-Region **fra1**.
- Umgebungsvariablen wie oben; für **Preview** zusätzlich `ALLOW_TENANT_QUERY_PARAM=true`,
  damit `?tenant=<slug>` funktioniert (in Production ist der Fallback immer aus).
- Production: Wildcard-Domain `*.<APP_DOMAIN>` und ggf. eigene Kundendomains
  (`tenants.custom_domain`) im Vercel-Projekt eintragen.

## Umgebungsvariablen

Siehe [`.env.example`](.env.example). Keine Secrets committen.

| Variable | Zweck |
|---|---|
| `DATABASE_URL` | lokale Dev-Datenbank (Übergangslösung) |
| `TEST_DATABASE_URL` | Testdatenbank, wird bei jedem Testlauf zurückgesetzt |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | Supabase-Projekt; `SUPABASE_DB_URL` hat Vorrang vor `DATABASE_URL` |
| `APP_DOMAIN` | Basis-Domain für `<slug>.<APP_DOMAIN>` |
| `APP_BASE_URL` | öffentliche Basis-URL für Links in Mails |
| `ALLOW_TENANT_QUERY_PARAM` | `?tenant=`-Fallback (nur Dev/Preview) |
| `ENCRYPTION_KEY` | 32 Byte base64, verschlüsselt Tokens/Passwörter |
| `CRON_SECRET` | schützt den Outbox-Cron-Endpunkt |
