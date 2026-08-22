#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR='/var/www/demo18'
DIST_DIR="$APP_DIR/frontend/dist"

[[ "${EUID}" -eq 0 ]] || { echo 'FIX_ERROR: root required' >&2; exit 1; }
[[ -f "$DIST_DIR/index.html" ]] || { echo 'FIX_ERROR: frontend dist is missing' >&2; exit 1; }

chown root:www-data "$APP_DIR" "$APP_DIR/frontend"
chmod 750 "$APP_DIR" "$APP_DIR/frontend"
chown -R root:www-data "$DIST_DIR"
find "$DIST_DIR" -type d -exec chmod 750 {} +
find "$DIST_DIR" -type f -exec chmod 640 {} +
chmod 600 "$APP_DIR/backend/.env"

ROOT_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Host: 49.232.124.39' http://127.0.0.1/)"
ADMIN_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Host: 49.232.124.39' http://127.0.0.1/admin)"
HEALTH_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Host: 49.232.124.39' http://127.0.0.1/health)"
CONFIG_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Host: 49.232.124.39' http://127.0.0.1/api/domain/wechat-config)"

[[ "$ROOT_STATUS" == '200' ]] || { echo "FIX_ERROR: root HTTP $ROOT_STATUS" >&2; exit 1; }
[[ "$ADMIN_STATUS" == '200' ]] || { echo "FIX_ERROR: admin HTTP $ADMIN_STATUS" >&2; exit 1; }
[[ "$HEALTH_STATUS" == '200' ]] || { echo "FIX_ERROR: health HTTP $HEALTH_STATUS" >&2; exit 1; }
[[ "$CONFIG_STATUS" == '401' ]] || { echo "FIX_ERROR: config HTTP $CONFIG_STATUS" >&2; exit 1; }

LATEST_BACKUP="$(find /var/backups/demo18 -maxdepth 1 -type f -name 'demo18-*.tar.gz' -printf '%f\n' | sort -r | head -n 1)"
rm -f -- /tmp/fix-static-permissions.sh

echo "LATEST_BACKUP=$LATEST_BACKUP"
echo "ROOT_STATUS=$ROOT_STATUS"
echo "ADMIN_STATUS=$ADMIN_STATUS"
echo "HEALTH_STATUS=$HEALTH_STATUS"
echo "CONFIG_UNAUTHENTICATED_STATUS=$CONFIG_STATUS"
echo 'STATIC_FIX_SUCCESS=true'
