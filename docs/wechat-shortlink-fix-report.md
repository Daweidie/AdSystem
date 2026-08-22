# 微信短链、直接播放、二次分享与 Suolink 修复报告

报告日期：2026-08-17

## 交付状态

代码实现、数据库迁移、本地构建和自动化验收均已完成。应用户最终指示，未执行本次生产上传、PM2 重启或 Nginx 变更；生产 `nginx -t`、全新生产短链生成和微信人工验收需在自行部署后执行。

## 行为变更

- `/s/:shortCode` 与 `/card/:cardToken` 对微信和普通浏览器统一返回 HTTP 200 完整 OG/Twitter HTML，不按 User-Agent 分流。
- canonical 与 `og:url` 来自当前请求的协议、Host 和路径；播放目标只以 Base64URL token 存在于首个 HTML 中。
- 卡片页解码后仅接受同源相对路径，使用 `window.location.assign` 自动进入 `/play`；没有继续播放按钮、裸 `/play`、301/302 文本、`window.location.replace` 或 Vue SPA 根节点。
- `/play` 只从数据库中的 `shortLinkId` 关联记录生成恢复路径。自建链恢复为 `/s/:shortCode`，Suolink 恢复为同源 `/card/:cardToken`；查询参数中的任意 `sharePath` 不受信任。
- TCPlayer 完成实例和事件监听初始化后才调用原生 `history.replaceState`。内存中保留 `fileId` 与 `shortLinkId`，继续用于鉴权和 start/progress/complete/error 事件；保持 autoplay、controls 和三种 inline 播放属性。
- 管理端明确提供“生成自建 /s/ 链接”和“生成 Suolink 链接”。显式 Suolink 请求固定发送 `allowFallback: false`，失败时显示真实错误，不静默降级。
- 每条有效推广链接增加“微信分享”弹窗；使用 `qrcode` 在浏览器本地生成 320×320 二维码，编码数据库返回的原始 `shortUrl`，拒绝 `/play`、标识符参数、签名、密钥或跨平台伪造地址。
- 保留既有权限、业务组隔离、卡片编辑/上传、点击与播放统计、过期 410、停用/删除 404、旧 Suolink 和 Cloudflare 兼容逻辑；没有引入微信 JS-SDK。

## 主要修改文件

- 后端：`backend/src/app.js`、`backend/src/controllers/shortLinkController.js`、`backend/src/controllers/videoController.js`、`backend/src/services/cardCoverService.js`、`backend/src/services/cardPageService.js`
- 后端测试与生产冒烟：`backend/test/acceptance.test.js`、`backend/test/cardPageService.test.js`、`backend/test/nginxConfig.test.js`、`backend/scripts/create-suolink-card-smoke.js`
- 前端：`frontend/src/views/Play.vue`、`frontend/src/views/Admin.vue`、`frontend/src/services/api.js`、`frontend/src/styles/main.css`
- 前端依赖与 E2E：`frontend/package.json`、`frontend/package-lock.json`、`frontend/e2e/ui.test.cjs`
- 部署与文档：`nginx/demo18.conf.template`、`deployment-artifacts/demo18-remote-deploy.sh`、`deployment-artifacts/run-password-deploy.ps1`、`README.md`、`docs/dependency-licenses.md`

## 数据库迁移

- 已在本地执行 `npm run migrate`，结果：`数据库迁移完成：video_ad_db`。
- 当前 schema 和既有幂等迁移已经包含 `platform`、`card_token`、卡片元数据及所需索引；本次修复不需要新增 DDL。
- 未批量改写既有 `short_url`，未删除旧链接。没有 `card_token` 的旧 Suolink 仍可播放，但不会伪造跨域地址恢复；管理端会提示重新生成以获得完整卡片入口。

## 新增依赖与许可证

- 前端新增 `qrcode@^1.5.4`，许可证 MIT，用于浏览器本地二维码生成。
- `docs/dependency-licenses.md` 已重新生成：共审计 495 个依赖闭包条目，其中生产依赖 189 个；未发现 GPL、AGPL、SSPL、BUSL、Commons Clause、Elastic License 或未知许可证。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| 后端 `npm run build` | 通过 |
| 后端 `npm test` | 33/33 通过，0 失败、0 跳过 |
| 后端 `npm run migrate` | 通过 |
| 前端 `npm run build` | 通过，1659 modules；仅保留既有 chunk 大小警告 |
| 前端 `npm run test:e2e` | 通过 |
| Nginx 模板自动化 | `/s`、`/card`、`/play` 三条 Express 代理均存在且位于 SPA fallback 前，通过 |

E2E 已验证：自建 `/s` 与 Suolink `/card` 确实进入 `/play`、播放器只初始化一次、最终地址分别恢复为 `/s` 和 `/card`、刷新不产生循环、播放事件保留正确 `shortLinkId`、普通 `/play` 不执行恶意恢复、两个生成按钮存在，以及两类二维码均精确编码原始 `shortUrl`。

## 部署包

- 发布包：`deployment-artifacts/demo18-release-20260817-r6.tar.gz`
- SHA-256：由同目录部署脚本内置并在上传前、远程解包前各校验一次
- 远程执行脚本：`deployment-artifacts/demo18-remote-deploy.sh`
- 自助入口：`powershell -ExecutionPolicy Bypass -File .\deployment-artifacts\run-password-deploy.ps1`

远程脚本会先备份 `/var/www/demo18`，保留 `backend/.env` 和上传文件，校验发布包哈希，安装依赖、构建、执行幂等迁移和后端测试，重启 PM2，执行 `nginx -t`，确认生产实际加载三条代理规则，然后创建全新的自建链与 Suolink 链并做双 User-Agent 冒烟。

## 尚待生产执行的验收

以下项目不是失败，而是因用户选择自行部署而没有在本次会话中执行：

- 生产 `nginx -t` 及已加载配置检查
- 新生产自建 `/s` 链接、新生产 Suolink 链接
- 两种 User-Agent 对新链接的生产 curl 结果
- 生产二维码的具体编码地址
- 生产自建与 Suolink 最终地址恢复结果
- 微信客户端扫码、右上角二次分享人工结果

微信普通聊天卡片的最终版式和是否展示 description 仍由微信客户端及其缓存决定。服务端保证的是 HTTP 状态、OG/Twitter 元数据和分享地址正确，不能承诺微信一定展示 description。旧卡片缓存应使用全新短码验证。
