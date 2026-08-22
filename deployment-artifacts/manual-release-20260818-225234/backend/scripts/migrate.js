const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const { hashPassword } = require('../src/services/authService');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function requireConfig(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }

  return value;
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function columnExists(connection, database, table, column) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [database, table, column],
  );
  return rows.length > 0;
}

async function indexExists(connection, database, table, index) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
     LIMIT 1`,
    [database, table, index],
  );
  return rows.length > 0;
}

async function constraintExists(connection, database, table, constraint) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [database, table, constraint],
  );
  return rows.length > 0;
}

async function upgradeExistingTables(connection, database) {
  if (!(await columnExists(connection, database, 'videos', 'business_group_id'))) {
    await connection.query(
      `ALTER TABLE videos ADD COLUMN business_group_id BIGINT UNSIGNED NULL
       COMMENT '所属业务组' AFTER duration`,
    );
  }
  if (!(await columnExists(connection, database, 'videos', 'material_group_id'))) {
    await connection.query(
      `ALTER TABLE videos ADD COLUMN material_group_id BIGINT UNSIGNED NULL
       COMMENT '所属素材组' AFTER business_group_id`,
    );
  }
  if (!(await columnExists(connection, database, 'videos', 'created_by'))) {
    await connection.query(
      `ALTER TABLE videos ADD COLUMN created_by BIGINT UNSIGNED NULL
       COMMENT '上传账号' AFTER material_group_id`,
    );
  }
  if (!(await indexExists(connection, database, 'videos', 'idx_videos_business_group'))) {
    await connection.query('ALTER TABLE videos ADD KEY idx_videos_business_group (business_group_id)');
  }
  if (!(await indexExists(connection, database, 'videos', 'idx_videos_material_group'))) {
    await connection.query('ALTER TABLE videos ADD KEY idx_videos_material_group (material_group_id)');
  }
  if (!(await constraintExists(connection, database, 'videos', 'fk_videos_business_group'))) {
    await connection.query(
      `ALTER TABLE videos ADD CONSTRAINT fk_videos_business_group
       FOREIGN KEY (business_group_id) REFERENCES business_groups(id)
       ON UPDATE CASCADE ON DELETE SET NULL`,
    );
  }
  if (!(await constraintExists(connection, database, 'videos', 'fk_videos_material_group'))) {
    await connection.query(
      `ALTER TABLE videos ADD CONSTRAINT fk_videos_material_group
       FOREIGN KEY (material_group_id) REFERENCES material_groups(id)
       ON UPDATE CASCADE ON DELETE SET NULL`,
    );
  }
  if (!(await constraintExists(connection, database, 'videos', 'fk_videos_created_by'))) {
    await connection.query(
      `ALTER TABLE videos ADD CONSTRAINT fk_videos_created_by
       FOREIGN KEY (created_by) REFERENCES users(id)
       ON UPDATE CASCADE ON DELETE SET NULL`,
    );
  }
  if (!(await columnExists(connection, database, 'videos', 'expires_at'))) {
    await connection.query(
      `ALTER TABLE videos
       ADD COLUMN expires_at DATETIME NULL
       COMMENT '视频业务及云端过期时间，默认上传完成后 3 天'
       AFTER status`,
    );
  }

  if (!(await columnExists(connection, database, 'videos', 'deleted_at'))) {
    await connection.query(
      `ALTER TABLE videos
       ADD COLUMN deleted_at DATETIME NULL COMMENT '云端媒资删除完成时间'
       AFTER expires_at`,
    );
  }

  if (!(await columnExists(connection, database, 'videos', 'delete_error'))) {
    await connection.query(
      `ALTER TABLE videos
       ADD COLUMN delete_error VARCHAR(1000) NULL
       COMMENT '最近一次云端删除失败原因'
       AFTER deleted_at`,
    );
  }

  await connection.query(
    `ALTER TABLE videos
     MODIFY COLUMN status
       ENUM('uploading', 'processing', 'ready', 'failed', 'disabled', 'expired', 'deleted')
       NOT NULL DEFAULT 'uploading' COMMENT '视频状态'`,
  );
  await connection.query(
    `UPDATE videos
     SET expires_at = LEAST(
       COALESCE(expires_at, DATE_ADD(created_at, INTERVAL 3 DAY)),
       DATE_ADD(created_at, INTERVAL 3 DAY)
     )
     WHERE status <> 'deleted'
       AND (expires_at IS NULL OR expires_at > DATE_ADD(created_at, INTERVAL 3 DAY))`,
  );
  await connection.query(
    `ALTER TABLE videos
     MODIFY COLUMN expires_at DATETIME NOT NULL
     COMMENT '视频业务及云端过期时间，默认上传完成后 3 天'`,
  );

  if (!(await indexExists(connection, database, 'videos', 'idx_videos_expiry_status'))) {
    await connection.query(
      'ALTER TABLE videos ADD KEY idx_videos_expiry_status (expires_at, status)',
    );
  }

  if (!(await columnExists(connection, database, 'short_links', 'clicks'))) {
    await connection.query(
      `ALTER TABLE short_links
       ADD COLUMN clicks BIGINT UNSIGNED NOT NULL DEFAULT 0
       COMMENT '累计点击次数'
       AFTER provider_link_id`,
    );
  }

  if (!(await columnExists(connection, database, 'short_links', 'platform'))) {
    await connection.query(
      `ALTER TABLE short_links
       ADD COLUMN platform ENUM('self', 'suolink') NULL
       COMMENT '短链生成平台' AFTER domain_id`,
    );
  }
  await connection.query(
    `UPDATE short_links sl
     INNER JOIN domains d ON d.id = sl.domain_id
     SET sl.platform = CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
     WHERE sl.platform IS NULL`,
  );
  await connection.query(
    `ALTER TABLE short_links
     MODIFY COLUMN platform ENUM('self', 'suolink') NOT NULL DEFAULT 'self'
     COMMENT '短链生成平台'`,
  );
  if (!(await indexExists(connection, database, 'short_links', 'idx_short_links_platform'))) {
    await connection.query(
      'ALTER TABLE short_links ADD KEY idx_short_links_platform (platform)',
    );
  }

  if (!(await columnExists(connection, database, 'short_links', 'created_by'))) {
    await connection.query(
      `ALTER TABLE short_links
       ADD COLUMN created_by BIGINT UNSIGNED NULL
       COMMENT '创建该短链的用户 ID（推广员数据隔离）' AFTER video_id`,
    );
  }
  if (!(await indexExists(connection, database, 'short_links', 'idx_short_links_created_by'))) {
    await connection.query(
      'ALTER TABLE short_links ADD KEY idx_short_links_created_by (created_by)',
    );
  }
  await connection.query(
    `UPDATE short_links sl
     INNER JOIN videos v ON v.id = sl.video_id
     SET sl.created_by = v.created_by
     WHERE sl.created_by IS NULL AND v.created_by IS NOT NULL`,
  );

  await connection.query(
    `CREATE TABLE IF NOT EXISTS business_group_visit_quotas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      business_group_id BIGINT UNSIGNED NOT NULL,
      period CHAR(7) NOT NULL COMMENT '配额周期（北京时间自然月），格式 YYYY-MM',
      base_quota INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '按有效员工数 × 每员工额度自动生成的月度基础访问量',
      extra_quota INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '管理员手动增加的访问量',
      used_quota INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本月已使用访问量',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_visit_quotas_group_period (business_group_id, period),
      CONSTRAINT fk_visit_quotas_group
        FOREIGN KEY (business_group_id) REFERENCES business_groups(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='业务组月度访问量配额'`,
  );
  await connection.query(
    `INSERT IGNORE INTO system_configs (config_key, config_value)
     VALUES ('visit_quota_per_employee', '2000')`,
  );

  const cardColumns = [
    ['card_token', "VARCHAR(128) NULL COMMENT '微信卡片公开 token' AFTER provider_link_id"],
    ['card_title', "VARCHAR(255) NULL COMMENT '短链专属卡片标题' AFTER card_token"],
    ['card_description', "TEXT NULL COMMENT '短链专属卡片描述' AFTER card_title"],
    ['card_cover_url', "VARCHAR(2048) NULL COMMENT '短链专属卡片封面' AFTER card_description"],
    ['card_status', "ENUM('draft', 'ready') NOT NULL DEFAULT 'draft' COMMENT '卡片制作状态' AFTER card_cover_url"],
  ];
  for (const [column, definition] of cardColumns) {
    if (!(await columnExists(connection, database, 'short_links', column))) {
      await connection.query(`ALTER TABLE short_links ADD COLUMN ${column} ${definition}`);
    }
  }
  if (!(await columnExists(connection, database, 'short_links', 'wechat_card_mode'))) {
    await connection.query(
      `ALTER TABLE short_links
       ADD COLUMN wechat_card_mode ENUM('standard', 'text_description')
       NOT NULL DEFAULT 'standard' COMMENT '微信卡片模式' AFTER card_status`,
    );
  }
  if (!(await indexExists(connection, database, 'short_links', 'uk_short_links_card_token'))) {
    await connection.query(
      'ALTER TABLE short_links ADD UNIQUE KEY uk_short_links_card_token (card_token)',
    );
  }

  if (!(await indexExists(connection, database, 'short_links', 'uk_short_links_code'))) {
    await connection.query(
      'ALTER TABLE short_links ADD UNIQUE KEY uk_short_links_code (short_code)',
    );
  }

  if (!(await columnExists(connection, database, 'domains', 'platform'))) {
    await connection.query(
      `ALTER TABLE domains
       ADD COLUMN platform ENUM('self', 'suolink') NULL
       COMMENT '短链服务平台' AFTER type`,
    );
  }

  await connection.query(
    `UPDATE domains
     SET platform = CASE WHEN type = 'suolink' THEN 'suolink' ELSE 'self' END
     WHERE platform IS NULL`,
  );
  await connection.query(
    `ALTER TABLE domains
     MODIFY COLUMN platform ENUM('self', 'suolink') NOT NULL DEFAULT 'self'
     COMMENT '短链服务平台'`,
  );

  if (!(await indexExists(connection, database, 'domains', 'idx_domains_platform'))) {
    await connection.query(
      'ALTER TABLE domains ADD KEY idx_domains_platform (platform)',
    );
  }

  if (!(await indexExists(connection, database, 'domains', 'idx_domains_enabled_platform'))) {
    await connection.query(
      `ALTER TABLE domains
       ADD KEY idx_domains_enabled_platform (is_enabled, platform, is_primary)`,
    );
  }

  if (!(await columnExists(connection, database, 'play_logs', 'device_type'))) {
    await connection.query(
      `ALTER TABLE play_logs
       ADD COLUMN device_type ENUM('pc', 'mobile') NULL
       COMMENT '访问设备类型' AFTER referer`,
    );
  }

  if (!(await columnExists(connection, database, 'play_logs', 'external_event_id'))) {
    await connection.query(
      `ALTER TABLE play_logs
       ADD COLUMN external_event_id VARCHAR(64) NULL
       COMMENT '外部短链服务点击事件幂等 ID' AFTER session_id`,
    );
  }

  if (!(await indexExists(connection, database, 'play_logs', 'uk_play_logs_external_event_id'))) {
    await connection.query(
      `ALTER TABLE play_logs
       ADD UNIQUE KEY uk_play_logs_external_event_id (external_event_id)`,
    );
  }

  await connection.query(
    `ALTER TABLE play_logs
     MODIFY COLUMN event_type
       ENUM('redirect', 'start', 'progress', 'complete', 'error')
       NOT NULL DEFAULT 'start' COMMENT '播放或跳转事件'`,
  );

  if (
    !(await indexExists(
      connection,
      database,
      'play_logs',
      'idx_play_logs_video_session_event_time',
    ))
  ) {
    await connection.query(
      `ALTER TABLE play_logs
       ADD KEY idx_play_logs_video_session_event_time
         (video_id, session_id, event_type, played_at)`,
    );
  }
  await connection.query(
    `INSERT INTO system_configs (config_key, config_value)
     SELECT 'shortlink_platform', platform
     FROM domains
     WHERE is_primary = 1
     ORDER BY id
     LIMIT 1
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
  );
}

async function seedDemoAccounts(connection) {
  await connection.execute(
    `INSERT INTO business_groups (name, status, expires_at)
     VALUES ('默认业务组', 'active', DATE_ADD(NOW(), INTERVAL 1 YEAR))
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
  );
  const [[group]] = await connection.execute(
    `SELECT id FROM business_groups WHERE name = '默认业务组' LIMIT 1`,
  );
  await connection.execute(
    `INSERT INTO material_groups (business_group_id, name, is_enabled)
     VALUES (?, '默认素材组', 1)
     ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
    [group.id],
  );
  const [[materialGroup]] = await connection.execute(
    `SELECT id FROM material_groups WHERE business_group_id = ? AND name = '默认素材组' LIMIT 1`,
    [group.id],
  );

  const demos = [
    ['超级管理员', '13800000001', 'super_admin', null],
    ['系统管理员', '13800000002', 'system_admin', null],
    ['业务组管理员', '13800000003', 'business_manager', group.id],
    ['普通用户', '13800000004', 'general_user', group.id],
  ];
  let managerId = null;

  for (const [name, phone, role, businessGroupId] of demos) {
    const credentials = hashPassword('Demo123!');
    await connection.execute(
      `INSERT INTO users
         (name, phone, password_salt, password_hash, role, business_group_id, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL 1 YEAR))
       ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role),
         business_group_id = VALUES(business_group_id), status = 'active'`,
      [name, phone, credentials.salt, credentials.hash, role, businessGroupId],
    );
    if (role === 'business_manager') {
      const [[manager]] = await connection.execute('SELECT id FROM users WHERE phone = ? LIMIT 1', [phone]);
      managerId = manager.id;
    }
  }

  await connection.execute('UPDATE business_groups SET manager_user_id = ? WHERE id = ?', [managerId, group.id]);
  await connection.execute(
    `UPDATE videos SET business_group_id = COALESCE(business_group_id, ?),
                       material_group_id = COALESCE(material_group_id, ?)
     WHERE status <> 'deleted'`,
    [group.id, materialGroup.id],
  );
}

async function seedPrimaryDomain(connection) {
  const [[countRow]] = await connection.execute('SELECT COUNT(*) AS total FROM domains');
  if (Number(countRow.total) > 0) return;

  const configuredBase = process.env.PUBLIC_SHORTLINK_BASE_URL?.trim();
  if (!configuredBase) return;

  let url;
  try {
    url = new URL(configuredBase);
  } catch {
    throw new Error('PUBLIC_SHORTLINK_BASE_URL 必须是有效的 http/https 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_SHORTLINK_BASE_URL 仅支持 http/https');
  }

  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  await connection.execute(
    `INSERT INTO domains
       (domain, type, platform, is_primary, is_enabled, remark)
     VALUES (?, 'self_hosted', 'self', 1, 1, '部署时自动创建的自建短链域名')`,
    [base],
  );
}

async function seedSelfCardDomain(connection) {
  const configuredBase = String(
    process.env.PUBLIC_CARD_BASE_URL || 'https://vod.hotwharf.com',
  ).trim();
  let url;
  try {
    url = new URL(configuredBase);
  } catch {
    throw new Error('PUBLIC_CARD_BASE_URL 必须是有效的 HTTPS 地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('PUBLIC_CARD_BASE_URL 必须是无账号信息的 HTTPS 地址');
  }

  const domain = url.origin;
  const [rows] = await connection.execute(
    `SELECT id, type, platform FROM domains WHERE domain = ? LIMIT 1`,
    [domain],
  );
  if (rows[0]) {
    if (rows[0].type !== 'self_hosted' || rows[0].platform !== 'self') {
      throw new Error(`${domain} 已被配置为 Suolink 域名，不能用于 /s/ 自建卡片`);
    }
    return;
  }

  await connection.execute(
    `INSERT INTO domains
       (domain, type, platform, is_primary, is_enabled, remark)
     VALUES (?, 'self_hosted', 'self', 0, 1, '/s/ 自建卡片公开域名')`,
    [domain],
  );
}

function readSchema() {
  const schemaPath = path.resolve(__dirname, '../sql/schema.sql');
  return fs
    .readFileSync(schemaPath, 'utf8')
    .replace(/CREATE DATABASE IF NOT EXISTS[\s\S]*?;\s*/i, '')
    .replace(/USE\s+`[^`]+`;\s*/i, '');
}

async function migrate() {
  const database = requireConfig('DB_NAME');
  const connectionOptions = {
    host: requireConfig('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    user: requireConfig('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
  };
  const bootstrapConnection = await mysql.createConnection(connectionOptions);

  try {
    await bootstrapConnection.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)} ` +
        'DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci',
    );
  } finally {
    await bootstrapConnection.end();
  }

  const connection = await mysql.createConnection({
    ...connectionOptions,
    database,
    multipleStatements: true,
    timezone: 'Z',
  });

  try {
    // Schema defaults and seed statements use NOW()/CURRENT_TIMESTAMP. Keep the
    // migration session aligned with the application's UTC database contract.
    await connection.query("SET time_zone = '+00:00'");
    await connection.query(readSchema());
    await upgradeExistingTables(connection, database);
    await seedDemoAccounts(connection);
    await seedPrimaryDomain(connection);
    await seedSelfCardDomain(connection);
    console.log(`数据库迁移完成：${database}`);
  } finally {
    await connection.end();
  }
}

migrate().catch((error) => {
  console.error('数据库迁移失败：', error.message || error);
  process.exitCode = 1;
});
