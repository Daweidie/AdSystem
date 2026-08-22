-- 用于已执行过旧版 schema.sql 的数据库。
-- 执行前请先备份数据库；新安装项目直接执行 schema.sql 即可。

ALTER TABLE `videos`
  MODIFY COLUMN `status`
    ENUM('uploading', 'processing', 'ready', 'failed', 'disabled', 'expired', 'deleted')
    NOT NULL DEFAULT 'uploading' COMMENT '视频状态',
  ADD COLUMN `expires_at` DATETIME NULL COMMENT '视频业务及云端过期时间，默认上传完成后 3 天' AFTER `status`,
  ADD COLUMN `deleted_at` DATETIME NULL COMMENT '云端媒资删除完成时间' AFTER `expires_at`,
  ADD COLUMN `delete_error` VARCHAR(1000) NULL COMMENT '最近一次云端删除失败原因' AFTER `deleted_at`;

UPDATE `videos`
SET `expires_at` = DATE_ADD(`created_at`, INTERVAL 3 DAY)
WHERE `expires_at` IS NULL;

ALTER TABLE `videos`
  MODIFY COLUMN `expires_at` DATETIME NOT NULL COMMENT '视频业务及云端过期时间，默认上传完成后 3 天',
  ADD KEY `idx_videos_expiry_status` (`expires_at`, `status`);

ALTER TABLE `short_links`
  ADD COLUMN `clicks` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '累计点击次数' AFTER `provider_link_id`,
  ADD UNIQUE KEY `uk_short_links_code` (`short_code`);

CREATE TABLE IF NOT EXISTS `system_configs` (
  `config_key` VARCHAR(128) NOT NULL COMMENT '配置键',
  `config_value` VARCHAR(2048) NOT NULL COMMENT '配置值',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全局配置';
