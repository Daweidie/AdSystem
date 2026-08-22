const pool = require('../config/db');

async function getConfig(key) {
  const [rows] = await pool.execute(
    'SELECT config_value FROM system_configs WHERE config_key = ? LIMIT 1',
    [key],
  );
  return rows[0]?.config_value || null;
}

async function getCustomerBaseUrl() {
  const [domains] = await pool.execute(
    `SELECT d.domain
     FROM domains d
     WHERE d.is_enabled = 1 AND d.platform = 'self'
     ORDER BY d.is_primary DESC, d.id ASC
     LIMIT 1`,
  );

  return (
    domains[0]?.domain ||
    (await getConfig('customer_base_url')) ||
    process.env.PUBLIC_SHORTLINK_BASE_URL ||
    process.env.PLAY_PAGE_BASE_URL ||
    process.env.FRONTEND_URL ||
    null
  );
}

async function getPlayPageBaseUrl() {
  return process.env.PUBLIC_PLAY_BASE_URL
    || process.env.PLAY_PAGE_BASE_URL
    || getCustomerBaseUrl();
}

module.exports = {
  getConfig,
  getCustomerBaseUrl,
  getPlayPageBaseUrl,
};
