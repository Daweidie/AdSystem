#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

APP_DIR='/var/www/demo18'
APP_NAME='demo18-backend'
APP_USER='ubuntu'
ARCHIVE='/tmp/demo18-release-20260818-cover4.tar.gz'
EXPECTED_SHA256='4F86FC9C978BF049E0323F7DEA32F5F44F3709828B7A854B2D0A75044AD73E50'
BACKUP_ROOT='/var/backups/demo18'
STAGE_DIR="/tmp/demo18-stage-$$"
PRESERVED_ENV="/tmp/demo18-preserved-env-$$"

fail() {
  echo "DEPLOY_ERROR: $*" >&2
  exit 1
}

cleanup_stage() {
  case "$STAGE_DIR" in
    /tmp/demo18-stage-*) rm -rf -- "$STAGE_DIR" ;;
  esac
  rm -f -- "$PRESERVED_ENV"
}

cleanup_temporary_authorization() {
  local auth_file='/home/ubuntu/.ssh/authorized_keys'
  local auth_tmp='/home/ubuntu/.ssh/authorized_keys.demo18-cleanup'

  if [[ -f "$auth_file" ]]; then
    grep -v 'demo18-temporary-deploy-20260814' "$auth_file" > "$auth_tmp" || true
    mv "$auth_tmp" "$auth_file"
    chown ubuntu:ubuntu "$auth_file"
    chmod 600 "$auth_file"
  fi
}

trap 'cleanup_stage; cleanup_temporary_authorization' EXIT

[[ "${EUID}" -eq 0 ]] || fail 'run this deployment with sudo/root'
for command_name in tar rsync sha256sum node npm curl sudo; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done
[[ -d "$APP_DIR" ]] || fail "application directory is missing: $APP_DIR"
[[ -f "$APP_DIR/backend/.env" ]] || fail 'existing backend/.env is missing; refusing to deploy'
[[ -f "$ARCHIVE" ]] || fail "release archive is missing: $ARCHIVE"

ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print toupper($1)}')"
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || fail 'release archive checksum mismatch'

PM2_OWNER=''
PM2_BIN="$(sudo -u "$APP_USER" -H bash -lc 'command -v pm2' 2>/dev/null || true)"
if [[ -n "$PM2_BIN" ]] \
  && sudo -u "$APP_USER" -H "$PM2_BIN" describe "$APP_NAME" >/dev/null 2>&1; then
  PM2_OWNER="$APP_USER"
else
  PM2_BIN="$(command -v pm2 2>/dev/null || true)"
  if [[ -n "$PM2_BIN" ]] && "$PM2_BIN" describe "$APP_NAME" >/dev/null 2>&1; then
    PM2_OWNER='root'
  fi
fi
[[ -n "$PM2_OWNER" ]] || fail "PM2 service is not available: $APP_NAME"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_ROOT/demo18-$TIMESTAMP.tar.gz"

echo 'DEPLOY_STEP: backup current application'
tar \
  --exclude='./backend/node_modules' \
  --exclude='./frontend/node_modules' \
  -C "$APP_DIR" \
  -czf "$BACKUP_FILE" \
  .
chmod 600 "$BACKUP_FILE"

cp -p "$APP_DIR/backend/.env" "$PRESERVED_ENV"
chmod 600 "$PRESERVED_ENV"
ENV_SHA256_BEFORE="$(sha256sum "$PRESERVED_ENV" | awk '{print $1}')"

mkdir -p "$STAGE_DIR"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR"
[[ -f "$STAGE_DIR/backend/package.json" ]] || fail 'backend source is missing from release'
[[ -f "$STAGE_DIR/frontend/package.json" ]] || fail 'frontend source is missing from release'

echo 'DEPLOY_STEP: synchronize release while preserving backend/.env'
rsync -a --delete \
  --exclude 'backend/.env' \
  --exclude 'backend/node_modules/' \
  --exclude 'backend/uploads/' \
  --exclude 'frontend/node_modules/' \
  "$STAGE_DIR/" "$APP_DIR/"

[[ -f "$APP_DIR/backend/.env" ]] || cp -p "$PRESERVED_ENV" "$APP_DIR/backend/.env"
ENV_SHA256_AFTER="$(sha256sum "$APP_DIR/backend/.env" | awk '{print $1}')"
if [[ "$ENV_SHA256_AFTER" != "$ENV_SHA256_BEFORE" ]]; then
  cp -p "$PRESERVED_ENV" "$APP_DIR/backend/.env"
  fail 'backend/.env changed during synchronization and was restored'
fi
chmod 600 "$APP_DIR/backend/.env"
install -d -m 750 -o "$PM2_OWNER" -g "$PM2_OWNER" "$APP_DIR/backend/uploads/share-cards"

echo 'DEPLOY_STEP: install backend dependencies'
if [[ -f "$APP_DIR/backend/package-lock.json" ]]; then
  (cd "$APP_DIR/backend" && npm ci --omit=dev)
else
  (cd "$APP_DIR/backend" && npm install --omit=dev)
fi

echo 'DEPLOY_STEP: run backend build check'
(cd "$APP_DIR/backend" && npm run build)

echo 'DEPLOY_STEP: install frontend dependencies and build'
TENCENT_APP_ID="$(sed -n 's/^TENCENT_APP_ID=//p' "$APP_DIR/backend/.env" | tail -n 1 | tr -d '\r')"
if [[ -f "$APP_DIR/frontend/package-lock.json" ]]; then
  (cd "$APP_DIR/frontend" && npm ci && VITE_API_BASE_URL='/api' VITE_TENCENT_APP_ID="$TENCENT_APP_ID" npm run build)
else
  (cd "$APP_DIR/frontend" && npm install && VITE_API_BASE_URL='/api' VITE_TENCENT_APP_ID="$TENCENT_APP_ID" npm run build)
fi

echo 'DEPLOY_STEP: grant Nginx read access to frontend build'
chown root:www-data "$APP_DIR" "$APP_DIR/frontend"
chmod 750 "$APP_DIR" "$APP_DIR/frontend"
chown -R root:www-data "$APP_DIR/frontend/dist"
find "$APP_DIR/frontend/dist" -type d -exec chmod 750 {} +
find "$APP_DIR/frontend/dist" -type f -exec chmod 640 {} +

echo 'DEPLOY_STEP: run idempotent database migrations'
(cd "$APP_DIR/backend" && npm run migrate)

if [[ "${RUN_PRODUCTION_TESTS:-0}" == '1' ]]; then
  echo 'DEPLOY_STEP: run backend automated tests'
  (cd "$APP_DIR/backend" && npm test)
else
  echo 'DEPLOY_STEP: skip production database tests (set RUN_PRODUCTION_TESTS=1 only with an isolated test database)'
fi

echo 'DEPLOY_STEP: restart PM2 service'
if [[ "$PM2_OWNER" == 'root' ]]; then
  "$PM2_BIN" restart "$APP_NAME" --update-env
  "$PM2_BIN" save
else
  sudo -u "$APP_USER" -H "$PM2_BIN" restart "$APP_NAME" --update-env
  sudo -u "$APP_USER" -H "$PM2_BIN" save
fi

BACKEND_PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/backend/.env" | tail -n 1 | tr -d '\r')"
[[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || BACKEND_PORT='3001'

echo 'DEPLOY_STEP: ensure Nginx /s/ card route'
NGINX_CONFIG='/etc/nginx/sites-enabled/demo18.conf'
if [[ -f "$NGINX_CONFIG" ]] && ! grep -q 'location ~ "^/s/\[A-Za-z0-9\]{6,8}\$"' "$NGINX_CONFIG"; then
  cp -p "$NGINX_CONFIG" "$NGINX_CONFIG.bak-self-short-$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$NGINX_CONFIG" "$BACKEND_PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
port = sys.argv[2]
text = path.read_text()
marker = '    location /api/ {'
block = f'''    # 自建短码直接返回 Express 卡片 HTML，禁止被 Vue SPA 接管。\n    location ~ "^/s/[A-Za-z0-9]{{6,8}}$" {{\n        proxy_pass http://127.0.0.1:{port};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_connect_timeout 10s;\n        proxy_read_timeout 60s;\n        proxy_intercept_errors off;\n    }}\n\n'''
if marker not in text:
    raise SystemExit('Nginx /api/ marker not found')
path.write_text(text.replace(marker, block + marker, 1))
PY
  nginx -t
  systemctl reload nginx
fi

nginx -t
nginx -T 2>&1 | grep -F 'location ~ "^/s/[A-Za-z0-9]{6,8}$"' >/dev/null \
  || fail 'Nginx does not contain the required /s short-code proxy route'
nginx -T 2>&1 | grep -F 'location ~ "^/card/[A-Za-z0-9_-]{20,128}$"' >/dev/null \
  || fail 'Nginx does not contain the required /card proxy route'
nginx -T 2>&1 | grep -F 'location = /play' >/dev/null \
  || fail 'Nginx does not contain the required /play proxy route'

echo 'DEPLOY_STEP: verify backend and nginx routes'
HEALTH_OK='false'
for _ in {1..20}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${BACKEND_PORT}/health" | grep -q '"success":true'; then
    HEALTH_OK='true'
    break
  fi
  sleep 1
done
[[ "$HEALTH_OK" == 'true' ]] || fail 'backend health check failed'

CONFIG_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1/api/domain/wechat-config)"
[[ "$CONFIG_STATUS" == '401' ]] || fail "unauthenticated config route returned HTTP $CONFIG_STATUS"

echo 'DEPLOY_STEP: create a fresh /s smoke-test card'
NEW_CARD_JSON="$(
  cd "$APP_DIR/backend"
  ALLOW_PRODUCTION_SMOKE_LINK=1 \
    SMOKE_PUBLIC_ORIGIN='https://vod.zzqixiangkeji.cn' \
    node scripts/create-self-card-smoke.js
)"
NEW_CARD_URL="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.shortUrl)' "$NEW_CARD_JSON")"
[[ "$NEW_CARD_URL" =~ ^https://vod\.zzqixiangkeji\.cn/s/[A-Za-z0-9]{6,8}$ ]] \
  || fail "fresh smoke-test card URL is invalid: $NEW_CARD_URL"

verify_card() {
  local user_agent="$1" label="$2" page_url="${3:-$NEW_CARD_URL}"
  local headers body status play_target digest
  headers="$(mktemp)"
  body="$(mktemp)"
  curl --silent --show-error --max-redirs 0 \
    --user-agent "$user_agent" \
    --dump-header "$headers" \
    --output "$body" \
    "$page_url"
  status="$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code }' "$headers")"
  [[ "$status" == '200' ]] || fail "$label card request returned HTTP $status"
  # curl 保存的响应头使用 CRLF；不要用带 $ 的正则误判结尾的 \r。
  grep -Eiq '^Content-Type: text/html; *charset=utf-8' "$headers" \
    || fail "$label card response has the wrong Content-Type"
  for marker in \
    '<title>' \
    'name="description"' \
    'property="og:title"' \
    'property="og:description"' \
    'property="og:image"' \
    'property="og:image:secure_url"' \
    'property="og:image:width"' \
    'property="og:image:height"' \
    'name="twitter:title"' \
    'name="twitter:description"' \
    'name="twitter:image"'; do
    grep -Fq "$marker" "$body" || fail "$label card is missing $marker"
  done
  grep -Fq "rel=\"canonical\" href=\"$page_url\"" "$body" \
    || fail "$label card canonical URL is not the current request URL"
  grep -Fq "property=\"og:url\" content=\"$page_url\"" "$body" \
    || fail "$label card og:url is not the current request URL"
  grep -Fq 'window.location.assign(destination.pathname' "$body" \
    || fail "$label card does not automatically enter the player"
  if grep -Eq '/play|301|302|window\.location\.replace|<div id="app">|继续播放|<button' "$body"; then
    fail "$label card contains a forbidden first-response marker"
  fi
  play_target="$(node -e '
    const fs = require("fs");
    const html = fs.readFileSync(process.argv[1], "utf8");
    const match = html.match(/data-play-token="([A-Za-z0-9_-]+)"/);
    if (!match) process.exit(2);
    process.stdout.write(Buffer.from(match[1], "base64url").toString("utf8"));
  ' "$body")" || fail "$label card has an invalid encoded play target"
  [[ "$play_target" =~ ^/play\?fileId=[^\&]+\&shortLinkId=[1-9][0-9]*$ ]] \
    || fail "$label card encoded target is not the expected relative play path"
  digest="$(sha256sum "$body" | awk '{print $1}')"
  CARD_DIGEST="$digest"
  rm -f -- "$headers" "$body"
}

verify_card 'Mozilla/5.0 MicroMessenger/8.0' 'WeChat'
WECHAT_CARD_SHA256="$CARD_DIGEST"
verify_card 'Mozilla/5.0 Chrome/139.0 Safari/537.36' 'browser'
BROWSER_CARD_SHA256="$CARD_DIGEST"
[[ "$WECHAT_CARD_SHA256" == "$BROWSER_CARD_SHA256" ]] \
  || fail 'WeChat and browser received different /s card HTML'

echo 'DEPLOY_STEP: create and verify a fresh Suolink card'
NEW_SUOLINK_JSON="$(
  cd "$APP_DIR/backend"
  ALLOW_PRODUCTION_SMOKE_LINK=1 \
    SMOKE_PUBLIC_ORIGIN='https://vod.zzqixiangkeji.cn' \
    node scripts/create-suolink-card-smoke.js \
    | grep -F '"shortUrl"' | tail -n 1
)"
NEW_SUOLINK_URL="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.shortUrl)' "$NEW_SUOLINK_JSON")"
NEW_SUOLINK_CARD_URL="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.cardUrl)' "$NEW_SUOLINK_JSON")"
NEW_SUOLINK_CARD_TOKEN="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.cardToken)' "$NEW_SUOLINK_JSON")"
[[ "$NEW_SUOLINK_URL" =~ ^https://w1\.hotwharf\.com/[A-Za-z0-9_-]+/?$ ]] \
  || fail "fresh Suolink URL is invalid: $NEW_SUOLINK_URL"
[[ "$NEW_SUOLINK_CARD_URL" == "https://vod.zzqixiangkeji.cn/card/$NEW_SUOLINK_CARD_TOKEN" ]] \
  || fail 'fresh Suolink card URL is invalid'

SUOLINK_HEADERS="$(mktemp)"
SUOLINK_BODY="$(mktemp)"
curl --silent --show-error --max-redirs 0 \
  --dump-header "$SUOLINK_HEADERS" \
  --output "$SUOLINK_BODY" \
  "$NEW_SUOLINK_URL"
SUOLINK_STATUS="$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code }' "$SUOLINK_HEADERS")"
SUOLINK_LOCATION="$(awk 'BEGIN{IGNORECASE=1} /^Location:/ {sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$SUOLINK_HEADERS")"
[[ "$SUOLINK_STATUS" == '302' ]] || fail "fresh Suolink returned HTTP $SUOLINK_STATUS"
[[ "$SUOLINK_LOCATION" == "$NEW_SUOLINK_CARD_URL" ]] \
  || fail "fresh Suolink redirected to an unexpected location: $SUOLINK_LOCATION"
rm -f -- "$SUOLINK_HEADERS" "$SUOLINK_BODY"

verify_card 'Mozilla/5.0 MicroMessenger/8.0' 'Suolink WeChat' "$NEW_SUOLINK_CARD_URL"
SUOLINK_WECHAT_CARD_SHA256="$CARD_DIGEST"
verify_card 'Mozilla/5.0 Chrome/139.0 Safari/537.36' 'Suolink browser' "$NEW_SUOLINK_CARD_URL"
SUOLINK_BROWSER_CARD_SHA256="$CARD_DIGEST"
[[ "$SUOLINK_WECHAT_CARD_SHA256" == "$SUOLINK_BROWSER_CARD_SHA256" ]] \
  || fail 'WeChat and browser received different /card HTML'

rm -f -- "$ARCHIVE" /tmp/demo18-remote-deploy.sh

echo "DEPLOYMENT_BACKUP=$BACKUP_FILE"
echo 'HEALTH_STATUS=200'
echo "CONFIG_UNAUTHENTICATED_STATUS=$CONFIG_STATUS"
echo "NEW_CARD_URL=$NEW_CARD_URL"
echo "NEW_SUOLINK_URL=$NEW_SUOLINK_URL"
echo "NEW_SUOLINK_CARD_URL=$NEW_SUOLINK_CARD_URL"
echo 'SUOLINK_REDIRECT_STATUS=302'
echo "SUOLINK_REDIRECT_LOCATION=$SUOLINK_LOCATION"
echo 'WECHAT_CARD_STATUS=200'
echo 'BROWSER_CARD_STATUS=200'
echo 'SUOLINK_WECHAT_CARD_STATUS=200'
echo 'SUOLINK_BROWSER_CARD_STATUS=200'
echo 'DEPLOYMENT_SUCCESS=true'
