const pool = require('../config/db');
const fs = require('fs');
const path = require('path');

function normalizePublicBaseUrl(value, fieldName = 'PUBLIC_CARD_BASE_URL') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error(`${fieldName} 必须是合法的 HTTPS 根地址：${raw}`);
    error.status = 409;
    error.code = 'PUBLIC_CARD_DOMAIN_CONFIG_ERROR';
    throw error;
  }

  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
  ) {
    const error = new Error(`${fieldName} 必须是合法的 HTTPS 根地址（不含路径、查询参数或片段）：${raw}`);
    error.status = 409;
    error.code = 'PUBLIC_CARD_DOMAIN_CONFIG_ERROR';
    throw error;
  }

  return url.origin;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return '';
  }
}

function configuredCardBaseUrl() {
  return String(
    process.env.PUBLIC_CARD_BASE_URL || process.env.CARD_PAGE_BASE_URL || '',
  ).trim();
}

function syncProcessPublicBaseUrls(domain) {
  const normalized = normalizePublicBaseUrl(domain);
  if (!normalized) throw new Error('主域名必须是有效的 HTTPS 地址');
  process.env.PLAY_PAGE_BASE_URL = normalized;
  process.env.PUBLIC_CARD_BASE_URL = normalized;
  process.env.PUBLIC_SHORTLINK_BASE_URL = normalized;
  return normalized;
}

function persistPublicBaseUrls(domain) {
  const normalized = syncProcessPublicBaseUrls(domain);
  if (process.env.RUNTIME_DOMAIN_SYNC_ENABLED !== '1') return normalized;
  const envFile = process.env.RUNTIME_ENV_FILE || path.resolve(__dirname, '../../.env');
  let content = fs.readFileSync(envFile, 'utf8');
  for (const key of ['PLAY_PAGE_BASE_URL', 'PUBLIC_CARD_BASE_URL', 'PUBLIC_SHORTLINK_BASE_URL']) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, `${key}=${normalized}`) : `${content.replace(/\n?$/, '\n')}${key}=${normalized}\n`;
  }
  const temporary = `${envFile}.domain-sync-${process.pid}`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, envFile);
  fs.chmodSync(envFile, 0o600);
  return normalized;
}

async function getEnabledSelfDomains() {
  const [rows] = await pool.execute(
    `SELECT d.id, d.domain, d.is_primary
     FROM domains d
     WHERE d.is_enabled = 1
       AND COALESCE(d.platform,
         CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
       ) = 'self'
     ORDER BY d.is_primary DESC, d.id ASC`,
  );
  return rows;
}

function domainMismatchError(expectedOrigin, actualDomains) {
  const actual = actualDomains.length ? actualDomains.join('、') : '（无启用的 self 域名）';
  const error = new Error(
    `PUBLIC_CARD_BASE_URL 期望域名为 ${expectedOrigin}，但域名池中启用的 self 域名为 ${actual}。`
      + '请将该域名以 type=self_hosted、platform=self 加入并启用，或修改 PUBLIC_CARD_BASE_URL 后重启服务。',
  );
  error.status = 409;
  error.code = 'PUBLIC_CARD_DOMAIN_MISMATCH';
  error.expectedOrigin = expectedOrigin;
  error.actualDomains = actualDomains;
  return error;
}

async function getPublicCardDomainDiagnostics() {
  const domains = await getEnabledSelfDomains();
  const actualDomains = domains.map((item) => item.domain);
  const configured = configuredCardBaseUrl();

  if (configured) {
    let expectedOrigin = '';
    try {
      expectedOrigin = normalizePublicBaseUrl(configured);
    } catch (error) {
      return {
        status: 'invalid',
        source: 'environment',
        configuredBaseUrl: configured,
        expectedOrigin: '',
        actualDomains,
        matches: false,
        message: error.message,
        repair: '请修正 backend/.env 中的 PUBLIC_CARD_BASE_URL，并重启后端。',
      };
    }
    const matching = domains.find((item) => normalizeOrigin(item.domain) === expectedOrigin.toLowerCase());
    return {
      status: matching ? 'ok' : 'mismatch',
      source: 'environment',
      configuredBaseUrl: configured,
      expectedOrigin,
      actualDomains,
      matchingDomain: matching?.domain || '',
      matches: Boolean(matching),
      message: matching
        ? `PUBLIC_CARD_BASE_URL 与启用的 self 域名 ${matching.domain} 一致。`
        : domainMismatchError(expectedOrigin, actualDomains).message,
      repair: matching
        ? ''
        : '请把期望域名加入并启用为 self_hosted/self，或修改 PUBLIC_CARD_BASE_URL 后重启后端。',
    };
  }

  const selected = domains[0];
  return {
    status: selected ? 'ok' : 'missing',
    source: selected ? 'domain_pool' : 'domain_pool_missing',
    configuredBaseUrl: '',
    expectedOrigin: selected ? normalizeOrigin(selected.domain) : '',
    actualDomains,
    matchingDomain: selected?.domain || '',
    matches: Boolean(selected),
    message: selected
      ? `未配置 PUBLIC_CARD_BASE_URL，当前使用启用的 self 主域名 ${selected.domain}。`
      : '未配置 PUBLIC_CARD_BASE_URL，且域名池中没有启用的 self 域名。',
    repair: selected
      ? ''
      : '请在域名池添加并启用 type=self_hosted、platform=self 的 HTTPS 域名。',
  };
}

async function getPublicCardBaseUrl() {
  const diagnostics = await getPublicCardDomainDiagnostics();
  if (diagnostics.status === 'invalid') {
    const error = new Error(diagnostics.message);
    error.status = 409;
    error.code = 'PUBLIC_CARD_DOMAIN_CONFIG_ERROR';
    throw error;
  }
  if (diagnostics.status === 'mismatch') {
    throw domainMismatchError(diagnostics.expectedOrigin, diagnostics.actualDomains);
  }
  if (diagnostics.status === 'missing') {
    const error = new Error(`${diagnostics.message} ${diagnostics.repair}`);
    error.status = 409;
    error.code = 'SELF_DOMAIN_REQUIRED';
    throw error;
  }
  return diagnostics.matchingDomain;
}

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
  getPublicCardBaseUrl,
  getPublicCardDomainDiagnostics,
  persistPublicBaseUrls,
  normalizePublicBaseUrl,
};
