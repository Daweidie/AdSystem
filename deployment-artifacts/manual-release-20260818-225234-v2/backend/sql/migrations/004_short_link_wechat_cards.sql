-- 每条短链独立保存微信卡片信息；旧链 card_token 为空，界面提示重新生成。
ALTER TABLE short_links
  ADD COLUMN card_token VARCHAR(128) NULL COMMENT '微信卡片公开 token' AFTER provider_link_id,
  ADD COLUMN card_title VARCHAR(255) NULL COMMENT '短链专属卡片标题' AFTER card_token,
  ADD COLUMN card_description TEXT NULL COMMENT '短链专属卡片描述' AFTER card_title,
  ADD COLUMN card_cover_url VARCHAR(2048) NULL COMMENT '短链专属卡片封面' AFTER card_description,
  ADD COLUMN card_status ENUM('draft', 'ready') NOT NULL DEFAULT 'draft' COMMENT '卡片制作状态' AFTER card_cover_url,
  ADD UNIQUE KEY uk_short_links_card_token (card_token);
