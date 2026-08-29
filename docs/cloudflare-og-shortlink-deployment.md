# Cloudflare OG 短链部署、验证与回滚

本文是人工部署手册，不会自动覆盖现有 Nginx、PM2、数据库或环境变量。执行任何“生产变更”步骤前，应完成备份、变更审批和维护窗口确认。

## 1. 部署前检查

1. 确认 `llegomark-url-shortener/LICENSE` 随产物分发，且 Mark Anthony Llego 的原版权声明未被删除。
2. 运行并留存：

   ```bash
   cd llegomark-url-shortener
   npm install
   npm test
   npm run build
   npm run deploy -- --dry-run

   cd ../backend
   npm test

   cd ../frontend
   npm run build
   ```

3. 检查 `docs/dependency-licenses.md`，确认禁止许可证数量和未知许可证数量均为 0。
4. 备份 demo18 MySQL、`backend/.env`、当前 Nginx 配置、PM2 dump 和当前发布目录。
5. 确认 `vod.zzqixiangkeji.cn` 的 `/card/{cardToken}`、`/play`、`/api/media/share-cards/*` 和 `/health` 均可通过 HTTPS 访问。
6. 选择 Worker 短链域名，例如 `s.hotwharf.com`。不要把 Suolink 所有的 `w1.hotwharf.com` 绑定到 Worker。

## 2. 创建 Worker 与 KV

在 clone 目录登录目标 Cloudflare 账号：

```bash
cd llegomark-url-shortener
npx wrangler login
npx wrangler whoami
```

创建四个 namespace：

```bash
npx wrangler kv namespace create URL_MAPPINGS
npx wrangler kv namespace create URL_ANALYTICS
npx wrangler kv namespace create API_KEYS
npx wrangler kv namespace create OG_METADATA_CACHE
```

把输出的四个真实 ID 人工填入 `wrangler.toml`，替换全部 `00000000000000000000000000000000`。Wrangler 3.60 之后使用 `kv namespace` / `kv key` 新语法；项目锁定的 Wrangler 3.x 安装结果应先用 `npx wrangler --version` 核对。Cloudflare 的 [KV 命令文档](https://developers.cloudflare.com/workers/wrangler/commands/kv/) 和 [KV 入门](https://developers.cloudflare.com/kv/get-started/) 给出了当前命令格式。

生产 namespace 不应被本地开发直接使用；Wrangler 默认本地开发使用本地 KV。若另建 staging，请使用独立 namespace 和环境配置。

## 3. 配置 wrangler.toml

至少复核以下值：

```toml
workers_dev = false

[vars]
ALLOWED_CORS_ORIGINS = "https://vod.zzqixiangkeji.cn"
ALLOWED_TARGET_ORIGINS = "https://vod.zzqixiangkeji.cn"
DEFAULT_OG_TITLE = "视频播放"
DEFAULT_OG_DESCRIPTION = "点击查看视频素材"
# 与 demo18 的 PUBLIC_CARD_COVER_BASE_URL 保持一致，必须能匿名返回真实 PNG。
DEFAULT_OG_IMAGE = "https://img.vod.zzqixiangkeji.cn/wechat-share-default.png"
DEMO18_SYNC_URL = "https://vod.zzqixiangkeji.cn"

[[routes]]
pattern = "s.hotwharf.com"
custom_domain = true
```

- `ALLOWED_TARGET_ORIGINS` 应只列出实际承载 demo18 `/card` 的 HTTPS Origin，多个值以英文逗号分隔。
- `DEFAULT_OG_IMAGE` 必须是可匿名抓取的 HTTPS 公网绝对地址。
- Worker 自定义域名会让该主机的所有路径进入 Worker。Cloudflare 会为 Custom Domain 创建 DNS 记录和证书，详见 [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
- 不要在 TOML 中写 API Key、数据库密码或其他 secret。

## 4. 配置两套服务密钥

生成两个不同的 32 字节以上 Base64URL 随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

第一套是 demo18 调用 Worker 管理 API 的 Key。优先通过 Cloudflare Dashboard 的 Workers KV 页面，在 `API_KEYS` namespace 新增：

```text
key   = <CLOUDFLARE_SHORTLINK_API_KEY>
value = true
```

也可在确认当前配置指向生产 namespace 后执行：

```bash
npx wrangler kv key put --binding=API_KEYS "<CLOUDFLARE_SHORTLINK_API_KEY>" "true" --remote
```

第二套是 Worker 回写 demo18 的 Key。在 demo18 `backend/.env` 写入 `WORKER_SYNC_API_KEY`，同时把完全相同的值配置为 Worker secret：

```bash
npx wrangler secret put DEMO18_SYNC_API_KEY
```

命令会交互读取值。Cloudflare 文档说明 secret 应使用 Secrets 而不是明文变量；`wrangler secret put` 会创建并部署 Worker 版本，因此这条命令属于生产变更，必须在审批后执行。参见 [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

密钥轮换顺序：先把新 Worker 管理 Key 加入 KV并更新 demo18，再删除旧 KV key；点击回写 Key 应在维护窗口同时更新两端，并立即验证 `/api/internal`。任何 Key 都不得出现在浏览器、前端构建、URL、截图或日志中。

## 5. demo18 后端配置

人工合并到 `backend/.env`，不要覆盖原文件：

```dotenv
PUBLIC_CARD_BASE_URL=https://vod.zzqixiangkeji.cn
# 国内企微抓取使用已备案 COS/CDN 封面域名；对象路径需与 /card-covers/* 对齐。
PUBLIC_CARD_COVER_BASE_URL=https://img.vod.zzqixiangkeji.cn
PUBLIC_PLAY_BASE_URL=https://vod.zzqixiangkeji.cn

CLOUDFLARE_SHORTLINK_ENABLED=true
CLOUDFLARE_SHORTLINK_BASE_URL=https://s.hotwharf.com
CLOUDFLARE_SHORTLINK_API_URL=https://s.hotwharf.com
CLOUDFLARE_SHORTLINK_API_KEY=<第一套随机密钥>
CLOUDFLARE_SHORTLINK_TIMEOUT_MS=5000
CLOUDFLARE_SHORTLINK_MAX_RETRIES=2
WORKER_SYNC_API_KEY=<第二套随机密钥>
```

Worker 不配置 `DB_HOST`、`DB_USER`、`DB_PASSWORD` 或 `DB_NAME`。

迁移前先做 MySQL 备份，再由运维人工执行：

```bash
cd /var/www/demo18/backend
npm run migrate
```

该步骤增加可空的 `play_logs.external_event_id` 与唯一索引；不改变已有点击记录。随后在 demo18 超级管理员“域名池”中把 `https://s.hotwharf.com` 添加为 `self` 域名。至少保留一个不经过 Worker 的自建域名，作为自动降级候选。

## 6. Nginx 与 HTTPS

现有 `nginx/demo18.conf.template` 已包含必须的精确路由：

```nginx
location = /play { proxy_pass http://127.0.0.1:3000/play; }
location ~ "^/card/[A-Za-z0-9_-]{20,128}$" {
    proxy_pass http://127.0.0.1:3000;
}
location /api/ { proxy_pass http://127.0.0.1:3000; }
location ~ "^/([A-Za-z0-9]{6,8})$" {
    rewrite "^/([A-Za-z0-9]{6,8})$" /api/short/$1 break;
    proxy_pass http://127.0.0.1:3000;
}
```

不要直接复制覆盖线上配置。先人工 diff，再把实际端口、路径和代理头合并到现有 HTTPS `server`。`vod.zzqixiangkeji.cn` 证书必须有效；为 Worker 灾备准备时，源站证书还应包含 `s.hotwharf.com`，源站 Nginx 的 `server_name` 也应预先接受该域名，但正常状态下 `s.hotwharf.com` 仍由 Worker Custom Domain 接管。

应用配置前：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

不要在验证失败时 reload。Cloudflare 到 `vod.zzqixiangkeji.cn` 建议使用 Full (strict) TLS，源站证书保持有效。

## 7. PM2 重启

在已更新代码、环境变量和迁移均人工确认后：

```bash
cd /var/www/demo18/backend
pm2 describe demo18-backend
pm2 restart demo18-backend --update-env
pm2 save
pm2 logs demo18-backend --lines 100
```

如果线上进程名不同，以 `pm2 list` 的现有名称为准，不要创建第二个后端实例。

## 8. CORS

- Worker API 的正常调用方是 demo18 后端，不依赖浏览器 CORS。
- `ALLOWED_CORS_ORIGINS` 只列明实际管理端 HTTPS Origin；不使用 `*`，也不允许携带任意 Origin。
- Bearer API Key 认证和 API 限流继续生效；CORS 不是认证机制。
- demo18 原有 `CORS_ALLOWED_ORIGINS` 继续按实际前端域名配置，不因 Worker 接入而放宽。

## 9. 正式部署停止点

以下命令会把 Worker 发布到生产流量，本次代码适配没有执行它：

```bash
npm run deploy
```

到此必须停止，取得正式上线授权后才可运行。Cloudflare 说明 `wrangler deploy` 默认创建版本并立即把 100% 流量切到该版本，参见 [Versions & Deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)。建议先在独立 staging Worker 做全量测试，再用版本/渐进式部署流程推广。

## 10. 上线后健康检查

```bash
curl --fail https://vod.zzqixiangkeji.cn/health
curl --fail https://s.hotwharf.com/health
curl -sS -D - -o /tmp/wechat-og.html \
  -A 'Mozilla/5.0 MicroMessenger' \
  https://s.hotwharf.com/<testShortCode>
grep -E 'og:title|og:description|og:image|window.location.replace|继续打开' /tmp/wechat-og.html
```

预期短链响应为 200 和 `text/html`，而不是 302。分别用 `MicroMessenger`、`WeChat`、`Mozilla/5.0`、`facebookexternalhit`、`Twitterbot` 重复请求并比较 OG 标签。

Suolink 验证：

```bash
curl -sS -D - -o /tmp/suolink-body.html --max-redirs 0 https://w1.hotwharf.com/<code>
```

预期为 302，`Location` 精确等于本次 `https://vod.zzqixiangkeji.cn/card/{cardToken}`，响应体不能包含“404-页面不存在”。应用内创建流程会执行同样的严格检查。

检查日志时只搜索事件名和错误码，不输出请求 Authorization 头：

```bash
npx wrangler tail
pm2 logs demo18-backend --lines 200
```

Cloudflare 当前的实时日志命令见 [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)。

## 11. 缓存清理

正常卡片更新无需手工清理：demo18 调用 Worker `PUT /api/urls/:shortCode`，Worker 递增 `cacheVersion` 并删除旧 Cache API key。停用/删除调用 `DELETE`，同时删除映射、计数和 HTML 缓存。

应急清理单条映射可在授权后调用管理 API DELETE，再由 demo18 重新启用或重新保存卡片触发 upsert。全站 CDN purge 仅在 Cache API 行为异常且影响面确认后，通过 Cloudflare Dashboard 执行；它不能替代 MySQL 状态修改。

## 12. 回滚与关闭 Cloudflare 的降级方案

### Worker 代码回滚

1. 在 Cloudflare Dashboard 的 Worker Deployments 选择已验证的上一版本，或运行 `npx wrangler rollback [VERSION_ID]`。
2. 回滚后复测 `/health`、测试短链、更新卡片和点击回写。
3. Worker 版本回滚不会回滚 KV 数据；Cloudflare 也提示绑定资源被删除或变更后可能无法回滚。详见 [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

### demo18 回滚

1. 在后台先停用 Worker 域名，保留普通自建域名接收新短链。
2. 恢复上一个已验证的后端/前端发布目录和原 `.env`，再执行 `pm2 restart demo18-backend --update-env`。
3. 新增数据库列是可空兼容列，可留存，不需要冒险做在线逆向 DDL。
4. `nginx -t` 后再 reload，并复测上传、播放、统计、权限及旧短链。

### 完全关闭 Cloudflare Worker

1. 先在 demo18 域名池停用 `s.hotwharf.com`，新链会使用其他自建域名；Suolink 失败时也可降级到普通自建域名。
2. 已有 Worker 链接的同一 `short_code` 已保存在 MySQL。把 `s.hotwharf.com` 从 Worker Custom Domain 移除，并将其 DNS 切到预先配置好证书和 `server_name` 的 demo18 Nginx 源站后，Nginx 的 `/:code` 规则可继续返回 demo18 自建 OG HTML。
3. 如果暂时不能切 DNS，已有 `s.hotwharf.com` 链接会不可访问；因此源站灾备域名和证书必须在下线前准备完成。
4. Worker 停止不影响 `vod.zzqixiangkeji.cn/card/*`、`/play`、视频上传、播放事件上报或 MySQL 统计。
