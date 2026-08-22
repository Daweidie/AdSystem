-- 当前生产卡片域名。仅在不存在同名域名时补充，不切换主域名、不改写旧记录。
INSERT INTO domains
  (domain, type, platform, is_primary, is_enabled, remark)
SELECT 'https://vod.hotwharf.com', 'self_hosted', 'self', 0, 1,
       '/s/ 自建卡片公开域名'
WHERE NOT EXISTS (
  SELECT 1 FROM domains WHERE domain = 'https://vod.hotwharf.com'
);
