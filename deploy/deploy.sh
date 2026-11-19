#!/usr/bin/env bash
# Neue Version ausrollen (auf dem Server als Benutzer "terminbuchung" ausführen):
#   sudo -u terminbuchung /opt/terminbuchung/app/deploy/deploy.sh [branch]
# Danach (mit sudo-Rechten): systemctl restart terminbuchung
set -euo pipefail
BRANCH="${1:-main}"
cd /opt/terminbuchung/app

git fetch --prune origin "$BRANCH"
git checkout -q "$BRANCH"
git reset -q --hard "origin/$BRANCH"

npm ci --no-audit --no-fund

# APP_BASE_URL wirkt beim Build (Unterpfad/Links) -> dieselbe env wie im Betrieb
set -a
. /etc/terminbuchung/env
set +a
NODE_ENV=production npm run build

echo "Build fertig. Jetzt: sudo systemctl restart terminbuchung"
