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

### Adresse: `https://meetings.atools.de` (Root, kein Unterpfad)

`APP_BASE_URL=https://meetings.atools.de`. Die App hat **keinen basePath**; enthält
`APP_BASE_URL` einen Pfad, bricht der Build ab. Alle Links (Mails, Redirects, OAuth) bauen auf
dem Origin von `APP_BASE_URL` auf (`lib/links.ts`, `lib/auth/urls.ts`).

| Was | Adresse |
|---|---|
| Admin-Backend | `https://meetings.atools.de/admin` |
| Buchungsseite | `https://meetings.atools.de/b/<token>` |
| Pipedrive-Callback (Login, Installation, Deinstallation) | `https://meetings.atools.de/api/auth/pipedrive/callback` |
| Pipedrive „App settings“ | `https://meetings.atools.de/settings` |
| **Pipedrive-Panel (Custom Panel im Deal)** | **`https://meetings.atools.de/panel`** |
| Google/Microsoft („Mein Postfach“) | `https://meetings.atools.de/api/mail/oauth/google/callback` bzw. `…/microsoft/callback` |
| Health-Check (auf dem Server) | `http://127.0.0.1:3003/api/health` |

### Hosting: Hetzner, Node unter systemd, Caddy davor (kein Docker)

Deployment per **GitHub Actions** (`.github/workflows/deploy.yml`) bei jedem Push auf `main`:
Tests (inkl. DB-Tests gegen Postgres 16) → Build auf GitHub (Next.js `output: "standalone"`,
~27 MB) → Upload per SSH als `deploy-meetings` nach `/srv/meetings/releases/<Zeitstempel>` →
`deploy/activate.sh` stellt `/srv/meetings/current` um, `sudo systemctl restart meetings`,
Health-Check (`/api/health`), bei Fehler automatisch zurück aufs vorige Release; 5 Releases
bleiben. Auf dem Server wird nichts gebaut (kein git, kein npm nötig). Pull Requests laufen nur
durch die Tests.

```
/srv/meetings/                deploy-meetings:meetings 2750
  releases/<Zeitstempel>/     server.js, .next/, node_modules/ (nur Laufzeit), deploy/activate.sh, REVISION
  current -> releases/…       aktives Release
/etc/meetings/env             root:meetings 0640 – Umgebungsvariablen (Vorlage: .env.example)
/var/cache/meetings/          Next.js-Cache, einzig beschreibbar (systemd CacheDirectory)
```

| Benutzer | Zweck |
|---|---|
| `meetings` (Gruppe `meetings`) | führt die App aus (systemd), kein Login |
| `deploy-meetings` | SSH-Login für GitHub Actions; schreibt Releases, darf nur `systemctl restart meetings` |

Dienst (`deploy/systemd/meetings.service`):

```
ExecStart=/usr/bin/node /srv/meetings/current/server.js
Environment=NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=127.0.0.1 PORT=3003
EnvironmentFile=/etc/meetings/env
User=meetings  Group=meetings  ProtectSystem=strict  CacheDirectory=meetings
```

Vorlagen in [`deploy/`](deploy/): `systemd/meetings.service`, `systemd/meetings-cron.{service,timer}`
(jede Minute `/api/cron/outbox`), `Caddyfile`, `sudoers.deploy-meetings`, `activate.sh`.

**GitHub (Settings → Secrets and variables → Actions):**
- Secret `DEPLOY_SSH_KEY`: privater Schlüssel von `deploy-meetings`
- Variable `DEPLOY_KNOWN_HOSTS`: Ausgabe von `ssh-keyscan -t ed25519 2.31.52.105` (Host-Schlüssel
  wird geprüft, nicht blind übernommen)

**Server einrichten (einmalig, als root):**

```bash
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meetings
useradd --create-home --shell /bin/bash deploy-meetings
install -d -o deploy-meetings -g meetings -m 2750 /srv/meetings /srv/meetings/releases   # 2 = setgid: Uploads erben die Gruppe meetings
install -d -o root -g meetings -m 0750 /etc/meetings
bash deploy/setup-env.sh                       # legt /etc/meetings/env an (fragt Werte ab, erzeugt Schlüssel)
# Deploy-Schlüssel: öffentlichen Teil eintragen (privaten als Secret DEPLOY_SSH_KEY in GitHub)
install -d -o deploy-meetings -g deploy-meetings -m 0700 /home/deploy-meetings/.ssh
echo 'restrict ssh-ed25519 AAAA… github-actions-meetings' > /home/deploy-meetings/.ssh/authorized_keys
chown deploy-meetings: /home/deploy-meetings/.ssh/authorized_keys && chmod 0600 /home/deploy-meetings/.ssh/authorized_keys
visudo -f /etc/sudoers.d/deploy-meetings       # Inhalt aus deploy/sudoers.deploy-meetings
cp deploy/systemd/meetings* /etc/systemd/system/ && systemctl daemon-reload
systemctl enable meetings meetings-cron.timer  # Start erfolgt mit dem ersten Deployment
# Caddy: Block aus deploy/Caddyfile übernehmen, dann systemctl reload caddy
```

**Manuell zurückschalten:** `sudo -u deploy-meetings bash /srv/meetings/current/deploy/activate.sh <Zeitstempel>`.
**Migrationen** laufen getrennt (`npm run supabase:migrate`), vor dem Merge nach `main`.

Hinweise:
- Node unter `/usr/bin/node` (Server: Node 24; GitHub baut ebenfalls mit Node 24).
- `ProtectSystem=strict`: Das Release ist zur Laufzeit schreibgeschützt; `.next/cache` ist ein
  Symlink auf `/var/cache/meetings`. Logos liegen in Supabase Storage (`ASSET_STORAGE=supabase`).
- Port 3003 lauscht nur auf `127.0.0.1`; von außen nur über Caddy (Firewall: 80/443).
  Die App wertet `X-Forwarded-Proto`/`X-Forwarded-Host` aus (setzt Caddy standardmäßig),
  um zu erkennen, dass eine Anfrage über `https://meetings.atools.de` kam.
- **Panel im Pipedrive-iframe:** Die App setzt für `/panel`
  `Content-Security-Policy: frame-ancestors 'self' https://*.pipedrive.com`, für alle anderen
  Seiten `X-Frame-Options: SAMEORIGIN`. In Caddy darum **keine** eigenen `X-Frame-Options`-
  oder CSP-Header (auch nicht über gemeinsame Snippets der anderen Panels). Das Panel braucht
  keine Cookies (Sitzung als Bearer-Token) – Drittanbieter-Cookie-Sperren stören nicht.
- `SUPABASE_ACCESS_TOKEN` gehört **nicht** auf den Server; Dev-Werkzeuge sind in Produktion
  (`APP_ENV=production`, setzt die Unit) immer aus.
- Eigene Kundendomains (Phase 5) brauchen später Caddy On-Demand-TLS mit Prüf-Endpunkt der App.

## Buchungsseite & E-Mails (Phase 2)

- Buchungsseite: `/b/<token>` (persönlicher Link aus der Einladung). Lokal mit
  `npm run db:reset` gibt fertige Links aus (Mandant ergibt sich aus dem Token).
- API: `POST /api/bookings` (buchen, genau einmal je Link), `.ics`: `GET /b/<token>/ics`.
- Kein Umbuchen/Stornieren durch Kunden (entschieden: hohe Hemmschwelle zum Nicht-Kommen).
  Nach der Buchung zeigt der Link nur die Bestätigung und den Ansprechpartner
  (einladender Mitarbeiter); Änderungen/Stornierungen macht das Team im Admin.
- Mails laufen immer über `email_outbox`. Direkt nach einer Buchung wird die Outbox des
  Mandanten im Hintergrund abgearbeitet (`after()`), zusätzlich per Cron
  `GET /api/cron/outbox` (Header `Authorization: Bearer $CRON_SECRET`).
  Auf dem Hetzner-Server per Cron/systemd-Timer (siehe „Hosting“).
- Versandwege siehe „Mailversand“. Mit `SYSTEM_MAIL_TRANSPORT=dev` landen Mails nur in der
  DB (Ansicht unter `/dev/mails`, braucht `DEV_TOOLS_ENABLED=true`).
- Links in Mails: `lib/links.ts` – `APP_BASE_URL` bzw. eigene Kundendomain.
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
  `termine.kunde.at` per CNAME) für Buchungsseiten; Links in Mails nutzen sie dann.
  Einrichtung in den Pipedrive-App-Einstellungen (Phase 5, mit DNS-Prüfung und HTTPS).
  Keine Einbettung per iframe.

## Mailversand

Den Weg wählt jede Firma unter **Admin → E-Mail** (`tenants.mail_route`):

| Weg | Einladung | Bestätigung/Stornierung (.ics) | Bei Problemen |
|---|---|---|---|
| System-Adresse (Standard) | System-SMTP (`SYSTEM_MAIL_*`), Anzeigename + Reply-To = Mitarbeiter | System-SMTP, Reply-To = einladender Mitarbeiter | wartet, bis der System-Absender funktioniert |
| Eigenes Postfach | Postfach des einladenden Mitarbeiters („Mein Postfach“: Google, Microsoft oder SMTP) | ebenfalls über sein Postfach | Meldung im Verlauf/Panel, kein anderer Weg; nach der Behebung „Erneut versuchen“ |

- Smart BCC (eine `@pipedrivemail.com`-Adresse je Firma) legt Kundenmails im Deal ab – auf beiden Wegen.
- Kein Versand über Pipedrive: Pipedrive bietet Apps keinen Scope zum Senden
  ([`docs/research/pipedrive-mailversand.md`](docs/research/pipedrive-mailversand.md)).
- Zugriffsanfragen und Freischaltungen gehen immer über die System-Adresse.
- **Mein Postfach** (`/admin/postfach`): eigenes Postfach verbinden (Google/Microsoft nur mit
  eingetragenen Zugangsdaten, SMTP immer), Testmail, Signatur (unter Einladungen).
- **E-Mail-Einstellungen** (`/admin/email`, Owner/Admin): Versandweg, Smart BCC,
  Postfächer im Team, nicht versendete Kundenmails.
- Lokal: `SYSTEM_MAIL_TRANSPORT=dev` – Mails landen unter `/dev/mails`.

## Pipedrive-App (Phase 4)

**Einrichtung im Developer Hub** (eine App für alle Kunden):

| Feld | Wert |
|---|---|
| Callback-URL | `https://meetings.atools.de/api/auth/pipedrive/callback` |
| App-Deinstallation (Webhook) | dieselbe Callback-URL (Pipedrive ruft sie mit `DELETE` und Basic-Auth auf) |
| App settings (eigene Seite) | `https://meetings.atools.de/settings` |
| App-Erweiterung „Custom panel“, Deal-Detailansicht | `https://meetings.atools.de/panel`, JWT-Secret = `PIPEDRIVE_JWT_SECRET` (oder leer = Client-Secret) |
| Scopes | Basis, Deals (voll), Kontakte (lesen), Aktivitäten (voll), Benutzer (lesen), Mail (voll) – einen Scope zum Senden gibt es für Apps nicht |

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
  (Besitzer = einladender Mitarbeiter, Teilnehmer = Kontakt), Änderung durch das Team
  ändert dieselbe Aktivität, Stornierung löscht sie und legt eine Notiz an.
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
| `SYSTEM_MAIL_TRANSPORT`, `SYSTEM_MAIL_FROM`, `SYSTEM_MAIL_FROM_NAME`, `SYSTEM_SMTP_HOST/PORT/SECURE/USER/PASS` | System-Absender (Bestätigungen; Einladungen bei `smtp`); `dev` nur lokal |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | OAuth-Apps für „Postfach verbinden“ (leer = nur SMTP) |
| `PIPEDRIVE_DIRECTORY` | `api` (Pipedrive, Server) oder `fake` (Seed-Benutzer, nur lokal) – Benutzerliste der Nutzerverwaltung |
