#!/usr/bin/env bash
# Neues Release aus GitHub (Branch main) bauen und ausrollen – ohne Docker.
# Ausführen als Benutzer "meetings":
#   sudo -u meetings /srv/meetings/current/deploy/deploy.sh            # Branch main
#   sudo -u meetings /srv/meetings/current/deploy/deploy.sh <branch>   # anderer Branch
# Erstes Mal (noch kein current): Skript aus dem Repo direkt aufrufen, siehe README.
#
# Ablauf: Repo-Spiegel aktualisieren -> Release-Verzeichnis aus dem Commit -> npm ci ->
# next build -> Cache-Symlink -> current umschalten -> Dienst neu starten -> Health-Check
# (bei Fehler automatisch zurück auf das vorige Release) -> alte Releases aufräumen.
set -euo pipefail

BRANCH="${1:-main}"
ROOT=/srv/meetings
ENV_FILE=/etc/meetings/env
REPO_URL="${REPO_URL:-git@github.com:Amazing-Tools-GmbH/terminbuchungstool.git}"
KEEP=5
HEALTH_URL=http://127.0.0.1:3003/api/health

log() { printf '\n==> %s\n' "$*"; }
umask 0027

[ "$(id -un)" = "meetings" ] || { echo "Bitte als Benutzer meetings ausführen (sudo -u meetings …)" >&2; exit 1; }
[ -r "$ENV_FILE" ] || { echo "$ENV_FILE fehlt oder ist nicht lesbar" >&2; exit 1; }

log "Repository ($BRANCH) holen"
if [ ! -d "$ROOT/repo.git" ]; then
  git clone --mirror "$REPO_URL" "$ROOT/repo.git"
fi
git --git-dir="$ROOT/repo.git" fetch --prune origin
SHA=$(git --git-dir="$ROOT/repo.git" rev-parse --verify "refs/heads/$BRANCH^{commit}")
REL="$ROOT/releases/$(date +%Y%m%d%H%M%S)-${SHA:0:8}"
mkdir -p "$REL"
git --git-dir="$ROOT/repo.git" archive "$SHA" | tar -x -C "$REL"
echo "$SHA" > "$REL/REVISION"

log "Abhängigkeiten installieren"
cd "$REL"
npm ci --no-audit --no-fund

log "Bauen"
# dieselbe Konfiguration wie im Betrieb (APP_BASE_URL wird beim Build geprüft)
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1 npm run build

# Laufzeit-Cache von Next.js liegt außerhalb des (schreibgeschützten) Releases
rm -rf .next/cache
ln -s /var/cache/meetings .next/cache
chmod -R go-w "$REL"

PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
log "Umschalten: $REL"
ln -sfn "$REL" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

# RESTART_CMD nur für Tests ohne systemd überschreiben
restart() { ${RESTART_CMD:-sudo -n /usr/bin/systemctl restart meetings}; }
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 3 -o /dev/null "$HEALTH_URL" && return 0
    sleep 2
  done
  return 1
}

log "Dienst neu starten"
restart
if healthy; then
  log "OK – läuft mit ${SHA:0:8}"
else
  echo "Health-Check fehlgeschlagen ($HEALTH_URL)" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    log "Zurück auf $PREV"
    ln -sfn "$PREV" "$ROOT/current.new"
    mv -Tf "$ROOT/current.new" "$ROOT/current"
    restart
  fi
  exit 1
fi

log "Alte Releases aufräumen (behalte $KEEP)"
CUR=$(readlink -f "$ROOT/current")
ls -1dt "$ROOT"/releases/*/ | sed 's#/$##' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$CUR" ] || rm -rf "$old"
done
