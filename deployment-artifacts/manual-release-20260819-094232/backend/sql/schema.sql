-- 视频广告资源管理系统基础表结构
-- MySQL 8.0+，业务代码统一使用 UTC 或明确配置的时区写入时间。

CREATE DATABASE IF NOT EXISTS `video_ad_db`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `video_ad_db`;

CREATE TABLE IF NOT EXISTS `videos` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `file_id` VARCHAR(128) NOT NULL COMMENT '腾讯云 VOD FileId',
  `title` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '视频标题',
  `description` TEXT NULL COMMENT '视频描述',
  `cover_url` VARCHAR(2048) NULL COMMENT '封面地址',
  `video_url` VARCHAR(2048) NULL COMMENT '原始或播放地址',
  `duration` DECIMAL(10, 3) UNSIGNED NULL COMMENT '视频时长（秒）',
  `business_group_id` BIGINT UNSIGNED NULL COMMENT '所属业务组',
  `material_group_id` BIGINT UNSIGNED NULL COMMENT '所属素材组',
  `created_by` BIGINT UNSIGNED NULL COMMENT '上传账号',
  `status` ENUM('uploading', 'processing', 'ready', 'failed', 'disabled', 'expired', 'deleted')
    NOT NULL DEFAULT 'uploading' COMMENT '视频状态',
  `expires_at` DATETIME NOT NULL COMMENT '视频业务及云端过期时间，默认上传完成后 3 天',
  `deleted_at` DATETIME NULL COMMENT '云端媒资删除完成时间',
  `delete_error` VARCHAR(1000) NULL COMMENT '最近一次云端删除失败原因',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_videos_file_id` (`file_id`),
  KEY `idx_videos_status` (`status`),
  KEY `idx_videos_expiry_status` (`expires_at`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='视频管理';

CREATE TABLE IF NOT EXISTS `domains` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `domain` VARCHAR(255) NOT NULL COMMENT '域名，不含路径',
  `type` ENUM('self_hosted', 'suolink') NOT NULL COMMENT '自建域名/第三方缩链域名',
  `platform` ENUM('self', 'suolink') NOT NULL DEFAULT 'self' COMMENT '短链服务平台',
  `is_primary` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否为当前主域名',
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  `remark` VARCHAR(500) NULL COMMENT '备注',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_domains_domain` (`domain`),
  KEY `idx_domains_primary_enabled` (`is_primary`, `is_enabled`),
  KEY `idx_domains_type` (`type`),
  KEY `idx_domains_platform` (`platform`),
  KEY `idx_domains_enabled_platform` (`is_enabled`, `platform`, `is_primary`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='域名管理';

CREATE TABLE IF NOT EXISTS `short_links` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `video_id` BIGINT UNSIGNED NOT NULL COMMENT '关联视频 ID',
  `created_by` BIGINT UNSIGNED NULL COMMENT '创建该短链的用户 ID（推广员数据隔离）',
  `domain_id` BIGINT UNSIGNED NOT NULL COMMENT '关联域名 ID',
  `platform` ENUM('self', 'suolink') NOT NULL DEFAULT 'self' COMMENT '短链生成平台',
  `short_code` VARCHAR(64) NOT NULL COMMENT '短链码',
  `long_url` VARCHAR(2048) NOT NULL COMMENT '原始长链接',
  `short_url` VARCHAR(2048) NULL COMMENT '最终短链接',
  `provider_link_id` VARCHAR(128) NULL COMMENT '第三方缩链平台记录 ID',
  `clicks` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '累计点击次数',
  `status` ENUM('active', 'disabled', 'expired') NOT NULL DEFAULT 'active',
  `expires_at` DATETIME NULL COMMENT '过期时间，为空表示不过期',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  `card_token` VARCHAR(128) NULL,
  `card_title` VARCHAR(255) NULL,
  `card_description` TEXT NULL,
  `card_cover_url` VARCHAR(2048) NULL,
  `card_status` ENUM('draft', 'ready') NOT NULL DEFAULT 'draft',
  `wechat_card_mode` ENUM('standard', 'text_description') NOT NULL DEFAULT 'standard' COMMENT '微信卡片模式',
  UNIQUE KEY `uk_short_links_domain_code` (`domain_id`, `short_code`),
  UNIQUE KEY `uk_short_links_code` (`short_code`),
  UNIQUE KEY `uk_short_links_card_token` (`card_token`),
  KEY `idx_short_links_video_id` (`video_id`),
  KEY `idx_short_links_created_by` (`created_by`),
  KEY `idx_short_links_platform` (`platform`),
  KEY `idx_short_links_status_expires` (`status`, `expires_at`),
  CONSTRAINT `fk_short_links_video`
    FOREIGN KEY (`video_id`) REFERENCES `videos` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_short_links_domain`
    FOREIGN KEY (`domain_id`) REFERENCES `domains` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='短链接';

CREATE TABLE IF NOT EXISTS `play_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `video_id` BIGINT UNSIGNED NOT NULL COMMENT '关联视频 ID',
  `short_link_id` BIGINT UNSIGNED NULL COMMENT '访问来源短链接 ID',
  `ip_address` VARCHAR(45) NULL COMMENT '客户端 IPv4/IPv6',
  `user_agent` TEXT NULL COMMENT '客户端 User-Agent',
  `referer` VARCHAR(2048) NULL COMMENT '来源页面',
  `device_type` ENUM('pc', 'mobile') NULL COMMENT '访问设备类型',
  `session_id` VARCHAR(128) NULL COMMENT '前端播放会话标识',
  `external_event_id` VARCHAR(64) NULL COMMENT '外部短链服务点击事件幂等 ID',
  `played_seconds` DECIMAL(10, 3) UNSIGNED NOT NULL DEFAULT 0 COMMENT '已播放秒数',
  `event_type` ENUM('redirect', 'start', 'progress', 'complete', 'error')
    NOT NULL DEFAULT 'start' COMMENT '播放事件',
  `played_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '事件发生时间',
  PRIMARY KEY (`id`),
  KEY `idx_play_logs_video_time` (`video_id`, `played_at`),
  KEY `idx_play_logs_short_link_time` (`short_link_id`, `played_at`),
  KEY `idx_play_logs_session_id` (`session_id`),
  UNIQUE KEY `uk_play_logs_external_event_id` (`external_event_id`),
  KEY `idx_play_logs_video_session_event_time` (`video_id`, `session_id`, `event_type`, `played_at`),
  CONSTRAINT `fk_play_logs_video`
    FOREIGN KEY (`video_id`) REFERENCES `videos` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_play_logs_short_link`
    FOREIGN KEY (`short_link_id`) REFERENCES `short_links` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='播放日志';

CREATE TABLE IF NOT EXISTS `system_configs` (
  `config_key` VARCHAR(128) NOT NULL COMMENT '配置键',
  `config_value` VARCHAR(2048) NOT NULL COMMENT '配置值',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全局配置';

CREATE TABLE IF NOT EXISTS `business_groups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL,
  `manager_user_id` BIGINT UNSIGNED NULL,
  `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  `expires_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_business_groups_name` (`name`),
  KEY `idx_business_groups_status_expiry` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='业务组';

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `password_salt` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(128) NOT NULL,
  `role` ENUM('super_admin', 'system_admin', 'business_manager', 'general_user') NOT NULL,
  `business_group_id` BIGINT UNSIGNED NULL,
  `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  `expires_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_phone` (`phone`),
  KEY `idx_users_group_role` (`business_group_id`, `role`),
  KEY `idx_users_status_expiry` (`status`, `expires_at`),
  CONSTRAINT `fk_users_business_group`
    FOREIGN KEY (`business_group_id`) REFERENCES `business_groups` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台账号';

CREATE TABLE IF NOT EXISTS `material_groups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_group_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_material_groups_business_name` (`business_group_id`, `name`),
  KEY `idx_material_groups_business_enabled` (`business_group_id`, `is_enabled`),
  CONSTRAINT `fk_material_groups_business_group`
    FOREIGN KEY (`business_group_id`) REFERENCES `business_groups` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='素材组';

-- domains.is_primary 的“只能有一个”约束建议在切换主域名时通过事务和行锁保证。

CREATE TABLE IF NOT EXISTS `business_group_visit_quotas` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_group_id` BIGINT UNSIGNED NOT NULL,
  `period` CHAR(7) NOT NULL COMMENT '配额周期（北京时间自然月），格式 YYYY-MM',
  `base_quota` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '按有效员工数 × 每员工额度自动生成的月度基础访问量',
  `extra_quota` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '管理员在“访问量管理”中手动增加的访问量',
  `used_quota` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本月已使用访问量',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_visit_quotas_group_period` (`business_group_id`, `period`),
  CONSTRAINT `fk_visit_quotas_group`
    FOREIGN KEY (`business_group_id`) REFERENCES `business_groups` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='业务组月度访问量配额';
