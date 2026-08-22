-- 视频广告资源管理系统：可重复执行的完整初始化入口。
-- 从项目根目录执行：mysql -u root -p < backend/sql/init_video_ad_db.sql

SOURCE backend/sql/schema.sql;

USE `video_ad_db`;

INSERT INTO `domains`
  (`domain`, `type`, `platform`, `is_primary`, `is_enabled`, `remark`)
VALUES
  ('http://localhost:3001/api/short', 'self_hosted', 'self', 0, 1, '本地测试默认域名')
ON DUPLICATE KEY UPDATE
  `type` = VALUES(`type`),
  `platform` = VALUES(`platform`),
  `is_enabled` = VALUES(`is_enabled`),
  `remark` = VALUES(`remark`);

-- 仅在当前没有主域名时将本地域名设为主域名，避免覆盖已有选择。
UPDATE `domains`
SET `is_primary` = 1
WHERE `domain` = 'http://localhost:3001/api/short'
  AND NOT EXISTS (
    SELECT 1
    FROM (SELECT `id` FROM `domains` WHERE `is_primary` = 1) AS `current_primary`
  );

INSERT INTO `system_configs` (`config_key`, `config_value`)
SELECT 'primary_domain_id', CAST(`id` AS CHAR)
FROM `domains`
WHERE `is_primary` = 1
ORDER BY `id`
LIMIT 1
ON DUPLICATE KEY UPDATE
  `config_value` = VALUES(`config_value`);

INSERT INTO `system_configs` (`config_key`, `config_value`)
SELECT 'shortlink_platform', `platform`
FROM `domains`
WHERE `is_primary` = 1
ORDER BY `id`
LIMIT 1
ON DUPLICATE KEY UPDATE
  `config_value` = VALUES(`config_value`);
