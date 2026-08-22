# 视频广告资源管理系统缺陷修复与回归报告

执行日期：2026-08-11  
项目：`C:/Users/popol/Desktop/Projects/demo18`  
后端：`http://localhost:3001`  
前端：`http://localhost:5173`  
数据库：MySQL 5.7.31 / `video_ad_db`

## 1. 结论

- 代码修复、migration、构建、后端自动化与 Playwright E2E 均已完成。
- 14 个真实验收场景：13 个通过，1 个外部配置阻塞，0 个代码失败。
- 阻塞项仅为场景 5：当前 `SUOLINK_DOMAIN` 没有账号中已绑定且生效的独享域名。旧占位值已清空，代码会拒绝占位值，不能伪造供应商成功。
- 除真实 suolink 成功外，其余原报告失败项均已通过真实 HTTP、浏览器、腾讯云 VOD 和 SQL 验证。
- 当前交付判断：代码达到交付标准；包含 suolink 严格成功的整体验收尚需提供一个供应商账号已绑定的真实独享域名后复测。

## 2. 根因分析

| 问题 | 根因 | 修复 |
|---|---|---|
| TCPlayer 1009 / ORB | 页面优先加载失效的 4.2.1 cloudcache 地址；更关键的是环境内 64 位值并非腾讯云默认分发配置的 8–20 位播放密钥，`getplayinfo` 明确返回 `1009 token signature is invalid` | 仅加载腾讯官方固定版 4.5.4；后端调用 `DescribeDefaultDistributionConfig` 获取并内存缓存真实播放密钥，显式配置不一致时只输出长度级脱敏 warning；签名有效期取业务过期时间与 TTL 的最小值 |
| 播放日志为空 | 无事件接口、无前端监听、无 session 幂等/节流 | 增加 `POST /api/video/:id/events`，支持 start/progress/complete/error；前端 UUID session、start 幂等、10 秒 progress 节流、失败不打断播放 |
| 视频无法删除 | `vodService.deleteVideo` 已存在，但未接控制器、路由和 UI | 增加幂等 DELETE 流程；腾讯云成功后事务性软删除视频并过期短链；失败保存 `delete_error` 并返回 502/503 |
| suolink 不可用 | 实际环境使用 `your_short_domain.com` 占位值；错误状态和降级日志不足 | 占位/API URL/Key/域名预校验；供应商错误分类为 502、超时/配置为 503；auto 记录脱敏结构化 fallback warning；严格 suolink 不降级 |
| 域名管理缺失 | 只有 list/switch | 实现 create/update/delete/toggle 及完整 UI；校验 URL、唯一性和 type/platform；保护主域名和有关联短链的域名 |
| 顶层 `/play` 仍为 200 | SPA fallback 在业务校验前返回 index.html | Vite 开发中间件和 Nginx 精确 `/play` 代理均在返回 SPA 前调用后端门禁；过期/删除返回中文 HTTP 410，不存在返回 404 |
| 上传无自定义标题 | 文件选择事件直接启动上传 | 选择文件后显示确认对话框，标题必填、默认去扩展名、最多 255 字，确认后才上传且防重复提交 |
| 统一性与安全性不足 | CORS 默认任意 Origin，错误处理会打印完整 Error/axios config，JSON 错误体不统一 | Origin 白名单；结构化脱敏日志；统一 `success/data/code/message`；补充超时、重试和准确状态码 |
| 10 天边界偶发差 1 秒 | 应用用毫秒计算 expires，MySQL created_at 为整秒 | 改为同一数据库语句 `DATE_ADD(NOW(), INTERVAL 10 DAY)`，再将数据库精确过期时间同步到腾讯云 |

## 3. 修改文件

### 后端与数据库

- `backend/src/app.js`
- `backend/src/controllers/videoController.js`
- `backend/src/controllers/domainController.js`
- `backend/src/controllers/shortLinkController.js`
- `backend/src/routes/videoRoutes.js`
- `backend/src/routes/domainRoutes.js`
- `backend/src/services/vodService.js`
- `backend/src/services/suolinkService.js`
- `backend/src/services/unifiedShortLinkService.js`
- `backend/src/services/videoExpiryService.js`
- `backend/src/middleware/errorHandler.js`
- `backend/src/middleware/notFound.js`
- `backend/src/utils/logger.js`
- `backend/sql/schema.sql`
- `backend/sql/init_video_ad_db.sql`
- `backend/sql/migrations/003_playback_events_indexes.sql`
- `backend/scripts/migrate.js`
- `backend/test/acceptance.test.js`
- `backend/package.json`
- `backend/.env.example`
- `backend/.env`（仅清空无效的 suolink 占位域名，未输出或改写密钥）

### 前端、网关与文档

- `frontend/src/views/Play.vue`
- `frontend/src/views/Admin.vue`
- `frontend/vite.config.js`
- `frontend/index.html`
- `frontend/e2e/ui.test.cjs`
- `frontend/package.json`
- `frontend/package-lock.json`
- `nginx/demo18.conf.template`
- `deploy.sh`
- `README.md`
- `acceptance-artifacts/regression-suite-2026-08-11.cjs`
- `acceptance-artifacts/regression-results-2026-08-11.json`

## 4. Migration

新增可重复执行的 `003_playback_events_indexes.sql`：

- `play_logs.idx_play_logs_video_session_event_time(video_id, session_id, event_type, played_at)`
- `domains.idx_domains_enabled_platform(is_enabled, platform, is_primary)`

`scripts/migrate.js` 使用 `information_schema` 判断索引是否存在后再创建。实际连续执行两次结果均为：

```text
数据库迁移完成：video_ad_db
数据库迁移完成：video_ad_db
```

完整初始化入口也已改为可重复执行，并统一使用 `video_ad_db`，不会覆盖已有主域名选择。

## 5. Nginx 与 Vite 410

生产 Nginx 新增精确 `location = /play`，把文档请求代理到后端 `/play`。后端先查视频状态：

- ready：返回构建后的 Vue `index.html`，HTTP 200。
- expired/deleted：返回中文 HTML，HTTP 410。
- 不存在：返回中文 HTML，HTTP 404。

Vite 开发服务器通过同等门禁中间件调用 `GET /api/video/access?fileId=...`，避免开发环境继续返回错误的 SPA 200。

真实验证：过期顶层文档 HTTP 410；已删除顶层文档 HTTP 410；有效后端播放文档 HTTP 200。

## 6. 新增/修改接口

| 方法与路径 | 说明 | 主要状态 |
|---|---|---|
| `GET /api/video/access?fileId=...` | 播放页文档门禁 | 200/400/403/404/409/410 |
| `POST /api/video/:id/events` | start/progress/complete/error 播放事件 | 201；重复 start/节流 progress 为 200 |
| `DELETE /api/video/:id` | 腾讯云删除 + 本地软删除 + 短链过期；重复调用幂等 | 200/400/404/502/503 |
| `GET /api/video/list?includeDeleted=true` | 默认排除 deleted；审计时可包含 | 200 |
| `POST /api/domain` | 添加域名，可选设为主域名 | 201/400/409 |
| `PUT /api/domain/:id` | 编辑域名，不改已有短链的 domain_id/short_url | 200/400/404/409 |
| `POST /api/domain/:id/toggle` | 启停域名 | 200/400/404/409 |
| `DELETE /api/domain/:id` | 删除无关联、非主域名 | 200/400/404/409 |
| `POST /api/domain/switch` | 保留并加强原主域名切换 | 200/400/404/409 |

所有 JSON API 响应均归一为 `success/data/code/message`。

## 7. 自动化测试

### 命令与结果

```text
cd backend && npm run migrate       PASS（连续 2 次）
cd backend && npm test              PASS 8/8
cd frontend && npm run build        PASS
cd frontend && npm run test:e2e     PASS
node acceptance-artifacts/regression-suite-2026-08-11.cjs
                                      13 PASS / 1 BLOCKED_EXTERNAL_CONFIG / 0 FAIL
```

后端 8 项测试覆盖：统一响应、事件幂等/节流、域名 CRUD/主域名/有关联域名冲突、自建短码、供应商失败与 auto 降级、删除失败重试与重复删除、过期 410/短链同步、签名有效期上界。

Playwright 验证：上传标题对话框、三个管理 Tab、视频删除按钮、域名管理操作、真实视频 `readyState`/尺寸/时长/声音属性/时间推进。

构建仅有第三方 `@vueuse/core` PURE 注释位置 warning，Vite 会移除该注释；无构建失败和依赖漏洞。

## 8. 14 个验收场景新汇总

| # | 场景 | 结果 | HTTP / SQL / 浏览器证据 |
|---:|---|:---:|---|
| 1 | 视频上传 | PASS | upload signature 200、complete 201；新 FileId `5001834815503868735`；自定义标题落库；lifetime_seconds=864000 |
| 2 | 视频列表 | PASS | 8 个要求表头齐全；播放/生成短链/删除三项操作齐全 |
| 3 | 视频播放 | PASS | 文档 200；TCPlayer 4.5.4；readyState=4；640×360；duration=60.095011；muted=false；volume=1；currentTime 0→4.546；start=1/session=1 |
| 4 | 视频过期 | PASS | 顶层文档 410、内部 API 410/VIDEO_EXPIRED；中文页；短链不一致数 0；测试后精确恢复 |
| 5 | 真实 suolink | BLOCKED | 环境未提供账号已绑定生效的独享域名；占位值已清空且不会伪造成功 |
| 6 | 自建短链 | PASS | 201；短码 `Zsedqza`，7 位，platform=self |
| 7 | 跳转统计 | PASS | 302；clicks 0→1；移动端 UA 记录为 mobile；Location 带 fileId 与 shortLinkId |
| 8 | auto 降级 | PASS | 201；platform=self；fallbackFrom=suolink；结构化日志 `short_link_provider_fallback` |
| 9 | 域名切换 | PASS | 旧 short_url/domain_id 不变；新链接使用新 domain_id |
| 10 | 短链状态 | PASS | 停用访问 410；启用恢复 302 |
| 11 | 视频删除 | PASS | UI 二次确认；DeleteMedia 成功；DELETE 200；status=deleted；deleted_at 非空；delete_error 空；关联有效短链 0；默认列表排除；访问 410；4 条审计日志保留 |
| 12 | 短链列表 | PASS | 复制提示成功；stats 200；弹窗显示累计 2、移动端 1、PC 1 |
| 13 | 域名管理 | PASS | 页面完成添加、编辑、停用、启用、切换、删除 |
| 14 | 数据完整性 | PASS | 4 个外键；4 类孤儿均 0；过期/删除同步不一致 0；主域名数量 1 |

完整机器可读结果：`acceptance-artifacts/regression-results-2026-08-11.json`。

## 9. 修复前后日志对比

修复前：

```text
net::ERR_BLOCKED_BY_ORB ... tcplayer.v4.2.1.min.js
TCPlayer: ERROR: (CODE:1009) MediaError
play_logs: 0 rows
auto fallback: no dedicated warning log
```

修复后：

```json
{"level":"warn","event":"vod_player_key_mismatch","code":"VOD_PLAY_KEY_MISMATCH","configuredKeyLength":64,"providerKeyLength":20,"action":"using_provider_distribution_key"}
{"level":"warn","event":"short_link_provider_fallback","code":"SUOLINK_PROVIDER_ERROR","durationMs":617,"targetPlatform":"suolink","fallbackPlatform":"self","videoId":"2"}
```

修复后真实播放没有 CODE 1009 或 ORB；媒体请求 206，事件上报 201。日志扫描未发现 Authorization、psign、API Key、Secret 或完整签名。

## 10. 待提供的唯一外部配置

在缩链控制台绑定并启用一个真实独享域名，然后填写：

```text
SUOLINK_DOMAIN=<已绑定生效的独享域名>
```

重启后端后重新执行场景 5。不要填写共享域名、示例域名或未在该账号绑定的域名。`platform=suolink` 会直接返回供应商错误；`platform=auto` 才允许降级为 self。
