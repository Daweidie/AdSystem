# 微信 Open Graph 短链接入说明

## 结论与边界

本方案不需要微信公众号，不使用微信 JS-SDK，通过服务端 Open Graph 元数据实现微信链接预览。

微信抓取短链时会直接收到 HTTP 200 的完整 HTML；普通浏览器随后由内联 JavaScript 打开真实播放页，禁用 JavaScript 时仍可点击“继续打开”。所有 User-Agent 使用同一响应路径，不通过 User-Agent 猜测爬虫。

Open Graph 是兼容性输入，不是微信的强制展示 API。微信最终是否展开、标题/简介如何排版以及缓存何时刷新，均由微信客户端和微信缓存策略决定。

### 封面可达性（国内企微抓取）

卡片 HTML 可以继续部署在香港/海外，但 `og:image` 不应指向该跨境源站。请将封面同步到
已备案的腾讯云 COS/CDN，并在后端配置 `PUBLIC_CARD_COVER_BASE_URL` 为该 CDN 的 HTTPS
根域名；系统会把 `/card-covers/*` 和默认图改写为该 Origin。CDN 必须允许匿名 `GET/HEAD`，
返回 `200`、真实图片 `Content-Type`（JPEG/PNG）和不超过 1MB 的响应，不要加登录、Referer
校验或防盗链。未配置专用 Origin 时才回退到 `PUBLIC_CARD_BASE_URL`。

默认图是 PNG，动态封面为规范化 JPEG；服务端不会再把 PNG 错报为 `image/jpeg`，未知扩展名
则省略 `og:image:type`，以响应头为准。修改封面后请使用新短码或等待企微预览缓存（通常约
24 小时）失效。

## 架构

```text
员工浏览器
  └─ JWT → demo18 API → MySQL（用户/业务组/视频/短链/卡片/统计的唯一事实来源）
                         ├─ Suolink：原网址固定为 /card/{cardToken}
                         └─ Cloudflare Worker 管理 API（Bearer 服务密钥）
                              └─ KV（短码映射、OG、临时点击计数、缓存版本）

访问者 / 微信爬虫
  └─ 短链 → Worker HTTP 200 OG HTML → /card/{cardToken} → /play?fileId=...
                       └─ 受保护点击回写 → demo18 MySQL
```

Cloudflare Worker 不持有 MySQL 账号或密码，也不实现用户、视频、业务组或角色权限。停止 Worker 后，demo18 的上传、播放、统计和现有自建短链保持可用；新建链接可从 Worker 域名池停用或自动降级到其他自建域名。

## 接口映射

| 业务动作 | demo18 对员工接口 | demo18 → Worker | 数据结果 |
| --- | --- | --- | --- |
| 生成短链 | `POST /api/shortlink/generate` | `POST /api/urls` | 先生成 256-bit `cardToken`，MySQL 保存后同步同一短码和 OG |
| 查询列表 | `GET /api/shortlink/list` | 无；列表以 MySQL 为准 | 非平台管理员按 `business_group_id` 过滤 |
| 查询详情/统计 | `GET /api/shortlink/:id/stats` | `GET /api/urls/:shortCode` | MySQL 为事实来源，Worker 计数只做对账补充 |
| 修改卡片 | `PUT /api/management/short-links/:id/card` | `PUT /api/urls/:shortCode` | 更新 MySQL 后同步 OG，并使 Worker 旧 Cache API 对象失效 |
| 上传卡片封面 | `POST /api/management/short-links/:id/card-cover` | `PUT /api/urls/:shortCode` | 校验图片后保存，随后同步 HTTPS 公网地址 |
| 停用/启用 | `POST /api/shortlink/toggle` | `DELETE /api/urls/:shortCode` 或重新创建 | MySQL 状态先受权限约束，Worker 只反映状态 |
| 视频删除/到期 | `DELETE /api/video/:id` / 定时到期任务 | `DELETE /api/urls/:shortCode` | MySQL 视频/短链先失效，再尽力清理 Worker 缓存 |
| Worker 点击回写 | 非公开员工接口 | `POST /api/internal/short-links/:shortCode/click` | 独立 Bearer 密钥认证，`eventId` 唯一索引保证重试幂等 |
| Suolink 创建 | `POST /api/shortlink/generate` | Suolink 缩链 API | 原网址严格为 `https://vod.zzqixiangkeji.cn/card/{cardToken}` |

Worker 管理 API 响应统一包含 `shortCode`、`targetUrl`、`shortUrl`、完整 OG 字段、`clickCount`、`expirationDate`、`createdAt` 和 `updatedAt`。API Key 只在 demo18 后端环境变量中使用，不进入前端响应或日志。

## 数据库字段映射

| demo18 表/字段 | 作用 | Worker/KV 对应 | 权威方 |
| --- | --- | --- | --- |
| `videos.id` | 业务视频 ID | 不复制 | MySQL |
| `videos.file_id` | 播放页 FileId | 间接存在于最终 `/play` URL | MySQL |
| `videos.title` | 新短链默认标题 | 新建时复制到 `ogTitle` | MySQL |
| `videos.description` | 新短链默认简介 | 新建时复制到 `ogDescription` | MySQL |
| `videos.cover_url` | 新短链默认封面 | 规范化为 HTTPS 后复制到 `ogImage` | MySQL |
| `videos.status` / `expires_at` | 可用性 | 映射到 Worker `expirationDate`，但最终仍由 demo18 校验 | MySQL |
| `videos.business_group_id` | 数据隔离边界 | 不复制 | MySQL |
| `short_links.id` / `video_id` | 业务关系 | 不复制 | MySQL |
| `short_links.short_code` | 唯一短码 | KV key 与 `shortCode` | MySQL 生成、Worker 镜像 |
| `short_links.short_url` | 对外短链 | Worker `shortUrl` | MySQL |
| `short_links.long_url` | `/card/{cardToken}` | `targetUrl` / 兼容字段 `url` | MySQL |
| `short_links.card_token` | 32 字节安全随机 Base64URL token | 只出现在目标路径 | MySQL |
| `short_links.card_title` | 每条短链独立标题 | `ogTitle` | MySQL |
| `short_links.card_description` | 每条短链独立简介 | `ogDescription` | MySQL |
| `short_links.card_cover_url` | 每条短链独立封面 | `ogImage` | MySQL |
| `short_links.card_status` / `status` / `expires_at` | 卡片及短链状态 | 更新或删除映射 | MySQL |
| `short_links.clicks` | 点击总数 | `URL_ANALYTICS` 仅作临时计数 | MySQL |
| `play_logs.external_event_id` | Worker 回写幂等键 | Worker 生成 UUID | MySQL |

迁移 `004_short_link_wechat_cards.sql` 已提供逐短链卡片字段；新增迁移 `005_external_shortlink_sync.sql` 只增加点击回写幂等字段。部署前必须备份并由运维人工执行 `npm run migrate`，本次适配不会自行改写现有数据库。

## KV 格式与旧记录兼容

`URL_MAPPINGS` 的新记录格式：

```json
{
  "schemaVersion": 2,
  "shortCode": "abc123",
  "targetUrl": "https://vod.zzqixiangkeji.cn/card/<cardToken>",
  "url": "https://vod.zzqixiangkeji.cn/card/<cardToken>",
  "ogTitle": "卡片标题",
  "ogDescription": "卡片简介",
  "ogImage": "https://vod.zzqixiangkeji.cn/cover.jpg",
  "ogUrl": "https://s.hotwharf.com/abc123",
  "expirationDate": 1780000000000,
  "createdAt": "2026-08-16T00:00:00.000Z",
  "updatedAt": "2026-08-16T00:00:00.000Z",
  "cacheVersion": 1
}
```

- 旧 `{ "url": "...", "expirationDate": ... }` 记录继续可读。
- 旧记录没有 OG 字段时使用配置的安全标题、简介和 HTTPS 默认图。
- JSON 无法解析、目标协议非法、目标域名不在白名单或目标不是 `/card/{cardToken}` 时返回安全 404。
- `URL_ANALYTICS` 使用 `clicks:{shortCode}`；旧的裸 `shortCode` 计数键仍可读取。
- `API_KEYS` 的 key 是服务 API Key、value 为 `true`；`OG_METADATA_CACHE` 保留原绑定兼容性，当前完整 OG 随映射存储，HTML 使用 Cache API。

## 权限控制

- 员工入口继续使用 demo18 现有 JWT 登录和角色中间件，不向 Worker 暴露员工身份系统。
- `super_admin`、`system_admin` 可跨组；其他员工生成、查看、修改、停用短链时强制匹配视频的 `business_group_id`。
- 卡片编辑和封面上传先执行 `getScopedShortLink`，无法通过猜测短链 ID 操作其他业务组。
- Worker 管理 API 与点击回写分别使用两个不同的高熵密钥；点击接口使用常量时间摘要比较。
- Worker API 不在浏览器中调用，CORS 仅作为额外边界，不能替代 Bearer 认证。

## 安全控制

- URL 只允许 `http:`/`https:`；配置白名单后，目标还必须属于允许的 Origin 且路径为 `/card/{cardToken}`。
- `ogUrl` 必须是 HTTPS 公网绝对地址；`ogImage` 的 `javascript:`、`data:`、`file:` 和私网地址被拒绝，HTTP 图片降级为 HTTPS 默认图。
- 标题最多 255 字符、描述最多 2000 字符、URL 最多 2048 字符、短码格式固定。
- HTML 属性/文本转义 `& < > " '`；JavaScript 地址经 `JSON.stringify` 并额外编码 `< > & U+2028 U+2029`。
- 响应设置 CSP、`nosniff`、`no-referrer`；无 JavaScript 时页面仍有普通链接，不返回空 SPA。
- 上传封面限制 5 MB，仅 JPG、PNG、WebP，并同时核验 MIME、扩展名和文件签名字节。
- 后端同步默认 3 次尝试并指数退避；错误日志只记录方法、路径、状态、尝试次数和错误码，不记录 API Key。

## 缓存与一致性

- Worker KV 是镜像缓存，MySQL 是唯一业务主数据源。
- HTML Cache API key 包含 `cacheVersion`；更新目标或任一 OG 字段时版本递增，并删除旧版本缓存。
- 对外响应使用 `Cache-Control: public, max-age=0, must-revalidate`；内部 Cache API 对象最多缓存 300 秒。
- 停用、删除或过期时删除映射和 HTML 缓存；demo18 `/card/{cardToken}` 仍会再次校验视频和短链状态，防止陈旧边缘数据继续播放。
- Worker 点击会立即更新 KV 临时计数，同时异步回写 MySQL。`external_event_id` 防止三次重试造成重复统计；`_shortCode` 标记防止 Worker 首跳和 demo18 卡片页重复计数。
- 卡片更新同步失败会返回错误并记录可重试诊断；MySQL 已保存的数据仍是最终值，管理员可重新保存触发 upsert。

## Suolink 约束

- 域名池中每个 Suolink 域名都不能由本项目生成；必须由 Suolink 控制台真实分配并绑定。
- 创建后校验返回域名必须是本次从域名池选中的 Suolink 域名，首次访问必须是 302，`Location` 必须精确指向本次 `/card/{cardToken}`。
- 响应为 200、落入 Suolink “404-页面不存在”或目标不一致时拒绝保存。
- `auto` 模式下 Suolink 或 Worker 故障可降级到已启用的普通自建域名；显式指定平台且关闭降级时会报告错误。
