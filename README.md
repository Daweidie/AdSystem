# 视频广告资源管理系统

本仓库以两个业务项目为主，并包含一个受 demo18 控制的短链展示层：

- `backend`：Node.js + Express + MySQL API 服务
- `frontend`：Vue 3 + Vite H5 管理端骨架
- `llegomark-url-shortener`：保留原 MIT LICENSE 的 Cloudflare Worker 短链/OG 缓存层；不独立管理用户、视频、业务组或权限

## 快速开始

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

数据库表结构位于 `backend/sql/schema.sql`。首次启动或拉取短链分发功能更新后执行：

```bash
cd backend
npm run migrate
```

迁移脚本可重复执行；`003_playback_events_indexes.sql` 为播放事件与域名选择补充组合索引，
`004_short_link_wechat_cards.sql` 保存逐短链卡片数据，`005_external_shortlink_sync.sql` 提供 Worker 点击回写幂等键。

## 验证

```bash
cd backend
npm test
```

```bash
cd frontend
npm run build
npm run test:e2e
```

## 管理后台与本地验收账号

本地启动后访问 `http://localhost:5173`，登录后进入产品素材资源管理后台。

| 角色 | 登录手机号 | 演示密码 | 权限范围 |
| --- | --- | --- | --- |
| 超级管理员 | `13800000001` | `Demo123!` | 全部后台功能、域名配置、系统管理员及系统初始化 |
| 系统管理员 | `13800000002` | `Demo123!` | 日常运营、业务组、素材组及推广员管理，无域名配置权限 |
| 业务组管理员 | `13800000003` | `Demo123!` | 管理本业务组素材、素材组；仅查看本组推广员 |
| 一般用户 | `13800000004` | `Demo123!` | 仅查看和使用本业务组素材及推广链接 |

验收账号由 `npm run migrate` 可重复初始化，登录页不会展示账号或预填密码。正式上线前必须修改或停用这些账号，
并将 `JWT_SECRET` 替换为高强度随机值。

主要后台功能包括：运营总览、素材列表、素材组、云端视频上传、推广链接、
微信卡片链接复制、推广员、业务组、到期提醒和系统管理员账号管理。播放页及
短链跳转保持免登录，便于客户从微信信息卡片直接观看视频。

客户域名尚未审核通过时，可先用服务器 IP 演示。域名可用后，由超级管理员
进入“系统设置 → 域名池管理”，添加一个或多个 `https://客户域名`。
Suolink 新推广链接会在已启用的供应商域名中按已分配链接数均衡轮换。自建短链仍使用统一公共卡片
入口；Suolink 配置域名仅作为并列时的首选，其他已绑定当前 API Key 的 Suolink 域名也会
参与生成。停用域名不再接收新链接，历史投放链接保持原地址。正式微信
投放应使用已备案并配置 HTTPS 证书的域名。

### Suolink 第三方缩链

在“系统设置 → 域名池管理 → Suolink 第三方缩链”填写 API Key 和 Suolink 分配的域名并启用。
该域名只应在此处配置，不要再通过普通“添加域名”录入为自建域名；视频落地域名则继续配置为
自建域名。启用后，后台生成推广链接会强制调用 Suolink，并验证返回域名及实际访问结果；检测到
未生效链接或 Suolink 的 404 页面时会直接报错，不会保存或回退生成一个同域名的本地短码。

Suolink 的原网址固定为本系统的 `/card/{cardToken}` 页面。创建结果必须属于当前配置的
选中的 Suolink 域名，首次访问必须返回 302 且 `Location` 精确匹配该卡片页；检测到
Suolink “404-页面不存在”会拒绝保存。域名池中的每个 Suolink 域名都必须由 Suolink 实际
分配，本项目不会伪造这些域名。

### 服务端 Open Graph 微信卡片

新的自建短链格式为 `/s/{6-8 位 Base62}`。短链直接返回 HTTP 200 完整 HTML，
服务端输出标题、简介、HTTPS 封面、canonical、Twitter Card 和 `og:*` 元数据；
页面不包含 301/302 或 `window.location.replace`，用户打开链接后由 Base64 目标立即进入 `/play`，无需二次点击。所有 User-Agent
（包括微信爬虫）使用同一 HTML，不依赖前端 SPA 或 User-Agent 分流。原有 `/card`、
`/api/short` 与已有 Suolink 链路继续兼容；管理台生成链接时可明确选择自建 `/s/` 或 Suolink。
播放器完成初始化后用原生 `history.replaceState` 把地址恢复为同源入口：自建链恢复 `/s/{shortCode}`，
Suolink 恢复 `/card/{cardToken}`，因此不使用微信 JS-SDK 也不会在二次分享时暴露长 `/play` URL。

本方案不需要微信公众号，不使用微信 JS-SDK，通过服务端 Open Graph 元数据实现微信链接预览。
微信最终卡片样式、简介是否显示及缓存刷新时间由微信客户端决定，系统不能强制控制。

素材列表的每条有效推广链接提供“微信分享”入口，本地使用 `qrcode` 生成 320×320 二维码；
自建二维码编码 `https://vod.zzqixiangkeji.cn/s/{shortCode}`，Suolink 二维码编码供应商实际返回的
`shortUrl`，不会把 `fileId`、`shortLinkId` 或播放签名写入二维码。卡片设置可预览并更新标题、简介和封面。
卡片封面支持重新选择 JPG、PNG、WebP 图片（最大 5MB），上传后保存在
`backend/uploads/share-cards`，并通过公开只读地址供微信抓取；部署同步会保留该目录。
卡片更新会同步到 demo18 `short_links` 并使 Worker 旧缓存失效。后台时间统一按北京时间展示，
数据库连接按 UTC 读写，避免生产服务器时区不同造成链接生成时间偏移。完整架构、安全、部署和
回滚说明见 `docs/wechat-og-shortlink-integration.md` 与 `docs/cloudflare-og-shortlink-deployment.md`。

Playwright 测试默认使用 Windows Edge，可通过 `PLAYWRIGHT_EDGE_PATH` 覆盖浏览器路径。

短链相关接口：

- `POST /api/shortlink/self-create`：生成并保存新的 `/s/` 自建卡片短链
- `POST /api/shortlink/generate`：保留原有 Suolink/自动选择兼容生成行为
- `GET /api/shortlink/list`：列表、视频筛选和时间排序
- `GET /api/shortlink/:id/stats`：单条短链统计
- `POST /api/shortlink/toggle`：停用/启用
- `DELETE /api/shortlink/:id`：删除有权限管理的自建短链
- `PUT /api/management/short-links/:id/card`：更新短链卡片标题、描述和封面地址
- `GET /s/:shortCode`：返回 HTTP 200 卡片 HTML，Base64 解码并校验同源相对目标后自动进入播放器
- `GET /card/:cardToken`：返回 Suolink 兼容卡片 HTML，并以同样方式自动进入播放器
- `GET /api/statistics/shortlink`：管理端统计卡片
- `POST /api/video/:id/events`：上报 `start/progress/complete/error` 播放事件
- `DELETE /api/video/:id`：幂等删除腾讯云媒资并软删除本地视频
- `GET /api/video/access?fileId=...`：播放文档返回前的 404/410 门禁
- `POST /api/domain`、`PUT /api/domain/:id`、`DELETE /api/domain/:id`：域名管理
- `POST /api/domain/:id/toggle`：启用或停用域名

生产环境建议配置 `PLAY_PAGE_BASE_URL`（完整播放页地址）、
`PUBLIC_CARD_BASE_URL=https://vod.zzqixiangkeji.cn`、`PUBLIC_SHORTLINK_BASE_URL` 和
`TRUST_PROXY_HOPS`。Suolink 配置同时供新建和原有链接使用。播放器签名密钥留空时，后端会调用
腾讯云 `DescribeDefaultDistributionConfig` 获取正确的播放密钥并仅在内存中缓存。

开发环境由 Vite 中间件在返回 `/play` 前调用访问门禁；生产环境必须使用
`nginx/demo18.conf.template` 中的精确 `/play`、`/s/` 与 `/card/` 代理；否则卡片入口可能被
Vue SPA 接管，微信爬虫无法取得服务端卡片元数据。
