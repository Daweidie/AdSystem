-- 播放事件上报查询索引。脚本可重复执行，不删除或重写现有数据。
SET @has_playback_event_index = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'play_logs'
    AND INDEX_NAME = 'idx_play_logs_video_session_event_time'
);
SET @playback_event_index_sql = IF(
  @has_playback_event_index = 0,
  'ALTER TABLE play_logs ADD KEY idx_play_logs_video_session_event_time (video_id, session_id, event_type, played_at)',
  'SELECT 1'
);
PREPARE playback_event_index_statement FROM @playback_event_index_sql;
EXECUTE playback_event_index_statement;
DEALLOCATE PREPARE playback_event_index_statement;

SET @has_domain_lookup_index = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'domains'
    AND INDEX_NAME = 'idx_domains_enabled_platform'
);
SET @domain_lookup_index_sql = IF(
  @has_domain_lookup_index = 0,
  'ALTER TABLE domains ADD KEY idx_domains_enabled_platform (is_enabled, platform, is_primary)',
  'SELECT 1'
);
PREPARE domain_lookup_index_statement FROM @domain_lookup_index_sql;
EXECUTE domain_lookup_index_statement;
DEALLOCATE PREPARE domain_lookup_index_statement;
