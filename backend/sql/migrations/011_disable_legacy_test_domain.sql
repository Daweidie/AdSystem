-- 旧测试域名不再接收新短链；历史短链记录保留，便于审计和人工迁移。
UPDATE domains
SET is_enabled = 0,
    is_primary = 0
WHERE domain IN (
  'https://vod.hotwharf.com',
  'https://m1.zzqixiangkeji.cn',
  'https://m2.zzqixiangkeji.cn'
)
  AND COALESCE(platform, CASE WHEN type = 'suolink' THEN 'suolink' ELSE 'self' END) = 'self';
