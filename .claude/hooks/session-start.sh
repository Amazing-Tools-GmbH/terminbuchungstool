#!/bin/bash
# SessionStart-Hook (nur Claude Code im Web): Abhängigkeiten, lokales
# Postgres 16 (Übergangslösung ohne Supabase), .env.local und Dev-Datenbank.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# --- npm-Abhängigkeiten (nur wenn sich Manifest/Lockfile/Hook geändert haben)
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  npm install --no-audit --no-fund
  sha256sum .claude/hooks/session-start.sh package.json package-lock.json 2>/dev/null > "$hashes" || rm -f "$hashes"
fi

# --- .env.local anlegen, falls sie fehlt (mit frischem ENCRYPTION_KEY)
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  key="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${key}|; s|^CRON_SECRET=.*|CRON_SECRET=dev-cron-secret|" .env.local
  echo ".env.local aus .env.example angelegt" >&2
fi

# --- Postgres 16 starten und Datenbanken anlegen (idempotent, wird für
#     die DB-Tests auch mit Supabase-Projekt gebraucht)
if command -v pg_ctlcluster >/dev/null 2>&1; then
  bash scripts/db-dev-start.sh >&2

  # Dev-Datenbank migrieren + seeden, falls sie noch leer ist (nicht bei Supabase)
  if [ -z "${SUPABASE_DB_URL:-}" ]; then
    has_schema="$(su postgres -c "psql -d terminbuchung_dev -qtAc \"select to_regclass('public.tenants') is not null\"")"
    if [ "$has_schema" != "t" ]; then
      npm run -s db:reset >&2
    fi
  fi
else
  echo "Hinweis: PostgreSQL 16 nicht gefunden – DB-Tests und lokale Dev-DB sind nicht verfügbar." >&2
fi
