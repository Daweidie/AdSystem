# demo18 微信 OG 短链适配实施报告

报告日期：2026-08-16

## 实施结果

已将 `llegomark-url-shortener` 适配为 demo18 的 Cloudflare Workers 短链与 Open Graph 展示层。demo18 MySQL 继续保存用户、业务组、视频、逐短链卡片、权限、点击和播放统计；Worker 只保存映射、OG、临时点击计数与缓存版本，不接触数据库凭据。

本方案不需要微信公众号，不使用微信 JS-SDK，通过服务端 Open Graph 元数据实现微信链接预览。

## 修改文件

### 根项目与文档

- `README.md`

### demo18 backend

- `.env.example`
- `scripts/migrate.js`
- `sql/schema.sql`
- `src/app.js`
- `src/controllers/domainController.js`
- `src/controllers/managementController.js`
- `src/controllers/shortLinkController.js`
- `src/controllers/statisticsController.js`
- `src/controllers/videoController.js`
- `src/routes/domainRoutes.js`
- `src/routes/videoRoutes.js`
- `src/services/cardCoverService.js`
- `src/services/cardPageService.js`
- `src/services/runtimeConfigService.js`
- `src/services/shortLinkService.js`
- `src/services/unifiedShortLinkService.js`
- `src/services/videoExpiryService.js`
- `test/acceptance.test.js`
- `test/suolinkService.test.js`

### demo18 frontend

- `src/views/Admin.vue`
- `src/views/Play.vue`
- `dist/index.html`（构建产物）
- `dist/assets/index-Cyp394n-.css`（构建产物）
- `dist/assets/index-CFTnwbbN.js`（构建产物）

### Worker clone

- `.gitignore`
- `README.md`
- `package.json`
- `src/index.ts`
- `wrangler.toml`

原 `LICENSE` 未修改。

## 删除文件

- `backend/src/services/wechatShareService.js`：已移除的微信公众号 access_token/jsapi_ticket/JS-SDK 签名实现；对应运行路由和前端调用也已移除。历史数据库配置值不自动删除。

## 新增文件

- `backend/sql/migrations/005_external_shortlink_sync.sql`
- `backend/src/controllers/internalSyncController.js`
- `backend/src/middleware/serviceAuth.js`
- `backend/src/routes/internalSyncRoutes.js`
- `backend/src/services/cloudflareShortLinkService.js`
- `backend/test/cloudflareShortLinkService.test.js`
- `llegomark-url-shortener/package-lock.json`
- `llegomark-url-shortener/test/worker.test.ts`
- `scripts/generate-dependency-license-report.mjs`
- `docs/dependency-licenses.md`（由脚本生成）
- `docs/wechat-og-shortlink-integration.md`
- `docs/cloudflare-og-shortlink-deployment.md`
- `docs/implementation-report.md`

Worker `dist/` 是被 `.gitignore` 忽略的本地 dry-run 构建产物，不是新增生产源码。

## 新增依赖与许可证

| 项目 | 依赖 | 范围 | 许可证 |
| --- | --- | --- | --- |
| Worker | `zod` | 生产 | MIT |
| Worker | `vitest` | 开发/测试 | MIT |

frontend 新增 MIT 许可证的 `qrcode` 生产依赖，用于浏览器本地生成微信分享二维码，不调用第三方二维码 API。完整 495 项生产及开发依赖闭包见 `dependency-licenses.md`：189 项属于生产闭包，未发现 GPL、AGPL、SSPL、BUSL、Commons Clause、Elastic License 或未知许可证。

clone 原 MIT LICENSE、原作者 Mark Anthony Llego 的版权声明和 package author 信息均保留；没有替换 demo18 的现有许可证。

## 接口与数据映射

完整表格见 `wechat-og-shortlink-integration.md`。核心映射为：

- demo18 `POST /api/shortlink/generate` → Worker `POST /api/urls`。
- demo18 卡片修改/封面上传 → Worker `PUT /api/urls/:shortCode`。
- demo18 停用、视频删除和过期任务 → Worker `DELETE /api/urls/:shortCode`。
- demo18 统计查询 → Worker `GET /api/urls/:shortCode` 作缓存计数对账，MySQL 仍是事实来源。
- Worker 点击 → demo18 `POST /api/internal/short-links/:shortCode/click`，独立 Bearer 服务密钥和 `external_event_id` 唯一键保证幂等。

`videos` 只提供默认标题、描述、封面、状态和归属组；每条卡片最终值独立写入 `short_links.card_token/card_title/card_description/card_cover_url/card_status`。短码、目标、状态、到期时间和点击最终值也由 `short_links` 管理。

## OG、权限、安全与缓存

- `GET /:shortCode` 对 MicroMessenger、WeChat、普通浏览器、Facebook 和 Twitter 爬虫统一返回 HTTP 200 完整 HTML，不按 User-Agent 分流。
- `/s` 与 `/card` HTML 含 title、description、canonical、完整 OG 图片字段和 Twitter card；播放目标只以 Base64URL token 出现，无按钮、裸 `/play` 或 `window.location.replace`，脚本校验同源相对路径后使用 `window.location.assign`。
- 目标限制为允许 Origin 的 `/card/{20..128 位 Base64URL token}`，阻断开放重定向和危险协议。
- `ogUrl` 只允许 HTTPS 公网地址；`ogImage` 的危险协议/私网地址被拒绝，HTTP 图片降级为 HTTPS 默认图。
- 文本与属性转义 `& < > " '`；脚本字符串额外编码 `< > & U+2028 U+2029`；响应设置 CSP、nosniff 和 no-referrer。
- 员工继续通过 demo18 JWT 和现有角色授权；非平台管理员的生成、列表、统计、停用、卡片编辑和封面上传均按 `business_group_id` 隔离。
- 封面只允许签名、MIME 与扩展名一致的 JPG/PNG/WebP，最大 5 MB。
- Worker Cache API 使用 `cacheVersion`；修改目标/标题/简介/封面时删除旧缓存并递增版本。过期/删除时拒绝访问并清理映射。
- API 与回写密钥不返回前端、不写 URL、不写日志；同步默认 3 次尝试并记录脱敏错误上下文。

## KV 格式

新记录为 schemaVersion 2，保存 `shortCode`、`targetUrl`、兼容字段 `url`、四个 OG 字段、到期/创建/更新时间和 `cacheVersion`。旧记录只含 `url` 时仍可读取，缺失 OG 时使用安全默认值；无效 JSON 或非法目标返回 404。详细 JSON 示例见接入说明。

## 自动化测试结果

### 指定命令

| 目录 | 命令 | 结果 |
| --- | --- | --- |
| Worker | `npm install` | 成功；生成 package-lock。npm 11 提示本机 allow-scripts 策略未批准 5 个开发工具安装脚本，但测试和打包均成功 |
| Worker | `npm test` | 8/8 通过，0 失败 |
| Worker | `npm run build` | 成功；Wrangler dry-run bundle 218.25 KiB，gzip 43.87 KiB |
| Worker | `npm run deploy -- --dry-run` | 成功；明确输出 `--dry-run: exiting now`，未部署 |
| backend | `npm test` | 33/33 通过，0 失败、0 跳过 |
| backend | `npm run migrate` | 成功；全部迁移幂等完成 |
| frontend | `npm run build` | 成功；1659 modules，只有 chunk 大小警告 |
| frontend | `npm run test:e2e` | 成功；覆盖 `/s`、`/card` 地址恢复、刷新、播放事件短链 ID 和两类二维码 |

本地数据库已执行全部幂等迁移；短链、播放统计、权限隔离和 Worker 点击幂等集成测试均实际执行，无跳过项。

### 25 项验收覆盖

| # | 验收项 | 状态 |
| --- | --- | --- |
| 1-2 | 创建有/无 OG 字段短链 | Worker 自动化通过 |
| 3-6 | HTTP 200、完整 OG、正确转义、无原始注入 | Worker 自动化通过 |
| 7-9 | 拒绝 `javascript:`、拒绝 `data:` 图片、HTTP 图片降级 | Worker 自动化通过 |
| 10-11 | 微信与普通浏览器 UA 返回相同完整 OG | Worker 自动化通过 |
| 12-13 | JavaScript 安全编码、无 JS 继续链接 | Worker 自动化通过 |
| 14-15 | 过期 410、不存在/坏 JSON 404 | Worker 自动化通过 |
| 16 | 修改卡片删除旧缓存 | Worker 自动化通过 |
| 17 | 点击统计 | KV 计数、demo18 原统计、回写实现通过；本机 DB 幂等集成项待迁移 005 后执行 |
| 18 | API Key 权限 | Worker 401 与后端常量时间服务认证测试通过 |
| 19 | 业务组隔离 | 数据库集成测试通过 |
| 20 | 视频过期短链失效 | 数据库集成测试通过 |
| 21 | 播放统计不受影响 | 现有幂等 start/progress 回归通过 |
| 22 | Suolink 302 精确目标 | 本地模拟服务自动化通过；生产凭据/真实域名需 staging 冒烟 |
| 23 | Suolink 假 404 拒绝 | 本地模拟服务自动化通过；生产需 staging 冒烟 |
| 24 | 同步重试与错误日志 | 自动化通过，断言日志不含 API Key |
| 25 | Worker 停止后 demo18 可工作 | Worker 故障自动降级到另一 self 域名的数据库集成测试通过 |

未执行真实 Cloudflare、Suolink 或生产域名的外部网络写操作，也未执行正式 deploy。真实 DNS、TLS、KV namespace、Suolink 账号绑定和微信客户端缓存行为必须在 staging/上线窗口按部署手册验证。

## 部署与回滚

完整步骤见 `cloudflare-og-shortlink-deployment.md`，包括 Worker/KV 创建、TOML、两套密钥、自定义域名、HTTPS/CORS、demo18 环境变量、迁移、Nginx、PM2、缓存清理、健康检查、正式部署停止点和回滚。

关闭 Worker 时先在 demo18 域名池停用 Worker 域名，新链改走普通自建域名；已有 Worker 链的短码同时存在 MySQL，可把该域名从 Custom Domain 移除、DNS 切到预先配置同域名证书的 demo18 Nginx，让原 `/:code` 路由继续服务。新增可空幂等列无需逆向 DDL，代码回滚不会破坏旧数据。
