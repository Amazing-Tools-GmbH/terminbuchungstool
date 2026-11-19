#!/usr/bin/env bash
# Auf dem Server (als deploy-meetings), aufgerufen von GitHub Actions nach dem Hochladen:
#   bash /srv/meetings/releases/<Zeitstempel>/deploy/activate.sh <Zeitstempel>
# Auch für ein manuelles Zurückschalten auf ein älteres Release nutzbar:
#   bash /srv/meetings/current/deploy/activate.sh <älterer Zeitstempel>
#
# current umschalten -> sudo systemctl restart meetings -> Health-Check;
# schlägt er fehl, zurück auf das vorige Release. Danach alte Releases aufräumen.
set -euo pipefail

ROOT=/srv/meetings
KEEP=5
HEALTH_URL=http://127.0.0.1:3003/api/health
NAME="${1:?Release-Name (Zeitstempel) fehlt}"
case "$NAME" in *[!0-9A-Za-z_-]*) echo "Ungültiger Release-Name: $NAME" >&2; exit 2;; esac
REL="$ROOT/releases/$NAME"
[ -f "$REL/server.js" ] || { echo "Kein Release unter $REL (server.js fehlt)" >&2; exit 2; }
# Der Dienst läuft als meetings: alles im Release muss der Gruppe meetings gehören und für sie
# lesbar sein (Setgid auf /srv/meetings/releases sorgt für die Gruppe, umask 027 für die Rechte)
BAD=$(find "$REL" -not -type l \( ! -group meetings -o ! -perm -g=r \) -print -quit)
if [ -n "$BAD" ]; then
  echo "Release nicht für die Gruppe meetings lesbar (z. B. $BAD). Ist /srv/meetings/releases setgid (chmod 2750)?" >&2
  exit 2
fi

switch_to() {
  ln -sfn "$1" "$ROOT/current.new"
  mv -Tf "$ROOT/current.new" "$ROOT/current"
}
restart() { sudo -n /usr/bin/systemctl restart meetings; }
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 3 -o /dev/null "$HEALTH_URL" && return 0
    sleep 2
  done
  return 1
}

PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
echo "==> Umschalten auf $NAME (vorher: ${PREV:-keins})"
switch_to "$REL"
restart
if healthy; then
  echo "==> OK: $(cat "$REL/REVISION" 2>/dev/null || echo "$NAME") läuft"
else
  echo "!! Health-Check fehlgeschlagen ($HEALTH_URL)" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$REL" ]; then
    echo "==> Zurück auf $PREV" >&2
    switch_to "$PREV"
    restart
    healthy && echo "==> Vorheriges Release läuft wieder" >&2 || echo "!! Auch das vorige Release antwortet nicht" >&2
  fi
  exit 1
fi

echo "==> Alte Releases aufräumen (behalte $KEEP)"
CUR=$(readlink -f "$ROOT/current")
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$CUR" ] || rm -rf -- "$old"
done
