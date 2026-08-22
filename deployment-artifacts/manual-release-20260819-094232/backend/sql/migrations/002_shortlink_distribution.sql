-- 短链分发平台和访问设备统计。
-- 已有数据库升级前请先备份；新安装项目直接执行 schema.sql 即可。

ALTER TABLE `domains`
  ADD COLUMN `platform` ENUM('self', 'suolink') NULL
    COMMENT '短链服务平台' AFTER `type`;

UPDATE `domains`
SET `platform` = CASE WHEN `type` = 'suolink' THEN 'suolink' ELSE 'self' END
WHERE `platform` IS NULL;

ALTER TABLE `domains`
  MODIFY COLUMN `platform` ENUM('self', 'suolink') NOT NULL DEFAULT 'self'
    COMMENT '短链服务平台',
  ADD KEY `idx_domains_platform` (`platform`);

ALTER TABLE `play_logs`
  ADD COLUMN `device_type` ENUM('pc', 'mobile') NULL
    COMMENT '访问设备类型' AFTER `referer`,
  MODIFY COLUMN `event_type`
    ENUM('redirect', 'start', 'progress', 'complete', 'error')
    NOT NULL DEFAULT 'start' COMMENT '播放或跳转事件';

INSERT INTO `system_configs` (`config_key`, `config_value`)
SELECT 'shortlink_platform', `platform`
FROM `domains`
WHERE `is_primary` = 1
ORDER BY `id`
LIMIT 1
ON DUPLICATE KEY UPDATE `config_value` = VALUES(`config_value`);
