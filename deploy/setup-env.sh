#!/usr/bin/env bash
# Legt /etc/meetings/env an (als root auf dem Server ausführen):
#   curl -fsSL https://raw.githubusercontent.com/Amazing-Tools-GmbH/terminbuchungstool/main/deploy/setup-env.sh -o /root/setup-env.sh
#   bash /root/setup-env.sh
#
# - feste Werte (Adresse, Supabase-Projekt, Betriebsart) sind vorbelegt
# - ENCRYPTION_KEY und CRON_SECRET werden hier erzeugt (oder ein vorhandener Schlüssel eingegeben)
# - alle anderen Werte werden abgefragt; Geheimnisse mit verdeckter Eingabe, nichts landet im
#   Terminal-Verlauf. Leere Eingabe = später nachtragen (nano /etc/meetings/env)
# - Ergebnis: root:meetings, 0640; eine vorhandene Datei wird vorher gesichert
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/meetings/env}"
ENV_GROUP="${ENV_GROUP:-meetings}"

[ "$(id -u)" -eq 0 ] || [ -n "${ALLOW_NON_ROOT:-}" ] || { echo "Bitte als root ausführen." >&2; exit 1; }
getent group "$ENV_GROUP" >/dev/null || { echo "Gruppe $ENV_GROUP fehlt." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl fehlt (apt install openssl)." >&2; exit 1; }

ask() {     # ask VAR "Frage" [Vorgabe]
  local __v; read -r -p "$2${3:+ [$3]}: " __v || true
  printf -v "$1" '%s' "${__v:-${3:-}}"
}
ask_secret() {  # verdeckt, mit Bestätigung der Länge
  local __v; read -r -s -p "$2 (verdeckt): " __v || true; echo
  [ -n "$__v" ] && echo "   -> ${#__v} Zeichen übernommen" || echo "   -> leer (später nachtragen)"
  printf -v "$1" '%s' "$__v"
}
# Wert für systemd-EnvironmentFile: einfache Werte unverändert, sonst in "…" mit Escapes
q() {
  local v="$1"
  if [[ "$v" =~ ^[A-Za-z0-9._@:/+=,%-]*$ ]]; then printf '%s' "$v"
  else v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; fi
}

if [ -s "$ENV_FILE" ]; then
  BAK="$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
  echo "Vorhandene $ENV_FILE wird gesichert als $BAK"
  cp -p "$ENV_FILE" "$BAK"
fi

echo
echo "== Supabase (Dashboard des Projekts pkegcsgnyicdxzivnijw)"
echo "   Datenbank-URL: Project Settings -> Database -> Connection string -> Transaction pooler (Port 6543)"
ask_secret SUPABASE_DB_URL "SUPABASE_DB_URL (postgresql://…)"
if [ -n "$SUPABASE_DB_URL" ]; then
  [[ "$SUPABASE_DB_URL" =~ ^postgres(ql)?:// ]] || echo "   !! beginnt nicht mit postgresql:// – bitte prüfen"
  [[ "$SUPABASE_DB_URL" == *":6543/"* ]] || echo "   !! nicht Port 6543 (Transaction pooler) – bitte prüfen"
  [[ "$SUPABASE_DB_URL" == *"[YOUR-PASSWORD]"* ]] && echo "   !! enthält noch [YOUR-PASSWORD] – Passwort einsetzen"
fi
echo "   API-Schlüssel: Project Settings -> API Keys"
ask SUPABASE_PUBLISHABLE_KEY "SUPABASE_PUBLISHABLE_KEY (sb_publishable_…)"
ask_secret SUPABASE_SECRET_KEY "SUPABASE_SECRET_KEY (sb_secret_…)"

echo
echo "== Verschlüsselung"
echo "   ENCRYPTION_KEY verschlüsselt Buchungslinks, Tokens und Postfach-Zugänge in der Datenbank."
echo "   Neu erzeugen (Enter) – oder einen vorhandenen Schlüssel eingeben."
ask_secret EXISTING_KEY "Vorhandener ENCRYPTION_KEY (leer = neu erzeugen)"
if [ -n "$EXISTING_KEY" ]; then
  LEN=$(printf '%s' "$EXISTING_KEY" | openssl base64 -d -A 2>/dev/null | wc -c)
  [ "$LEN" -eq 32 ] || { echo "!! Kein gültiger Schlüssel (32 Byte base64), abgebrochen." >&2; exit 1; }
  ENCRYPTION_KEY="$EXISTING_KEY"
else
  ENCRYPTION_KEY=$(openssl rand -base64 32)
  echo "   -> neuer Schlüssel erzeugt. WICHTIG: zusätzlich sicher aufbewahren (Passwort-Manager):"
  echo "      sudo grep ^ENCRYPTION_KEY= $ENV_FILE"
fi
CRON_SECRET=$(openssl rand -hex 32)

echo
echo "== Pipedrive-App (Developer Hub -> App -> OAuth & access scopes)"
ask PIPEDRIVE_CLIENT_ID "PIPEDRIVE_CLIENT_ID"
ask_secret PIPEDRIVE_CLIENT_SECRET "PIPEDRIVE_CLIENT_SECRET"
echo "   JWT-Secret der App-Erweiterungen (Settings/Panel); leer = Client-Secret wird verwendet"
ask_secret PIPEDRIVE_JWT_SECRET "PIPEDRIVE_JWT_SECRET (optional)"

echo
echo "== System-Absender für Buchungsbestätigungen (leer lassen = später; Mails warten dann)"
ask SYSTEM_MAIL_FROM "Absenderadresse (z. B. termine@atools.de)"
ask SYSTEM_MAIL_FROM_NAME "Absendername (leer = Name des Kunden)"
ask SYSTEM_SMTP_HOST "SMTP-Server"
ask SYSTEM_SMTP_PORT "SMTP-Port" "587"
if [ "$SYSTEM_SMTP_PORT" = "465" ]; then DEF_SECURE=true; else DEF_SECURE=false; fi
ask SYSTEM_SMTP_SECURE "TLS ab Verbindungsbeginn? (true bei 465, false bei 587/STARTTLS)" "$DEF_SECURE"
ask SYSTEM_SMTP_USER "SMTP-Benutzer"
ask_secret SYSTEM_SMTP_PASS "SMTP-Passwort"

TMP=$(mktemp "$(dirname "$ENV_FILE")/.env.XXXXXX")
trap 'rm -f "$TMP"' EXIT
chmod 0600 "$TMP"
{
  echo "# Terminbuchungstool – Produktion. Angelegt $(date -Iseconds) mit deploy/setup-env.sh"
  echo "# Vorlage/Erklärungen: .env.example im Repository."
  echo "# NICHT hier setzen (macht die systemd-Unit): NODE_ENV, APP_ENV, HOSTNAME, PORT"
  echo
  echo "APP_BASE_URL=https://meetings.atools.de"
  echo
  echo "# Supabase"
  echo "SUPABASE_URL=https://pkegcsgnyicdxzivnijw.supabase.co"
  echo "SUPABASE_PROJECT_REF=pkegcsgnyicdxzivnijw"
  echo "SUPABASE_DB_URL=$(q "$SUPABASE_DB_URL")"
  echo "SUPABASE_PUBLISHABLE_KEY=$(q "$SUPABASE_PUBLISHABLE_KEY")"
  echo "SUPABASE_SECRET_KEY=$(q "$SUPABASE_SECRET_KEY")"
  echo "ASSET_STORAGE=supabase"
  echo "AUTH_ADMIN=supabase"
  echo
  echo "# Geheimnisse der App"
  echo "ENCRYPTION_KEY=$(q "$ENCRYPTION_KEY")"
  echo "CRON_SECRET=$(q "$CRON_SECRET")"
  echo
  echo "# Pipedrive-App"
  echo "PIPEDRIVE_CLIENT_ID=$(q "$PIPEDRIVE_CLIENT_ID")"
  echo "PIPEDRIVE_CLIENT_SECRET=$(q "$PIPEDRIVE_CLIENT_SECRET")"
  echo "PIPEDRIVE_JWT_SECRET=$(q "$PIPEDRIVE_JWT_SECRET")"
  echo "PIPEDRIVE_DIRECTORY=api"
  echo
  echo "# Mailversand"
  echo "INVITE_MAIL_PROVIDER=pipedrive"
  echo "SYSTEM_MAIL_TRANSPORT=smtp"
  echo "SYSTEM_MAIL_FROM=$(q "$SYSTEM_MAIL_FROM")"
  echo "SYSTEM_MAIL_FROM_NAME=$(q "$SYSTEM_MAIL_FROM_NAME")"
  echo "SYSTEM_SMTP_HOST=$(q "$SYSTEM_SMTP_HOST")"
  echo "SYSTEM_SMTP_PORT=$(q "$SYSTEM_SMTP_PORT")"
  echo "SYSTEM_SMTP_SECURE=$(q "$SYSTEM_SMTP_SECURE")"
  echo "SYSTEM_SMTP_USER=$(q "$SYSTEM_SMTP_USER")"
  echo "SYSTEM_SMTP_PASS=$(q "$SYSTEM_SMTP_PASS")"
  echo
  echo "# in Produktion ohnehin immer aus"
  echo "DEV_TOOLS_ENABLED=false"
  echo "ALLOW_TENANT_QUERY_PARAM=false"
} > "$TMP"
chgrp "$ENV_GROUP" "$TMP"
chmod 0640 "$TMP"
mv -f "$TMP" "$ENV_FILE"
trap - EXIT

echo
echo "== $ENV_FILE angelegt ($(stat -c '%U:%G %a' "$ENV_FILE")). Stand (ohne Werte):"
awk -F= '/^[A-Z]/{ printf "  %-26s %s\n", $1, ($2=="" ? "LEER – später nachtragen" : "gesetzt") }' "$ENV_FILE"
echo
echo "Ändern: nano $ENV_FILE  – danach (sobald die App läuft): systemctl restart meetings"
