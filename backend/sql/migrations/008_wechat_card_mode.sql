-- 微信卡片实验模式。只补字段，不改写历史短网址、封面或卡片内容。
SET @has_wechat_card_mode = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'short_links'
    AND COLUMN_NAME = 'wechat_card_mode'
);

SET @add_wechat_card_mode_sql = IF(
  @has_wechat_card_mode = 0,
  'ALTER TABLE short_links ADD COLUMN wechat_card_mode ENUM(''standard'', ''text_description'') NOT NULL DEFAULT ''standard'' COMMENT ''微信卡片模式'' AFTER card_status',
  'SELECT 1'
);

PREPARE add_wechat_card_mode_statement FROM @add_wechat_card_mode_sql;
EXECUTE add_wechat_card_mode_statement;
DEALLOCATE PREPARE add_wechat_card_mode_statement;

