# m1/m2 域名被错误添加 www：排查与修复记录

时间：2026-08-21（Asia/Shanghai）

## 结论

应用没有添加 `www`。数据库中保存的地址以及已经生成的落地地址均为
`https://m1.zzqixiangkeji.cn`。错误跳转发生在源站之前的 CDN：

```text
m1.zzqixiangkeji.cn
  CNAME all.zzqixiangkeji.cn.w.kunlunaq.com
  -> HTTP 301 Location: http://www.m1.zzqixiangkeji.cn/
```

权威 DNS 还对任意未显式配置的子域返回相同 CNAME，因此
`m2.zzqixiangkeji.cn` 也存在同样问题。`www.m1.zzqixiangkeji.cn` 没有对应的
CDN 站点和 TLS 配置，跳转后会出现 403 或 TLS 握手失败。

源站配置正常。绕过 DNS 直连 `49.232.124.39`，并使用
`m1.zzqixiangkeji.cn` 作为 Host/SNI 时，HTTP 跳转到同名 HTTPS，HTTPS
返回 200，不会添加 `www`。

## 已执行止损

生产数据库中以下非主域名已停用，避免新链接继续使用错误域名：

```text
17  https://m1.zzqixiangkeji.cn  is_enabled=0
18  https://m2.zzqixiangkeji.cn  is_enabled=0
```

主域名 `https://vod.zzqixiangkeji.cn`（ID 13）保持启用。停用操作没有删除
域名、短链或业务数据。

## DNS 修复

在 `zzqixiangkeji.cn` 当前权威 DNS 控制台为 `m1` 新增显式记录，覆盖泛解析：

```text
m1  A  49.232.124.39
```

不要配置到 `www.m1`，也不要继续指向
`all.zzqixiangkeji.cn.w.kunlunaq.com`。若必须保留 CDN，则应在 CDN 控制台
为 `m1` 创建独立站点，源站设为 `49.232.124.39`，删除“自动添加 www”跳转规则，
并配置 HTTPS；两种修复方案二选一。

`m2` 当前没有源站 Nginx 站点和匹配证书，直接添加 `m2 A 49.232.124.39` 会导致
TLS 校验失败。因此它应保持停用；只有在新增 `m2` 的 Nginx server block、签发并安装
`m2.zzqixiangkeji.cn` 证书后，才可添加对应 A 记录并重新启用。

## 验证与恢复

DNS 生效后执行：

```powershell
Resolve-DnsName m1.zzqixiangkeji.cn -Type A -DnsOnly
curl.exe -sS -o NUL -D - https://m1.zzqixiangkeji.cn/
curl.exe -sS -o NUL -D - https://m1.zzqixiangkeji.cn/health
```

恢复标准：解析结果为 `49.232.124.39`；根路径与 `/health` 均不出现跨主机
`Location`；HTTPS 证书校验成功；根路径返回 200，`/health` 返回 JSON 200。
全部通过后，才能在域名池重新启用 ID 17。ID 18 保持停用，直至其源站配置完整。

## 2026-08-21 正式域名切换

进一步排查发现生产后端 `.env` 仍保留旧测试公共地址：

```text
FRONTEND_URL=https://vod.hotwharf.com
PLAY_PAGE_BASE_URL=https://vod.hotwharf.com
PUBLIC_SHORTLINK_BASE_URL=https://vod.hotwharf.com
```

这会使新生成的卡片目标和自建播放地址继续使用 `vod.hotwharf.com`，与域名池当前
配置不一致。已备份线上 `.env` 至：

```text
/var/backups/demo18/domain-config-20260821-175732.env
```

并将以下公共地址统一切换为 `https://vod.zzqixiangkeji.cn`：

```text
FRONTEND_URL
PLAY_PAGE_BASE_URL
PUBLIC_SHORTLINK_BASE_URL
PUBLIC_CARD_BASE_URL
PUBLIC_PLAY_BASE_URL
```

后端已重启，健康检查通过；运行时诊断为 `status=ok`，卡片公共地址与启用的 self
域名均为 `https://vod.zzqixiangkeji.cn`。旧测试 self 域名
`https://vod.hotwharf.com` 已停用，历史短链不改写；需要正式域名的素材应重新生成新短链。
