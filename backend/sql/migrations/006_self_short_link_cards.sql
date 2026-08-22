-- 为 /s/{shortCode} 自建卡片显式记录生成平台。脚本可重复执行，不修改链接 URL。
SET @has_short_links_platform = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'short_links'
    AND COLUMN_NAME = 'platform'
);
SET @add_short_links_platform_sql = IF(
  @has_short_links_platform = 0,
  'ALTER TABLE short_links ADD COLUMN platform ENUM(''self'', ''suolink'') NULL COMMENT ''短链生成平台'' AFTER domain_id',
  'SELECT 1'
);
PREPARE add_short_links_platform_statement FROM @add_short_links_platform_sql;
EXECUTE add_short_links_platform_statement;
DEALLOCATE PREPARE add_short_links_platform_statement;

UPDATE short_links sl
INNER JOIN domains d ON d.id = sl.domain_id
SET sl.platform = COALESCE(
  sl.platform,
  d.platform,
  CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
)
WHERE sl.platform IS NULL;

ALTER TABLE short_links
  MODIFY COLUMN platform ENUM('self', 'suolink') NOT NULL DEFAULT 'self'
  COMMENT '短链生成平台';

SET @has_short_links_platform_index = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'short_links'
    AND INDEX_NAME = 'idx_short_links_platform'
);
SET @add_short_links_platform_index_sql = IF(
  @has_short_links_platform_index = 0,
  'ALTER TABLE short_links ADD KEY idx_short_links_platform (platform)',
  'SELECT 1'
);
PREPARE add_short_links_platform_index_statement FROM @add_short_links_platform_index_sql;
EXECUTE add_short_links_platform_index_statement;
DEALLOCATE PREPARE add_short_links_platform_index_statement;
