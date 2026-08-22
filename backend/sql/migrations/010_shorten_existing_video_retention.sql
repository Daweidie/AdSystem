-- 将历史视频的业务到期时间统一收敛到创建时间后 3 天。
-- 幂等执行；已删除视频不再修改，访问日志与短链记录不受影响。
UPDATE `videos`
SET `expires_at` = LEAST(
  COALESCE(`expires_at`, DATE_ADD(`created_at`, INTERVAL 3 DAY)),
  DATE_ADD(`created_at`, INTERVAL 3 DAY)
)
WHERE `status` <> 'deleted'
  AND (`expires_at` IS NULL OR `expires_at` > DATE_ADD(`created_at`, INTERVAL 3 DAY));
