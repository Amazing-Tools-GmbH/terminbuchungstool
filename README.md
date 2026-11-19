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
  tenant/            Mandantenauflösung (Buchungslink-Token / Sitzung / custom_domain)
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
Der Mandant ergibt sich aus dem Buchungslink (`/b/<token>`) bzw. im Admin-Backend
(`http://localhost:3000/admin`, Dev-Login) aus der Sitzung – kein `?tenant=` nötig.

Was die Shims (`supabase/dev-shims/`) nachbilden: Schema `auth` mit `auth.users`,
`auth.uid()`, `auth.role()`, `auth.jwt()` (aus `request.jwt.claims`), die Rollen `anon`,
`authenticated`, `service_role` und die Supabase-Standardrechte im Schema `public`.
Logos landen lokal unter `.data/dev-assets/` (gitignored, ausgeliefert über `/dev-assets/…`); Storage-Migration ist lokal ein No-op.

### Supabase-Projekt (`pkegcsgnyicdxzivnijw`, EU)

Aus der Cloud-Umgebung gibt es **keine direkte DB-Verbindung** (nur HTTPS über den
Proxy; erlaubte Hosts `pkegcsgnyicdxzivnijw.supabase.co`, `api.supabase.com`). Darum
laufen die Betriebsskripte unter `scripts/supabase/` über die Management API
(`SUPABASE_ACCESS_TOKEN`) bzw. die Projekt-API (`SUPABASE_SECRET_KEY`).
`SUPABASE_DB_URL` wird nur auf dem Produktionsserver gesetzt.

In der Cloud-Umgebung muss Node dafür den Proxy nutzen, solange der Projekt-Host nicht
als erlaubte Domain eingetragen ist: `export NODE_USE_ENV_PROXY=1` vor den Befehlen.
Die Skripte brechen ab, wenn `SUPABASE_URL` nicht auf `SUPABASE_PROJECT_REF` zeigt.

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

### Adresse: `https://meetings.atools.de` (Root)

Produktiv: `APP_BASE_URL=https://meetings.atools.de` – die App liegt im Root, kein Unterpfad.
`next.config.ts` liest daraus beim **Build** einen `basePath`; ohne Pfad ist er leer. (Ein
Unterpfad wie `https://meetings.atools.de` würde weiter funktionieren – alle Links, Redirects,
Cookies und Mail-Links laufen über `withBasePath()`/`lib/links.ts`; nach Änderung neu bauen.)

- **Pipedrive-Callback** (Developer Hub): `https://meetings.atools.de/api/auth/pipedrive/callback`.
  Google/Microsoft (nur bei `INVITE_MAIL_PROVIDER=oauth`):
  `https://meetings.atools.de/api/mail/oauth/google/callback` bzw. `…/microsoft/callback`.
- `APP_DOMAIN` ergibt sich aus `APP_BASE_URL` (`meetings.atools.de`), kann aber explizit gesetzt werden.

### Hosting: Hetzner, Node-Prozess unter systemd, Caddy davor (kein Docker)

Vorlagen in [`deploy/`](deploy/):

| Datei | Zweck |
|---|---|
| `deploy/systemd/terminbuchung.service` | `next start -H 127.0.0.1 -p 3003` als eigener Benutzer `terminbuchung`, gehärtet, Neustart bei Absturz |
| `deploy/systemd/terminbuchung-cron.{service,timer}` | jede Minute `GET /api/cron/outbox` (Mails + Pipedrive-Aufträge); `CRON_SECRET` per stdin, nicht in `ps` |
| `deploy/Caddyfile` | `meetings.atools.de` → `127.0.0.1:3003`, HTTPS automatisch |
| `deploy/env.example` | Vorlage für `/etc/terminbuchung/env` (Laufzeit **und** Build) |
| `deploy/deploy.sh` | Version holen, `npm ci`, Build mit derselben env |

**Einrichtung (einmalig):**

```bash
sudo useradd --system --create-home --home-dir /opt/terminbuchung --shell /usr/sbin/nologin terminbuchung
sudo -u terminbuchung git clone <repo> /opt/terminbuchung/app
sudo install -d -m 0750 -o root -g terminbuchung /etc/terminbuchung
sudo install -m 0640 -o root -g terminbuchung /opt/terminbuchung/app/deploy/env.example /etc/terminbuchung/env
sudoedit /etc/terminbuchung/env            # Werte eintragen
sudo -u terminbuchung /opt/terminbuchung/app/deploy/deploy.sh main
sudo cp /opt/terminbuchung/app/deploy/systemd/terminbuchung* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now terminbuchung terminbuchung-cron.timer
# Caddy: Block aus deploy/Caddyfile in /etc/caddy/Caddyfile übernehmen
sudo systemctl reload caddy
```

**Update:** `sudo -u terminbuchung /opt/terminbuchung/app/deploy/deploy.sh main && sudo systemctl restart terminbuchung`.
Migrationen laufen getrennt (`npm run supabase:migrate`), vor dem Ausrollen.

- Node 22 (LTS); der Pfad in `ExecStart` ist `/usr/bin/node` – bei nvm o. Ä. anpassen.
- **Panel im Pipedrive-iframe:** Die App setzt für `/panel` selbst
  `Content-Security-Policy: frame-ancestors 'self' https://*.pipedrive.com` und für alle
  anderen Seiten `X-Frame-Options: SAMEORIGIN`. In Caddy darum **keine** eigenen
  `X-Frame-Options`/`frame-ancestors`-Header setzen. Das Panel braucht keine Cookies
  (Sitzung als Bearer-Token), Drittanbieter-Cookie-Sperren der Browser stören also nicht.
- Port 3003 nur auf `127.0.0.1` – von außen nur über Caddy erreichbar (Firewall: 80/443).
- `SUPABASE_ACCESS_TOKEN` gehört **nicht** auf den Server; `DEV_TOOLS_ENABLED` dort nie `true`.
- Eigene Kundendomains (Phase 5): Caddy On-Demand-TLS mit Prüf-Endpunkt der App – im
  `deploy/Caddyfile` auskommentiert vorbereitet.
- Statt Vercel-Previews: eine Staging-Instanz (zweiter Dienst, anderer Port/Host) mit
  `ALLOW_TENANT_QUERY_PARAM=true`.

## Buchungsseite & E-Mails (Phase 2)

- Buchungsseite: `/b/<token>` (persönlicher Link aus der Einladung). Lokal mit
  `npm run db:reset` gibt fertige Links aus (Mandant ergibt sich aus dem Token).
- API: `POST /api/bookings` (buchen/umbuchen), `POST /api/bookings/cancel`,
  `.ics`: `GET /b/<token>/ics`.
- Mails laufen immer über `email_outbox`. Direkt nach einer Buchung wird die Outbox des
  Mandanten im Hintergrund abgearbeitet (`after()`), zusätzlich per Cron
  `GET /api/cron/outbox` (Header `Authorization: Bearer $CRON_SECRET`).
  Auf dem Hetzner-Server per Cron/systemd-Timer (siehe „Hosting“).
- Versandwege siehe „Mailversand“. Mit `SYSTEM_MAIL_TRANSPORT=dev` landen Mails nur in der
  DB (Ansicht unter `/dev/mails`, braucht `DEV_TOOLS_ENABLED=true`).
- Links in Mails: `lib/links.ts` – `APP_BASE_URL` bzw. eigene Kundendomain, jeweils mit Unterpfad.
- Recherche Pipedrive-Mailversand: [`docs/research/pipedrive-mailversand.md`](docs/research/pipedrive-mailversand.md).

## Mandanten und Adressen (entschieden)

Alles läuft **zentral unter `APP_BASE_URL`** (`https://meetings.atools.de`) – keine
Subdomain je Kunde, kein DNS-Aufwand. Wie bei der SevDesk-Schnittstelle ergibt sich der
Kunde aus seiner Pipedrive-Identität bzw. aus dem Buchungslink:

| Seite | Adresse | Mandant aus |
|---|---|---|
| Buchungsseite | `…/b/<token>` | dem Buchungslink (Token) |
| Admin-Backend | `…/admin` | der Sitzung |
| Login | „Mit Pipedrive anmelden“ | der Pipedrive-Firma (`company_id`) |
| Einstieg aus Pipedrive | `…/settings?userId=…&companyId=…&token=…` | `companyId`, abgesichert durch das signierte Token |
| Panel im Deal | `…/panel?…&selectedIds=<deal>&token=…` | `companyId` aus dem signierten Token |

- **Pipedrive Developer Hub:** Callback-URL `https://meetings.atools.de/api/auth/pipedrive/callback`,
  „App settings“-Seite `https://meetings.atools.de/settings`. Das Token prüft die App mit
  `PIPEDRIVE_JWT_SECRET` (leer = Client-Secret), es darf höchstens 15 Minuten alt sein.
- Der Slug (= Pipedrive-Unternehmensdomain) ist nur noch eine interne Kennung.
- **Adresse in Pipedrive geändert** (`alt.pipedrive.com` → `neu.pipedrive.com`): Der Mandant
  hängt an der `company_id` und bleibt gleich; Buchungslinks bleiben gültig. Die gespeicherte
  Adresse (für Deal-Links) zieht die App bei Login, Installation und jeder Token-Erneuerung
  (etwa stündlich) aus der `api_domain` nach.
- **Optional eigene Domain** des Kunden (`tenants.custom_domain`, z. B.
  `termine.kunde.at/meetings` per CNAME) für Buchungsseiten; Links in Mails nutzen sie dann.
  Einrichtung in den Pipedrive-App-Einstellungen (Phase 5, mit DNS-Prüfung und HTTPS).
  Keine Einbettung per iframe.

## Mailversand

| Mail | Weg | Bei Problemen |
|---|---|---|
| Einladung | `INVITE_MAIL_PROVIDER=pipedrive` (Standard): über das in Pipedrive verbundene Postfach des Mitarbeiters – steht im Deal-Verlauf und in „Gesendet“ | Meldung an den Mitarbeiter (z. B. „In Pipedrive ist kein Postfach verbunden“), kein anderer Weg |
| | `oauth`: über sein per Google/Microsoft verbundenes Postfach | Meldung, kein anderer Weg |
| | `smtp`: System-Adresse, Anzeigename + Reply-To = Mitarbeiter, Smart BCC | wartet, bis der System-Absender funktioniert |
| Bestätigung/Stornierung (.ics) | immer System-SMTP (`SYSTEM_MAIL_*`), Reply-To = einladender Mitarbeiter, Smart BCC | wartet, bis der System-Absender funktioniert |

- **Pipedrive-Versand:** Die App speichert beim „Mit Pipedrive anmelden“ die Tokens des
  Mitarbeiters (verschlüsselt). Voraussetzungen: Pipedrive-App mit Scope `mail-sending:full`
  und ein in Pipedrive verbundenes Postfach. Versand über Pipedrives offiziellen MCP-Server
  (`PIPEDRIVE_MAIL_TRANSPORT=mcp`, Standard – so ging der Live-Test raus) oder die REST-API
  (`rest`). Beide sind nicht in der API-Referenz dokumentiert; der genaue Aufruf mit dem
  Token unserer App wird live geprüft, sobald die Pipedrive-App existiert. Details:
  [`docs/research/pipedrive-mailversand.md`](docs/research/pipedrive-mailversand.md).
- **Mein Postfach** (`/admin/postfach`): Versandstatus, Signatur (wird unter Einladungen
  gesetzt), bei `oauth` die Buttons „Mit Google/Microsoft verbinden“ (nur mit eingetragenen
  Zugangsdaten).
- **E-Mail-Einstellungen** (`/admin/email`, Owner/Admin): Versandwege, Smart BCC (eine
  Adresse je Pipedrive-Firma), Versandstatus im Team, nicht versendete Einladungen.
- Lokal: `SYSTEM_MAIL_TRANSPORT=dev` – Mails landen unter `/dev/mails`.

## Pipedrive-App (Phase 4)

**Einrichtung im Developer Hub** (eine App für alle Kunden):

| Feld | Wert |
|---|---|
| Callback-URL | `https://meetings.atools.de/api/auth/pipedrive/callback` |
| App-Deinstallation (Webhook) | dieselbe Callback-URL (Pipedrive ruft sie mit `DELETE` und Basic-Auth auf) |
| App settings (eigene Seite) | `https://meetings.atools.de/settings` |
| App-Erweiterung „Custom panel“, Deal-Detailansicht | `https://meetings.atools.de/panel`, JWT-Secret = `PIPEDRIVE_JWT_SECRET` (oder leer = Client-Secret) |
| Scopes | Basis, Deals (voll), Kontakte (lesen), Aktivitäten (voll), Benutzer (lesen), `mail-sending:full` |

- **Installation:** Die Installation läuft über dieselbe Callback-URL (ohne `state`). Neue
  Pipedrive-Firma ⇒ Mandant (Slug = Unternehmensdomain, Name/Zeitzone aus Pipedrive),
  Verbindung, Installierende:r wird Owner und ist gleich angemeldet (`/admin?installed=1`,
  dort „Veranstaltung anlegen“). Gibt es bereits einen vorbereiteten Mandanten mit genau
  diesem Slug, der noch **nie** mit Pipedrive verbunden war (z. B. aus dem Seed), wird er
  übernommen – Theme, Termine, Name und Zeitzone bleiben, Installierende:r wird Owner.
  Ein schon einmal verbundener Mandant wird nie übernommen (dann neuer Mandant mit Zähler,
  z. B. `demo-2`). Erneute Installation erneuert nur die Tokens.
  Deinstallation setzt die Verbindung auf `revoked` – Daten bleiben erhalten.
- **Panel im Deal** (`/panel`): Pipedrive lädt die Seite im iframe mit signiertem Token
  (wie `/settings`, max. 15 Min. alt). Daraus entsteht eine Panel-Sitzung (versiegelt, 2 h,
  kein Cookie – Drittanbieter-Cookies sind in iframes unzuverlässig); läuft sie ab, holt das
  Panel über das SDK (`@pipedrive/app-extensions-sdk`) ein frisches Token. Nur
  freigeschaltete Mitglieder. Inhalt nach Mock-up: Kontakt mit Status (offen, gesendet,
  Versandfehler mit Grund, gebucht, storniert), Veranstaltung, Wochenansicht, Senden
  (Standard ein Termin; unter ▾ mehrere oder alle), persönlicher Link mit „Kopieren“,
  freie Plätze, Link zum Admin. Kontaktdaten kommen immer aus Pipedrive, nie aus dem
  Browser. Erneut senden macht den alten Link ungültig. `/panel` darf nur von
  `*.pipedrive.com` eingebettet werden (CSP `frame-ancestors`), alle anderen Seiten gar nicht.
- **Einträge im Deal** (Warteschlange `pipedrive_jobs`, abgearbeitet nach jeder Buchung
  und per Cron, mit Backoff): Notiz „Link gesendet“ beim Versand (außer beim Versand über
  Pipedrive – der steht dort ohnehin im Verlauf), Aktivität „Meeting“ bei Buchung
  (Besitzer = einladender Mitarbeiter, Teilnehmer = Kontakt), Umbuchung ändert dieselbe
  Aktivität, Stornierung löscht sie und legt eine Notiz an.
- **Lokal:** `/dev/panel` (mit `DEV_TOOLS_ENABLED=true`) simuliert den Aufruf aus einem Deal
  mit Seed-Benutzern und -Deals (`PIPEDRIVE_DIRECTORY=fake`).

## Admin-Backend und Benutzer (Phase 3)

- **Admin-Backend:** zentral unter `/admin` (`https://meetings.atools.de/admin`, lokal
  `http://localhost:3000/admin`); der Mandant steht in der Sitzung. Termine & Kapazitäten
  (KPIs, Belegung, Kapazität +1, Buchungen je Termin mit Deal-Link, Termin anlegen) und
  Nutzerverwaltung. Weitere Bereiche (Buchungen, Veranstaltungsarten, E-Mail-Vorlagen,
  Pipedrive-Verbindung) folgen.
- **Anmeldung nur über Pipedrive** („Mit Pipedrive anmelden“, OAuth) oder per Einstieg aus
  den Pipedrive-App-Einstellungen (`/settings`, signiertes Token). Ablauf Login: Start auf
  `APP_BASE_URL` (Nonce-Cookie) → Pipedrive → Callback (gleiche Adresse) → Mandant über die
  Pipedrive-Firma → Sitzungs-Cookie (12 h). Keine Passwörter, keine Einladungsmails –
  darum braucht Supabase Auth auch **keinen eigenen SMTP-Server**.
- **Nutzerverwaltung** (`/admin/benutzer`): zeigt alle Benutzer der Pipedrive-Firma. Neue
  Benutzer haben keinen Zugriff, bis ein Owner oder Admin sie freischaltet und eine Rolle
  vergibt (Owner / Admin / Vertrieb). Admins verwalten alle außer Owner; es bleibt immer
  mindestens ein aktiver Owner. Gesperrte Benutzer verlieren sofort jeden Zugriff (RLS).
  Wer die Pipedrive-App installiert, wird Owner. Dieselbe Verwaltung kommt
  später zusätzlich in die Einstellungen der Pipedrive-App (eingebettet, Anmeldung dort
  über das Pipedrive-JWT statt Cookie).
- **Lokal ohne OAuth-App:** Die Login-Seite bietet mit `DEV_TOOLS_ENABLED=true` einen
  Dev-Login als freigeschaltetes Mitglied; die Pipedrive-Benutzer kommen aus dem Seed
  (`PIPEDRIVE_DIRECTORY=fake`). Seed: je Mandant ein Owner, bei ANTENNE VORARLBERG
  zusätzlich ein Vertriebsmitarbeiter und zwei Benutzer ohne Zugriff.
- **Für den echten Login nötig:** OAuth-App im Pipedrive Developer Hub
  (`PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET`, Callback-URL siehe oben) und eine
  Pipedrive-Verbindung des Mandanten (`pipedrive_connections`, entsteht bei der Installation).

## Umgebungsvariablen

Siehe [`.env.example`](.env.example). Keine Secrets committen.

| Variable | Zweck |
|---|---|
| `DATABASE_URL` | lokale Dev-Datenbank |
| `TEST_DATABASE_URL` | lokale Testdatenbank, wird bei jedem Testlauf zurückgesetzt (nie Supabase) |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Supabase-Projekt, neue API-Schlüssel (`sb_publishable_…`, `sb_secret_…`; secret nur serverseitig). Alte Namen `SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` gelten als Fallback |
| `SUPABASE_DB_URL` | nur Produktionsserver: DB-Verbindung, hat Vorrang vor `DATABASE_URL` |
| `SUPABASE_ACCESS_TOKEN` | nur Betriebsskripte (`npm run supabase:*`), nie auf dem Server |
| `ASSET_STORAGE` | `local` (Standard) oder `supabase` – Ablage der Mandanten-Logos |
| `APP_DOMAIN` | Host der App (Produktion `meetings.atools.de`; leer = aus `APP_BASE_URL`) |
| `APP_BASE_URL` | öffentliche Basis-URL für Links in Mails |
| `ALLOW_TENANT_QUERY_PARAM` | `?tenant=` auf der Startseite (nur Entwicklung) |
| `PIPEDRIVE_JWT_SECRET` | prüft das Token der „App settings“-Seite (leer = Client-Secret) |
| `DEV_TOOLS_ENABLED` | `/dev/mails` u. Ä. (in Production immer aus) |
| `ENCRYPTION_KEY` | 32 Byte base64, verschlüsselt Tokens/Passwörter |
| `CRON_SECRET` | schützt den Outbox-Cron-Endpunkt |
| `AUTH_ADMIN` | `local` (Shim per SQL) oder `supabase` (Auth-Admin-API) – Anlegen von Benutzern beim Freischalten |
| `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` | OAuth-App aus dem Pipedrive Developer Hub (Login, Installation) |
| `INVITE_MAIL_PROVIDER` | Weg für Einladungen: `pipedrive` (Standard) \| `oauth` \| `smtp` |
| `PIPEDRIVE_MAIL_TRANSPORT` | Pipedrive-Versand über `mcp` (Standard) oder `rest` |
| `SYSTEM_MAIL_TRANSPORT`, `SYSTEM_MAIL_FROM`, `SYSTEM_MAIL_FROM_NAME`, `SYSTEM_SMTP_HOST/PORT/SECURE/USER/PASS` | System-Absender (Bestätigungen; Einladungen bei `smtp`); `dev` nur lokal |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | OAuth-Apps für „Postfach verbinden“ (nur bei `INVITE_MAIL_PROVIDER=oauth`) |
| `PIPEDRIVE_DIRECTORY` | `api` (Pipedrive, Server) oder `fake` (Seed-Benutzer, nur lokal) – Benutzerliste der Nutzerverwaltung |
