const axios = require('axios');
const logger = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

class CloudflareShortLinkError extends Error {
  constructor(message, code = 'CLOUDFLARE_SHORTLINK_ERROR', status = 502, cause) {
    super(message);
    this.name = 'CloudflareShortLinkError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function enabled() {
  return process.env.CLOUDFLARE_SHORTLINK_ENABLED === '1'
    || process.env.CLOUDFLARE_SHORTLINK_ENABLED === 'true';
}

function parseServiceUrl(value, fieldName) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); }
  catch { throw new CloudflareShortLinkError(`${fieldName} 配置无效`, 'CLOUDFLARE_CONFIG_ERROR', 503); }

  const localDevelopment = process.env.NODE_ENV !== 'production'
    && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopment)) {
    throw new CloudflareShortLinkError(
      `${fieldName} 必须使用 HTTPS`,
      'CLOUDFLARE_CONFIG_ERROR',
      503,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CloudflareShortLinkError(
      `${fieldName} 不能包含账号、参数或锚点`,
      'CLOUDFLARE_CONFIG_ERROR',
      503,
    );
  }
  return url;
}

function publicBaseUrl() {
  return parseServiceUrl(
    process.env.CLOUDFLARE_SHORTLINK_BASE_URL,
    'CLOUDFLARE_SHORTLINK_BASE_URL',
  ).toString().replace(/\/+$/, '');
}

function apiBaseUrl() {
  return parseServiceUrl(
    process.env.CLOUDFLARE_SHORTLINK_API_URL
      || process.env.CLOUDFLARE_SHORTLINK_BASE_URL,
    'CLOUDFLARE_SHORTLINK_API_URL',
  ).toString().replace(/\/+$/, '');
}

function apiKey() {
  const value = String(process.env.CLOUDFLARE_SHORTLINK_API_KEY || '').trim();
  if (!value || /^(replace|change|example|your[_-])/i.test(value)) {
    throw new CloudflareShortLinkError(
      'CLOUDFLARE_SHORTLINK_API_KEY 未配置',
      'CLOUDFLARE_CONFIG_ERROR',
      503,
    );
  }
  return value;
}

function isConfigured() {
  if (!enabled()) return false;
  try {
    publicBaseUrl();
    apiBaseUrl();
    apiKey();
    return true;
  } catch {
    return false;
  }
}

function normalizeDomainOrigin(value) {
  const raw = String(value || '').trim();
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return '';
  }
}

function isManagedDomain(value) {
  if (!enabled()) return false;
  try {
    return normalizeDomainOrigin(value) === new URL(publicBaseUrl()).origin;
  } catch {
    return false;
  }
}

function retryable(error) {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return !status || [408, 425, 429].includes(status) || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(method, path, data) {
  const configuredRetries = Number.parseInt(
    process.env.CLOUDFLARE_SHORTLINK_MAX_RETRIES || '',
    10,
  );
  const maxRetries = Number.isInteger(configuredRetries)
    ? Math.max(0, Math.min(configuredRetries, 5))
    : DEFAULT_RETRIES;
  const configuredTimeout = Number.parseInt(
    process.env.CLOUDFLARE_SHORTLINK_TIMEOUT_MS || '',
    10,
  );
  const timeout = Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await axios.request({
        method,
        url: `${apiBaseUrl()}${path}`,
        timeout,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        data,
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !retryable(error)) break;
      await wait(100 * 2 ** attempt);
    }
  }

  const status = lastError?.response?.status;
  logger.warn('cloudflare_shortlink_sync_failed', {
    method,
    path,
    status: status || 0,
    attempts: maxRetries + 1,
    code: lastError?.code || 'CLOUDFLARE_REQUEST_FAILED',
  });
  throw new CloudflareShortLinkError(
    `Cloudflare 短链同步失败${status ? `（HTTP ${status}）` : ''}`,
    status === 409
      ? 'CLOUDFLARE_SHORT_CODE_CONFLICT'
      : status === 404
        ? 'CLOUDFLARE_MAPPING_NOT_FOUND'
        : 'CLOUDFLARE_SYNC_FAILED',
    [404, 409].includes(status) ? status : 502,
    lastError,
  );
}

function expiresIn(expiresAt) {
  if (!expiresAt) return undefined;
  const seconds = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(60, Math.min(seconds, 31_536_000));
}

async function createMapping(input) {
  const payload = {
    url: input.targetUrl,
    customCode: input.shortCode,
    ogTitle: input.ogTitle,
    ogDescription: input.ogDescription,
    ogImage: input.ogImage,
    ogUrl: input.ogUrl,
    ...(input.expiresAt ? { expiresIn: expiresIn(input.expiresAt) } : {}),
  };
  try {
    return await request('POST', '/api/urls', payload);
  } catch (error) {
    if (error.code !== 'CLOUDFLARE_SHORT_CODE_CONFLICT') throw error;
    return updateMapping(input.shortCode, input);
  }
}

function updateMapping(shortCode, input) {
  return request('PUT', `/api/urls/${encodeURIComponent(shortCode)}`, {
    targetUrl: input.targetUrl,
    ogTitle: input.ogTitle,
    ogDescription: input.ogDescription,
    ogImage: input.ogImage,
    ogUrl: input.ogUrl,
    expirationDate: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
  });
}

async function upsertMapping(shortCode, input) {
  try {
    return await updateMapping(shortCode, input);
  } catch (error) {
    if (error.code !== 'CLOUDFLARE_MAPPING_NOT_FOUND') throw error;
    return createMapping({ ...input, shortCode });
  }
}

function getMapping(shortCode) {
  return request('GET', `/api/urls/${encodeURIComponent(shortCode)}`);
}

function deleteMapping(shortCode) {
  return request('DELETE', `/api/urls/${encodeURIComponent(shortCode)}`);
}

async function deleteMappingsBestEffort(links, reason = 'lifecycle') {
  const managed = (links || []).filter((link) => isManagedDomain(link.domain));
  const results = await Promise.allSettled(
    managed.map((link) => deleteMapping(link.short_code)),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('cloudflare_shortlink_deactivation_deferred', {
        shortCode: managed[index].short_code,
        reason,
        code: result.reason?.code || 'CLOUDFLARE_SYNC_FAILED',
      });
    }
  });
  return {
    requested: managed.length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

module.exports = {
  enabled,
  isConfigured,
  isManagedDomain,
  publicBaseUrl,
  createMapping,
  updateMapping,
  upsertMapping,
  getMapping,
  deleteMapping,
  deleteMappingsBestEffort,
  CloudflareShortLinkError,
};
