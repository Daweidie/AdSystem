# 部署前自检清单

| 序号 | 检查项 | 验证方法 | 预期结果 |
| --- | --- | --- | --- |
| 1 | 前端启动 | 在 `frontend` 执行 `npm install && npm run dev`，打开 `/play` 和 `/admin`。 | 服务监听 5173；无 `fileId` 的播放页显示友好提示，后台页面可渲染。 |
| 2 | 后端启动 | 在 `backend` 执行 `npm install && npm run dev`，请求 `GET /health`。 | HTTP 200，返回 `success: true` 和 `message: "ok"`。 |
| 3 | 数据库备份与迁移 | 配好 `backend/.env`，先用 `mysqldump --single-transaction` 备份，再执行 `npm run migrate`。 | 备份文件非空；迁移幂等成功；`short_links.platform` 和唯一索引存在。 |
| 4 | 上传视频到 VOD | 打开 `/admin` 选择一个可公开测试的小视频，观察上传进度和列表。 | 进度到 100%，列表出现对应 `fileId`，状态最终为“可播放”，过期时间约为上传后 3 天。 |
| 5 | 生成并打开播放链接 | 点击该视频的“播放”，或打开 `/play?fileId=<列表中的fileId>`。 | 播放器容器出现，视频能开始播放；网络面板中的视频信息接口返回 200。 |
| 6 | 生成可选平台短链 | 在视频操作栏分别选择“生成自建 /s/ 链接”或“生成 Suolink 链接”，并粘贴剪贴板内容核对。 | 自建接口返回 `/s/{6-8位Base62}`；Suolink 接口明确使用 `platform=suolink` 且失败时不回退。 |
| 7 | 卡片与直接播放 | 用 `curl -i` 和微信 UA 抓取新短链，再在浏览器打开。 | `/s/` 返回 HTTP 200、`text/html; charset=UTF-8` 和完整 OG；没有 301/302、裸 `/play` 或 `window.location.replace`；浏览器自动解码 Base64 目标进入带 `shortLinkId` 的播放页。 |
| 8 | Nginx 路由 | 执行 `nginx -t`，再通过生产域名请求 `/s/{shortCode}`。 | 配置检查成功；请求由 Express 返回卡片 HTML，不是 Vue 首页。 |
| 9 | 3 天过期失效 | 先确认 `expires_at` 为上传后 3 天；加速测试只使用可删除的测试视频，把其 `expires_at` 改为过去时间并重启后端。 | 播放接口与 `/s/` 返回 410；停用的 `/s/` 返回 404；清理任务将 VOD 测试媒资删除或记录删除失败原因。 |

> 第 9 项会删除腾讯云中的测试媒资，只能使用专门用于验收、可被删除的视频。
