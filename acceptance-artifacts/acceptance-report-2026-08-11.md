# 视频广告资源管理系统 - 全功能验收测试报告

测试日期：2026-08-11  
项目路径：`C:/Users/popol/Desktop/Projects/demo18`  
测试入口：前端 `http://localhost:5173`，后端 `http://localhost:3001`，MySQL `video_ad_db`  
测试素材：`AT_E2E_20260811.mp4`，5,510,872 字节，含视频轨和音轨，小于 100MB  
测试视频：数据库 ID `2`，腾讯云 VOD FileId `5001834815472845728`

---

## 一、测试结果汇总

| 序号 | 场景 | 结果 | 备注 |
|---:|---|:---:|---|
| 1 | 视频上传 | ✅ | 上传签名 200，腾讯云直传成功，完成登记 201；`expires_at-created_at=864000` 秒；列表自动刷新。页面没有自定义标题输入框，标题自动使用文件名。 |
| 2 | 视频列表 | ❌ | 标题、FileId、过期时间、状态、播放量、创建时间均显示；只有“播放/生成短链”，缺少要求的“删除”。 |
| 3 | 视频播放 | ❌ | 页面和视频信息 API 均为 200，TCPlayer 已加载，但报 `CODE 1009 / MediaError`，无法播放画面和声音；`play_logs` 无新增记录。 |
| 4 | 视频过期 | ❌ | 内部视频 API 410、页面文案和短链 410/状态同步均正确；但浏览器顶层 `/play?...` 仍返回 SPA HTTP 200，不满足严格的顶层 410 要求。 |
| 5 | 缩链 API 生成 | ❌ | 缩链域名仍为占位值 `your_short_domain.com`；供应商返回“生成短网址域名不存在”，严格请求 HTTP 500，未新增 `platform='suolink'` 记录。 |
| 6 | 自建短链生成 | ✅ | HTTP 201；短码 `mwCrG5`（6 位）；数据库平台为 `self`。 |
| 7 | 短链跳转统计 | ✅ | HTTP 302 到目标播放页；点击量 0→1；日志记录后台 Referer、移动端设备、UA 和 IP。 |
| 8 | 双轨制降级 | ✅ | 独立进程注入错误 Key 后，`auto` 仍返回 201、自建短链和 `fallbackFrom='suolink'`。服务没有输出单独的降级错误日志。 |
| 9 | 域名切换联动 | ✅ | 新短链使用切换后的域名；旧短链 URL、域名关联和状态均未改变。 |
| 10 | 短链状态管理 | ✅ | 停用 API 200、访问 410；启用 API 200、访问恢复 302。 |
| 11 | 视频删除 | ❌ | 页面无删除按钮；`DELETE /api/video/2` 返回 404；数据库记录仍存在。 |
| 12 | 短链列表管理 | ✅ | 所需字段完整；复制成功；统计接口 200，弹窗显示累计/移动端/PC 点击量。 |
| 13 | 域名管理 | ❌ | 域名列表和切换可用；无添加/删除按钮，`POST /api/domain`、`DELETE /api/domain/3` 均 404。 |
| 14 | 数据库完整性 | ✅ | 4 条外键存在；4 类孤儿记录计数均为 0；过期同步不一致计数为 0。 |

通过 8/14，失败 6/14，通过率 57.1%。

## 二、逐场景证据

### 场景 1：视频上传 — ✅ 通过

- 浏览器网络：`POST /api/video/upload` 200；腾讯云 VOD 初始化、COS 分片上传/完成请求均 200；`POST /api/video/complete` 201。
- FileId：`5001834815472845728`。
- 页面提示：“上传成功，短链已自动生成”；列表自动出现新视频。
- SQL：

```sql
SELECT id,file_id,title,status,expires_at,created_at,
       TIMESTAMPDIFF(SECOND,created_at,expires_at) AS lifetime_seconds
FROM videos
WHERE file_id='5001834815472845728';
```

结果：`id=2`，`title='AT_E2E_20260811.mp4'`，`status='ready'`，`lifetime_seconds=864000`（10 天）。

- 截图描述：管理页首行显示测试标题、FileId、自动短链、可播放状态、播放量 0、创建时间和 10 天后的过期时间。

### 场景 2：视频列表 — ❌ 失败

- `GET /api/video/list` 200。
- 表格显示标题、FileId、短链、状态、播放量、创建时间、过期时间。
- 操作列只显示“播放、生成短链”，删除按钮数量为 0。
- HTTP/日志：列表接口无报错；失败原因是 UI 和后端删除能力缺失。
- 复现：打开 `/admin` → 查看任意视频行操作列。

### 场景 3：视频播放 — ❌ 失败

- 浏览器顶层 `/play?fileId=5001834815472845728`：HTTP 200。
- `GET /api/video/5001834815472845728`：HTTP 200，VOD 元数据返回时长 `60.095` 秒、大小 `5,510,872` 字节。
- TCPlayer 备用脚本和样式均 200，全局 `TCPlayer` 为函数；播放器随即触发 `CODE 1009 / MediaError`，视频元素被销毁。
- 控制台日志：

```text
requestfailed: net::ERR_BLOCKED_BY_ORB .../tcplayer.v4.2.1.min.js
TCPlayer: ERROR: (CODE:1009 undefined) MediaError
```

- SQL：

```sql
SELECT id,video_id,short_link_id,event_type,played_at
FROM play_logs
WHERE video_id=2;
```

结果：0 行。

- 复现：后台点击测试视频“播放”，或直接访问上述播放 URL。
- 截图描述：黑色播放器区域显示“视频暂时无法播放”“播放器加载失败（错误码 1009）”。

### 场景 4：视频过期 — ❌ 失败（部分子项通过）

执行：

```sql
UPDATE videos
SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE), status='ready'
WHERE file_id='5001834815472845728';
```

- 视频信息 API：HTTP 410，`code='VIDEO_EXPIRED'`，`message='视频已过期，无法播放'`。
- 页面：显示“视频已过期，无法播放”。
- 关联短链：访问返回 HTTP 410；数据库状态由 `active` 同步为 `expired`。
- 不符合项：浏览器顶层 `/play?...` 导航响应仍为 HTTP 200；410 只来自页面内部 API。
- 日志：无服务异常日志，属于响应语义不满足。
- 复现：执行上述 SQL → 浏览器访问 `/play?...` → 查看 DevTools 顶层文档状态与内部 API 状态。
- 测试后已恢复视频为 `ready`、10 天有效，短链恢复 `active`。

### 场景 5：缩链 API 生成 — ❌ 失败

- 切换缩链域名：HTTP 200。
- 严格调用 `platform='suolink'`：HTTP 500。
- 错误响应：

```json
{"success":false,"code":"SUOLINK_PROVIDER_ERROR","message":"缩链 API 返回错误：生成短网址域名不存在，请重试"}
```

- UI 的 `auto` 请求返回 201，但实际降级到自建：`platform='self'`、`fallbackFrom='suolink'`。
- 数据库未新增任何缩链平台记录。
- 复现：配置/选择 `your_short_domain.com` → 点击测试视频“生成短链”，或 POST `/api/shortlink/generate` 且 `platform='suolink'`。
- 截图描述：域名选择框显示缩链域名为当前值，但成功提示中的实际返回 URL 是本地自建短链。

### 场景 6：自建短链生成 — ✅ 通过

```sql
SELECT sl.id,sl.short_code,LENGTH(sl.short_code) AS code_length,
       sl.short_url,sl.domain_id,d.platform,d.domain
FROM short_links sl JOIN domains d ON d.id=sl.domain_id
WHERE sl.id=4;
```

结果：`id=4`，`short_code='mwCrG5'`，`code_length=6`，`platform='self'`，URL 为 `http://localhost:3001/api/short/mwCrG5`。

### 场景 7：短链跳转与统计 — ✅ 通过

- 访问前：`clicks=0`，关联日志 0 行。
- 访问响应：HTTP 302；`Location=http://localhost:5173/play?fileId=5001834815472845728`。
- 访问后：`clicks=1`；新增 `play_logs.id=3`，`event_type='redirect'`，`referer='http://localhost:5173/admin'`，`device_type='mobile'`，IP 为 `::1`。
- 截图描述：访问前短链管理行显示点击量 0；跳转后地址栏为播放页（播放页仍复现独立的 1009 问题）。

### 场景 8：双轨制自动降级 — ✅ 通过

- 临时后端端口：3018；进程环境覆盖为故意错误的缩链 Key，未修改项目 `.env`。
- 返回 HTTP 201，短链 `ZoYUNgPV`，`platform='self'`，`fallbackFrom='suolink'`，消息为“缩链服务不可用，已降级为自建短链”。
- 服务日志只有 `API server listening on http://localhost:3018`，没有供应商失败/降级原因日志。
- 临时进程测试后已关闭，3018 监听数为 0。

### 场景 9：域名切换联动 — ✅ 通过

- 切换接口：HTTP 200。
- 旧链接 ID 4：`http://localhost:3001/api/short/mwCrG5`，关联域名 ID 1，保持 `active`。
- 新链接 ID 6：`http://127.0.0.1:3001/api/short/ZZ9S80`，关联临时域名 ID 3，状态 `active`。
- 截图描述：切换前后下拉框显示不同主域名；生成后的测试视频行短链前缀随新域名变化。

### 场景 10：短链状态管理 — ✅ 通过

- 停用：`POST /api/shortlink/toggle` 200，数据库/API 状态为 `disabled`；访问 HTTP 410。
- 启用：接口 200，状态为 `active`；访问 HTTP 302 并返回正确 `Location`。
- 截图描述：同一短链行先显示“已停用/启用”按钮，恢复后显示“有效/停用”按钮。

### 场景 11：视频删除 — ❌ 失败

- 页面删除按钮数量：0。
- `DELETE /api/video/2`：HTTP 404。
- 响应日志：`Route not found: DELETE /api/video/2`。
- SQL 验证：`SELECT id,file_id,status,deleted_at FROM videos WHERE id=2;` 仍返回 `status='ready'`、`deleted_at=NULL`。
- 复现：打开 `/admin` 查看操作列；或直接发送上述 DELETE 请求。

### 场景 12：短链列表管理 — ✅ 通过

- 表头：短链、视频标题、分发平台、使用域名、点击量、创建时间、状态、操作。
- 操作：复制链接成功；统计接口 HTTP 200。
- 统计结果：短链 ID 6，`totalClicks=1`、`mobileClicks=0`、`pcClicks=1`。
- 截图描述：短链管理 Tab 展示所有要求字段及“复制链接、查看统计、停用”操作；统计弹窗文本显示累计和设备分类数据。

### 场景 13：域名管理 — ❌ 失败

- 域名列表/主域名切换：HTTP 200，可用。
- 页面新增域名按钮数量：0；删除域名按钮数量：0。
- `POST /api/domain`：HTTP 404，`Route not found: POST /api/domain`。
- `DELETE /api/domain/3`：HTTP 404，`Route not found: DELETE /api/domain/3`。
- 复现：打开 `/admin`，域名区域仅有主域名下拉框；或调用上述接口。
- 临时数据库域名夹具已在测试后清理，原始 ID 1 已恢复为唯一主域名。

### 场景 14：数据库完整性 — ✅ 通过

外键查询：

```sql
SELECT TABLE_NAME,COLUMN_NAME,CONSTRAINT_NAME,
       REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA=DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME,COLUMN_NAME;
```

结果：

- `play_logs.short_link_id → short_links.id`
- `play_logs.video_id → videos.id`
- `short_links.domain_id → domains.id`
- `short_links.video_id → videos.id`

孤儿记录查询结果：

```text
shortlink_video_orphans=0
shortlink_domain_orphans=0
playlog_video_orphans=0
playlog_shortlink_orphans=0
```

过期同步查询：

```sql
SELECT v.id,v.status,v.expires_at,sl.id,sl.status
FROM videos v JOIN short_links sl ON sl.video_id=v.id
WHERE v.id=2;
```

临时过期后，查询时 5 条关联短链（ID 2–6）均为 `expired`；以下不一致查询结果为 0：

```sql
SELECT COUNT(*) AS mismatch_count
FROM videos v JOIN short_links sl ON sl.video_id=v.id
WHERE (v.expires_at<=NOW() OR v.status IN ('expired','deleted'))
  AND sl.status<>'expired';
```

测试后恢复验证：唯一主域名数量 1，测试视频恢复 `ready` 且 `expires_at=created_at+10 DAY`，保留测试短链均为 `active`。

## 三、发现的问题（BUG）

| 编号 | 问题描述 | 严重程度 | 复现步骤 |
|---|---|:---:|---|
| BUG-1 | TCPlayer 初始化后报 `CODE 1009 / MediaError`，真实 VOD 视频无法播放画面和声音。 | 高 | 上传 MP4 → 点击“播放” → 页面显示错误码 1009；浏览器控制台可见 TCPlayer MediaError。 |
| BUG-2 | 播放页没有播放事件上报逻辑/接口，直接访问播放页不会写入 `play_logs`；本次查询为 0 行。 | 高 | 记录视频日志数 → 访问 `/play?fileId=...` → 再查询日志，数量不变。 |
| BUG-3 | 视频删除功能未实现：无按钮、无 DELETE 路由，视频无法从管理后台删除。 | 高 | 打开视频列表查看操作列；调用 `DELETE /api/video/2` 得到 404。 |
| BUG-4 | 缩链域名仍为占位值，供应商返回“域名不存在”，无法生成 `platform='suolink'` 的记录。 | 高 | 选择缩链域名 → 生成短链；严格请求返回 HTTP 500 / `SUOLINK_PROVIDER_ERROR`。 |
| BUG-5 | 域名管理缺少新增和删除功能，仅支持列表与切换。 | 中 | 后台域名区域无新增/删除；POST/DELETE 域名接口均 404。 |
| BUG-6 | 过期视频的顶层 `/play` 文档仍返回 HTTP 200，只有内部 API 返回 410。 | 中 | 将 `expires_at` 改为过去 → 访问播放页 → 对比 Document 200 与 Fetch 410。 |
| BUG-7 | 上传页面没有标题输入框，只能把文件名作为标题，无法按操作要求填写自定义标题。 | 低 | 点击上传并选择文件，页面直接开始上传，无标题输入步骤。 |
| BUG-8 | `auto` 降级没有服务端 warning/error 日志，只有响应中的 `fallbackFrom` 可用于判断。 | 低 | 使用错误缩链 Key 调用 auto；检查 stdout/stderr，无供应商失败原因。 |

## 四、结论

- 是否通过验收：❌ 不通过
- 是否可以交付：❌ 不建议交付
- 主要阻断项：视频无法播放、播放日志未写入、视频删除缺失、第三方缩链不可用。
- 建议修复顺序：
  1. 修复 TCPlayer/VOD 播放配置并补齐 `start/progress/complete/error` 日志上报。
  2. 实现视频删除 UI、后端路由、腾讯云媒资删除与数据库状态/关联处理。
  3. 配置真实可用的缩链独享域名，并增加严格的供应商集成冒烟测试。
  4. 实现域名新增、删除、启停和校验接口及页面。
  5. 统一过期资源的顶层 HTTP 410 策略，并补充自定义标题输入。
  6. 为自动降级增加结构化告警日志，记录供应商错误码但不记录密钥。

## 五、测试后状态

- 原始主域名 ID 1 已恢复为唯一主域名。
- 临时域名 ID 2、3、其专用短链 ID 6 和日志 ID 4 已清理。
- 测试视频 ID 2、FileId `5001834815472845728` 仍保留并为 `ready`，因为系统没有删除功能；腾讯云过期时间仍为上传后 10 天。
- 保留 4 条测试视频短链用于复核，状态均恢复为 `active`。
- 临时错误 Key 后端进程已关闭。
