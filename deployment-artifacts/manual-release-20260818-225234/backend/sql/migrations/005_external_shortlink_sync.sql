-- Worker 点击回写的幂等事件 ID；重复重试不会重复累计点击数。
ALTER TABLE play_logs
  ADD COLUMN external_event_id VARCHAR(64) NULL
    COMMENT '外部短链服务点击事件幂等 ID' AFTER session_id,
  ADD UNIQUE KEY uk_play_logs_external_event_id (external_event_id);
