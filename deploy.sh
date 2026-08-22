#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

APP_DIR="${APP_DIR:-/var/www/demo18}"
APP_NAME="${APP_NAME:-demo18-backend}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/demo18}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-}"
SERVER_NAME="${SERVER_NAME:-_}"
BACKEND_PORT="${BACKEND_PORT:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SOURCE_DIR:-$SCRIPT_DIR}"
PROVIDED_ENV_FILE="${ENV_FILE:-}"

die() {
  echo "部署失败：$*" >&2
  exit 1
}

log() {
  echo "[demo18] $*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

if [[ "${EUID}" -ne 0 ]]; then
  die "请使用 root 执行，或运行 sudo -E bash deploy.sh"
fi

[[ "$APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "APP_DIR 只能是安全的绝对路径"
[[ "$BACKUP_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "BACKUP_ROOT 只能是安全的绝对路径"
[[ "$SERVER_NAME" =~ ^[A-Za-z0-9._*-]+$ ]] || die "SERVER_NAME 格式不正确"
command_exists node || die "未安装 Node.js"
command_exists npm || die "未安装 npm"
command_exists nginx || die "未安装 Nginx"
command_exists curl || die "未安装 curl"

create_backup() {
  local backup_file timestamp

  if [[ ! -d "$APP_DIR" ]] || [[ -z "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    log "应用目录尚不存在或为空，跳过旧版本备份"
    return
  fi

  command_exists tar || die "部署前备份需要安装 tar"
  mkdir -p "$BACKUP_ROOT"
  chmod 700 "$BACKUP_ROOT"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="$BACKUP_ROOT/demo18-$timestamp.tar.gz"

  log "备份现有应用（包含 backend/.env，排除 node_modules）"
  tar \
    --exclude='./backend/node_modules' \
    --exclude='./frontend/node_modules' \
    -C "$APP_DIR" \
    -czf "$backup_file" \
    .
  chmod 600 "$backup_file"
  log "备份完成：$backup_file"
}

deploy_code() {
  mkdir -p "$APP_DIR"

  if [[ -n "$REPO_URL" ]]; then
    command_exists git || die "使用 REPO_URL 时必须安装 git"

    if [[ -d "$APP_DIR/.git" ]]; then
      log "从 Git 更新代码"
      git -C "$APP_DIR" fetch --prune origin "$BRANCH"
      git -C "$APP_DIR" checkout "$BRANCH"
      git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
    elif [[ -z "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      log "从 Git 拉取代码"
      git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
    else
      die "$APP_DIR 不是 Git 仓库且目录非空；请设置 SOURCE_DIR 上传代码"
    fi
  else
    local source_real app_real
    source_real="$(readlink -f "$SOURCE_DIR")"
    app_real="$(readlink -f "$APP_DIR")"

    if [[ "$source_real" != "$app_real" ]]; then
      command_exists rsync || die "本地上传模式需要安装 rsync"
      log "从 $source_real 同步代码到 $app_real"
      rsync -a \
        --exclude '.git/' \
        --exclude 'node_modules/' \
        --exclude 'dist/' \
        --exclude 'backend/.env' \
        --exclude 'backend/uploads/' \
        "$source_real/" "$app_real/"
    else
      log "代码已位于 $APP_DIR，跳过同步"
    fi
  fi
}

install_environment() {
  local source_env=""

  if [[ -n "$PROVIDED_ENV_FILE" ]]; then
    [[ -f "$PROVIDED_ENV_FILE" ]] || die "ENV_FILE 不存在：$PROVIDED_ENV_FILE"
    source_env="$PROVIDED_ENV_FILE"
  elif [[ -f "$APP_DIR/backend/.env" ]]; then
    chmod 600 "$APP_DIR/backend/.env"
    return
  elif [[ -f "$SOURCE_DIR/backend/.env" ]]; then
    source_env="$SOURCE_DIR/backend/.env"
  fi

  if [[ -n "$source_env" ]]; then
    install -m 600 "$source_env" "$APP_DIR/backend/.env"
    return
  fi

  install -m 600 "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
  die "已生成 backend/.env，请填写真实配置后重新执行；也可用 ENV_FILE=/path/to/.env"
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$APP_DIR/backend/.env" | tail -n 1 | tr -d '\r'
}

validate_environment() {
  local required_keys=(
    DB_HOST DB_USER DB_NAME
    TENCENT_SECRET_ID TENCENT_SECRET_KEY TENCENT_APP_ID
  )
  local key value play_key

  for key in "${required_keys[@]}"; do
    value="$(env_value "$key")"
    if [[ -z "$value" || "$value" == your_* || "$value" == replace_with_* ]]; then
      die "backend/.env 中的 $key 尚未配置"
    fi
  done

  if [[ -z "$(env_value SUOLINK_API_KEY)" || -z "$(env_value SUOLINK_DOMAIN)" ]]; then
    log "未配置第三方缩链，将使用 PUBLIC_SHORTLINK_BASE_URL 自建短链"
    value="$(env_value PUBLIC_SHORTLINK_BASE_URL)"
    [[ -n "$value" ]] || die "未配置第三方缩链时必须填写 PUBLIC_SHORTLINK_BASE_URL"
  fi

  play_key="$(env_value PLAYER_SIGN_KEY)"
  if [[ -z "$play_key" ]]; then
    play_key="$(env_value TENCENT_VOD_PLAY_KEY)"
  fi
  if [[ -n "$play_key" && ! "$play_key" =~ ^[A-Za-z0-9]{8,20}$ ]]; then
    log "PLAYER_SIGN_KEY/TENCENT_VOD_PLAY_KEY 不是 8-20 位播放密钥，将忽略并由后端安全查询默认分发配置"
  fi

  if [[ -z "$BACKEND_PORT" ]]; then
    BACKEND_PORT="$(env_value PORT)"
    BACKEND_PORT="${BACKEND_PORT:-3000}"
  fi
  [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || die "BACKEND_PORT/PORT 必须是端口号"
}

backup_database() {
  local timestamp backup_file db_host db_port db_user db_name db_password

  command_exists mysqldump || die "数据库迁移前备份需要安装 mysqldump"
  db_host="$(env_value DB_HOST)"
  db_port="$(env_value DB_PORT)"
  db_port="${db_port:-3306}"
  db_user="$(env_value DB_USER)"
  db_name="$(env_value DB_NAME)"
  db_password="$(env_value DB_PASSWORD)"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_ROOT"
  chmod 700 "$BACKUP_ROOT"
  backup_file="$BACKUP_ROOT/${db_name}-$timestamp.sql"

  log "在迁移前备份 MySQL 数据库"
  if ! MYSQL_PWD="$db_password" mysqldump \
    --host="$db_host" \
    --port="$db_port" \
    --user="$db_user" \
    --single-transaction \
    --quick \
    --routines \
    --triggers \
    "$db_name" > "$backup_file"; then
    rm -f -- "$backup_file"
    die "MySQL 备份失败，已中止迁移"
  fi
  chmod 600 "$backup_file"
  log "MySQL 备份完成：$backup_file"
}

install_dependencies_and_build() {
  log "安装后端依赖"
  (
    cd "$APP_DIR/backend"
    if [[ -f package-lock.json ]]; then
      npm ci --omit=dev
    else
      npm install --omit=dev
    fi
  )

  log "安装前端依赖并构建"
  printf 'VITE_API_BASE_URL=/api\nVITE_TENCENT_APP_ID=%s\n' \
    "$(env_value TENCENT_APP_ID)" > "$APP_DIR/frontend/.env.production"
  (
    cd "$APP_DIR/frontend"
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
    npm run build
  )

  # Nginx 以 www-data 运行；构建进程的 umask 可能让 dist 仅 root 可读。
  chown root:www-data "$APP_DIR" "$APP_DIR/frontend"
  chmod 750 "$APP_DIR" "$APP_DIR/frontend"
  chown -R root:www-data "$APP_DIR/frontend/dist"
  find "$APP_DIR/frontend/dist" -type d -exec chmod 750 {} +
  find "$APP_DIR/frontend/dist" -type f -exec chmod 640 {} +
}

run_migrations() {
  log "执行数据库建表与增量迁移"
  (cd "$APP_DIR/backend" && npm run migrate)
}

run_backend_checks() {
  log "执行后端构建检查与自动化测试"
  (cd "$APP_DIR/backend" && npm run build && npm test)
}

start_backend() {
  install -d -m 750 "$APP_DIR/backend/uploads/share-cards"
  if ! command_exists pm2; then
    log "安装 PM2"
    npm install --global pm2
  fi

  log "启动后端服务"
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
  else
    pm2 start "$APP_DIR/backend/src/server.js" \
      --name "$APP_NAME" \
      --cwd "$APP_DIR/backend" \
      --time
  fi
  pm2 save

  if command_exists systemctl; then
    pm2 startup systemd -u root --hp /root >/dev/null
  fi

  local health_url="http://127.0.0.1:${BACKEND_PORT}/health"
  for _ in {1..15}; do
    if curl --fail --silent --show-error "$health_url" >/dev/null; then
      return
    fi
    sleep 1
  done
  die "后端健康检查失败：$health_url"
}

configure_nginx() {
  local source_config rendered_config target_config
  source_config="${NGINX_CONFIG_SOURCE:-$APP_DIR/nginx/demo18.conf.template}"
  [[ -f "$source_config" ]] || die "找不到 Nginx 配置：$source_config"
  rendered_config="$(mktemp)"

  sed \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__SERVER_NAME__|$SERVER_NAME|g" \
    -e "s|__BACKEND_PORT__|$BACKEND_PORT|g" \
    "$source_config" > "$rendered_config"

  if [[ -d /etc/nginx/sites-available ]]; then
    target_config="/etc/nginx/sites-available/demo18.conf"
    install -m 644 "$rendered_config" "$target_config"
    ln -sfn "$target_config" /etc/nginx/sites-enabled/demo18.conf

    if [[ "$SERVER_NAME" == "_" && -L /etc/nginx/sites-enabled/default ]]; then
      rm -f /etc/nginx/sites-enabled/default
    fi
  else
    target_config="/etc/nginx/conf.d/demo18.conf"
    install -m 644 "$rendered_config" "$target_config"
  fi

  rm -f "$rendered_config"
  nginx -t

  if command_exists systemctl; then
    systemctl restart nginx
  else
    nginx -s reload
  fi
}

secure_static_permissions() {
  # Nginx 仅需读取生产构建产物；后端环境文件仍保持私密。
  chown root:www-data "$APP_DIR" "$APP_DIR/frontend"
  chmod 750 "$APP_DIR" "$APP_DIR/frontend"
  chown -R root:www-data "$APP_DIR/frontend/dist"
  find "$APP_DIR/frontend/dist" -type d -exec chmod 750 {} +
  find "$APP_DIR/frontend/dist" -type f -exec chmod 640 {} +
  chmod 600 "$APP_DIR/backend/.env"
}

create_backup
deploy_code
install_environment
validate_environment
backup_database
install_dependencies_and_build
run_migrations
run_backend_checks
start_backend
secure_static_permissions
configure_nginx

log "部署完成：前端 http://${SERVER_NAME}/admin，后端健康检查已通过"
