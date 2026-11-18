#!/usr/bin/env bash
# Startet das vorinstallierte PostgreSQL 16 der Cloud-Umgebung und legt die
# Datenbanken für Entwicklung und Tests an (idempotent).
set -euo pipefail

if ! pg_lsclusters | grep -q "16 *main .*online"; then
  pg_ctlcluster 16 main start
fi

run_psql() { su postgres -c "psql -v ON_ERROR_STOP=1 -qtAc \"$1\""; }

run_psql "alter user postgres password 'postgres'"
for db in terminbuchung_dev terminbuchung_test; do
  if [ "$(run_psql "select 1 from pg_database where datname = '$db'")" != "1" ]; then
    run_psql "create database $db"
    echo "Datenbank $db angelegt"
  fi
done
echo "Postgres läuft (localhost:5432)."
