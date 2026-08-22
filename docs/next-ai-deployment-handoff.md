# demo18 下一位 AI 部署交接

更新时间：2026-08-18（Asia/Shanghai）

## 当前结论

- 本地额度修复代码已经完成，并已手工部署到 `49.232.124.39`。
- 线上 PM2、Nginx、前后端健康检查均通过。
- 线上真实业务组管理员的额度读写验收尚未完成：仓库 README 中的演示密码登录服务器返回 `401`。不能因此宣称额度功能已最终验收完成。
- 不要重做已经完成的构建和部署；优先完成真实账号验收，或明确记录凭据不可用这一阻塞原因。

## 项目与服务器

- 本地目录：`C:\Users\popol\Desktop\Projects\demo18`
- 服务器：`ubuntu@49.232.124.39`
- 应用目录：`/var/www/demo18`
- 后端 PM2：`demo18-backend`，监听 `3001`
- Nginx 配置：`/etc/nginx/sites-available/demo18.conf`
- SSH host key：`SHA256:O97HXntOalf/Icc2k346jVopuy3dJI18jLudJkykEf8`
- SSH 密码：^J#D6h/;|5d82T~b

必须使用：`deployment-artifacts/plink.exe`、`deployment-artifacts/pscp.exe`，并带 `-batch -hostkey`。禁止执行仓库中的 `deploy.sh`、`demo18-remote-deploy.sh` 或任何自动部署脚本。

## 已完成修改

核心文件：

- `backend/src/controllers/managementController.js`
  - `super_admin`、`system_admin` 可管理任意业务组。
  - `business_manager` 只能使用认证上下文中的 `business_group_id`。
  - 请求体篡改其他 `businessGroupId` 返回 `403 PERMISSION_DENIED`。
  - 参数和当前月立即生效提示已明确。
- `backend/src/routes/managementRoutes.js`
  - `/management/visit-quota/add`、`/management/visit-quota/base` 允许业务组管理员访问，但仍由控制器做作用域校验。
  - 平台级 `/management/visit-quotas` 和 `/management/visit-quotas/per-employee` 仅平台管理员可用。
- `frontend/src/views/Admin.vue`
  - “我的素材列表”显示当前自然月基础、额外、总额、已用和剩余额度。
  - 业务组管理员看到两个独立控件：增加本月额外额度、修改本月基础额度；两者均标注“立即生效”。
  - 平台级“每位有效推广员月度额度”明确标注“下月生效”。
  - 系统管理员可进入访问量管理页面。
- `frontend/src/styles/main.css`
  - 已有 `business-quota-actions` 和访问量管理页面样式。
- `backend/test/quota-management.test.js`
  - 已覆盖平台管理员、业务组管理员自有组、跨组 `403`、一般推广员写入拒绝、非法数字和事务数值一致性。

同域名逻辑未改动：自建短链继续使用当前自建主域名，Suolink 使用配置域名并保留故障备用域名。

## 本地验证结果

在 `backend`：

```text
npm test       55/55 passed
npm run build  passed
```

在 `frontend`：

```text
npm run build  passed
```

本地测试中清理过一次明确的自动化测试残留域名/视频/短链；没有重置业务数据。

## 已执行的线上部署

备份目录：

```text
/var/backups/demo18/20260818-225234/application
/var/backups/demo18/20260818-225234/demo18.conf
/var/backups/demo18/20260818-225234/database.sql.gz
```

数据库备份文件权限为 `600`。线上 `.env` 未上传覆盖，`backend/uploads/` 未覆盖；同步前后 `.env` 大小和 uploads 文件数一致。

发布包（可复查，不含 `.env`、`uploads`、`node_modules`、测试目录）：

```text
deployment-artifacts/manual-release-20260818-225234-v2.tar.gz
```

服务器临时解包目录：

```text
/tmp/demo18-release-20260818-225234-v2
```

服务器已执行生产依赖安装和前后端构建；未执行数据库迁移，因为现有表结构已经包含所需字段，且本次没有 schema 变更。

## 已通过的线上检查

- `sudo nginx -t`：成功。
- `sudo systemctl reload nginx`：已执行。
- `sudo pm2 restart demo18-backend --update-env`：成功。
- `sudo pm2 save`：成功。
- `sudo pm2 status demo18-backend`：`online`，单实例。
- `curl http://127.0.0.1:3001/health`：`200`，`success=true`。
- `curl http://49.232.124.39/health`：`200`，`success=true`。
- `curl -I http://49.232.124.39/`：`HTTP/1.1 200 OK`。
- 线上 `.env` 权限：`600`。
- 线上 `backend/uploads/` 权限：`750`。

重启后 PM2 日志显示正常启动 `API server listening on http://localhost:3001`。旧日志中的登录失败、未授权和 Suolink fallback 是此前验收记录，不要误判为本次重启错误；重启后没有新的启动异常。

## 尚未完成的必须验收

服务器现有用户：

```text
13800000001  super_admin       business_group_id NULL
13800000002  system_admin      business_group_id NULL
13800000003  business_manager  business_group_id 1
13800000004  general_user      business_group_id 1
19293327894  business_manager  business_group_id 2
19273840522  general_user      business_group_id 2
18638271192  general_user      business_group_id 2
```

用 README 中的 `13800000003 / Demo123!` 登录线上返回 `401`，说明生产密码已不同。不要重复弱口令尝试，也不要直接改数据库密码；应使用用户提供的真实业务组管理员凭据，或让用户明确授权重置某个测试账号密码。

拿到真实凭据后，必须按以下顺序验收，并记录响应 JSON 和数据库前后值：

1. 业务组管理员登录，调用 `GET /api/management/visit-quota`。
2. `POST /api/management/visit-quota/add`，只传 `additionalQuota`，确认 `extraQuota` 和 `remainingQuota` 立即增加。
3. `PUT /api/management/visit-quota/base`，只传 `baseQuota`，确认 `baseQuota` 和 `remainingQuota` 立即变化。
4. 同一管理员带其他 `businessGroupId` 调写入接口，必须返回 `403`，数据库其他组不变。
5. 一般推广员调用两个写入接口，必须返回 `403`。
6. 超级管理员和系统管理员分别读取并修改任意业务组，确认成功。
7. 浏览器强制刷新 `http://49.232.124.39/`，进入“我的素材列表”，确认控件出现、提交成功提示写明“立即生效”、数字立即刷新。

额度计算必须满足：

```text
total = base_quota + extra_quota
remaining = max(total - used_quota, 0)
```

## 回滚方法

不要删除现有备份。回滚前先停止 PM2，恢复应用目录中的代码（保留生产 `.env` 和 `backend/uploads/`），必要时恢复 Nginx 配置和数据库：

```text
/var/backups/demo18/20260818-225234/application
/var/backups/demo18/20260818-225234/demo18.conf
/var/backups/demo18/20260818-225234/database.sql.gz
```

恢复后执行：

```text
sudo nginx -t
sudo systemctl reload nginx
sudo pm2 restart demo18-backend --update-env
sudo pm2 save
```

不要使用 `git reset --hard`、`git checkout --`、全量删除 `/var/www/demo18`，也不要创建第二个 PM2 实例。

## 下一位 AI 的结束条件

只有真实业务组管理员、平台管理员和一般推广员三类线上请求均按上面结果通过，并且数据库前后数值可复核，才能向用户报告“额度功能已真正修好并完成部署”。如果没有真实凭据，最终报告必须明确写“代码已部署、真实账号额度验收未完成”，不能只用健康检查代替功能验收。
