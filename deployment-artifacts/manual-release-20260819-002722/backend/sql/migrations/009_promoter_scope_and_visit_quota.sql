-- 009_promoter_scope_and_visit_quota.sql
-- 1. short_links 记录创建人，用于推广员只看自己生成的短链与访问数据。
-- 2. 新增业务组月度访问量配额表（每月按 有效员工数 × 每员工额度 自动创建，管理员可追加额度）。
-- 3. 每员工月度访问额度默认值 2000，可在 系统设置-访问量管理 中调整。

ALTER TABLE `short_links`
  ADD COLUMN `created_by` BIGINT UNSIGNED NULL COMMENT '创建该短链的用户 ID（推广员数据隔离）' AFTER `video_id`,
  ADD KEY `idx_short_links_created_by` (`created_by`);

UPDATE `short_links` sl
INNER JOIN `videos` v ON v.id = sl.video_id
SET sl.created_by = v.created_by
WHERE sl.created_by IS NULL AND v.created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS `business_group_visit_quotas` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_group_id` BIGINT UNSIGNED NOT NULL,
  `period` CHAR(7) NOT NULL COMMENT '配额周期（北京时间自然月），格式 YYYY-MM',
  `base_quota` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '按有效员工数 × 每员工额度自动生成的月度基础访问量',
  `extra_quota` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '管理员手动增加的访问量',
  `used_quota` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本月已使用访问量',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_visit_quotas_group_period` (`business_group_id`, `period`),
  CONSTRAINT `fk_visit_quotas_group`
    FOREIGN KEY (`business_group_id`) REFERENCES `business_groups` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='业务组月度访问量配额';

INSERT IGNORE INTO `system_configs` (`config_key`, `config_value`)
VALUES ('visit_quota_per_employee', '2000');
