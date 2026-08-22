const axios = require('axios');
const { getConfig } = require('./runtimeConfigService');
const { decryptSecret } = require('./secretConfigService');
const { isPrivateHostname } = require('./cardPageService');
const logger = require('../utils/logger');

const DEFAULT_CREATE_API_URL = 'https://api.suolink.cn/api';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10000;

class SuolinkApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SuolinkApiError';
    this.code = options.code || 'SUOLINK_API_ERROR';
    this.status = options.status || {
      SUOLINK_CONFIG_ERROR: 503,
      SUOLINK_VALIDATION_ERROR: 400,
      SUOLINK_TIMEOUT: 503,
      SUOLINK_REQUEST_FAILED: 502,
      SUOLINK_INVALID_RESPONSE: 502,
      SUOLINK_PROVIDER_ERROR: 502,
      SUOLINK_PROVIDER_LINK_INVALID: 502,
    }[this.code] || 502;
    this.details = options.details;

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getTimeout() {
  const timeout = readNonNegativeInteger(
    process.env.SUOLINK_API_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );

  return timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

async function getApiKey() {
  const storedApiKey = await getConfig('suolink_api_key');
  const apiKey = String(
    storedApiKey ? decryptSecret(storedApiKey) : process.env.SUOLINK_API_KEY || '',
  ).trim();

  if (!apiKey || isPlaceholder(apiKey)) {
    throw new SuolinkApiError('SUOLINK_API_KEY 未配置或仍为占位值', {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  return apiKey;
}

function isPlaceholder(value) {
  return /^(your[_-]|replace[_-]?with|example|changeme|xxx)|your_short_domain\.com|example\.(com|cn)/i.test(
    String(value || '').trim(),
  );
}

function getApiUrl(variableName, fallback) {
  const raw = String(process.env[variableName] || fallback || '').trim();

  if (!raw || isPlaceholder(raw)) {
    throw new SuolinkApiError(`${variableName} 未配置或仍为占位值`, {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  try {
    return validateHttpUrl(raw, variableName);
  } catch (error) {
    throw new SuolinkApiError(`${variableName} 配置无效`, {
      code: 'SUOLINK_CONFIG_ERROR',
      cause: error,
    });
  }
}

function getDomain(value) {
  const raw = String(value || '').trim();

  if (!raw || isPlaceholder(raw)) {
    throw new SuolinkApiError('SUOLINK_DOMAIN 未配置或仍为占位值', {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;

  try {
    parsed = new URL(withProtocol);
  } catch (error) {
    throw new SuolinkApiError('SUOLINK_DOMAIN 格式不正确', {
      code: 'SUOLINK_CONFIG_ERROR',
      cause: error,
    });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SuolinkApiError('SUOLINK_DOMAIN 仅支持 http 或 https 协议', {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  if (parsed.username || parsed.password) {
    throw new SuolinkApiError('SUOLINK_DOMAIN 不允许包含用户名或密码', {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new SuolinkApiError('SUOLINK_DOMAIN 必须是独享域名且不能包含路径', {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  return parsed.host;
}

// 域名池安全校验：进入候选的 Suolink 域名必须是公网可达的纯域名，
// 拒绝 localhost、私网/保留 IP、内网主机名等危险地址，避免短链被指向内网。
function assertSuolinkDomainAllowed(value) {
  const raw = String(value || '').trim();

  const toInvalidDomainError = (message, cause) => new SuolinkApiError(message, {
    code: 'SUOLINK_DOMAIN_INVALID',
    status: 400,
    cause,
  });

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw toInvalidDomainError('Suolink 短链域名仅支持 http/https 协议');
  }

  let domain;
  try {
    domain = getDomain(value);
  } catch (error) {
    throw toInvalidDomainError(`Suolink 短链域名不合法：${error.message}`, error);
  }

  const hostname = domain.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();

  if (isPrivateHostname(hostname)) {
    throw toInvalidDomainError('Suolink 短链域名不允许使用 localhost 或私网地址');
  }

  return domain;
}

function validateHttpUrl(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SuolinkApiError(`${fieldName} 不能为空`, {
      code: 'SUOLINK_VALIDATION_ERROR',
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(value.trim());
  } catch (error) {
    throw new SuolinkApiError(`${fieldName} 不是合法 URL`, {
      code: 'SUOLINK_VALIDATION_ERROR',
      cause: error,
    });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new SuolinkApiError(`${fieldName} 仅支持 http 或 https 协议`, {
      code: 'SUOLINK_VALIDATION_ERROR',
    });
  }

  return parsedUrl.toString();
}

function getDefaultExpireDate() {
  const expireDate = new Date();
  expireDate.setUTCFullYear(expireDate.getUTCFullYear() + 1);
  return expireDate.toISOString().slice(0, 10);
}

function normalizeResponseData(data) {
  if (typeof data !== 'string') {
    return data;
  }

  const text = data.trim();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { url: text, err: '' };
  }
}

function isRetryableError(error) {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  if (!error.response) {
    return true;
  }

  const status = error.response.status;
  return [408, 425, 429].includes(status) || status >= 500;
}

function getRetryDelay(error, attempt) {
  const retryAfter = error.response?.headers?.['retry-after'];

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const retryDate = Date.parse(retryAfter);

    if (!Number.isNaN(retryDate)) {
      return Math.min(Math.max(retryDate - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }
  }

  const exponentialDelay = 300 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY_MS);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toApiError(error) {
  if (error instanceof SuolinkApiError) {
    return error;
  }

  if (!axios.isAxiosError(error)) {
    return new SuolinkApiError('调用缩链 API 时发生未知错误', {
      cause: error,
    });
  }

  const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
  const status = error.response?.status;

  return new SuolinkApiError(
    isTimeout
      ? '调用缩链 API 超时'
      : `调用缩链 API 失败${status ? `（HTTP ${status}）` : ''}`,
    {
      code: isTimeout ? 'SUOLINK_TIMEOUT' : 'SUOLINK_REQUEST_FAILED',
      status: isTimeout ? 503 : 502,
      details: error.response?.data,
      cause: error,
    },
  );
}

async function requestWithRetry(config) {
  const maxRetries = Math.min(
    readNonNegativeInteger(
      process.env.SUOLINK_API_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
    ),
    5,
  );

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await axios.request({
        method: 'GET',
        timeout: getTimeout(),
        ...config,
      });
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !isRetryableError(error)) {
        break;
      }

      await wait(getRetryDelay(error, attempt));
    }
  }

  throw toApiError(lastError);
}

function assertProviderSuccess(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new SuolinkApiError('缩链 API 返回了无法识别的数据', {
      code: 'SUOLINK_INVALID_RESPONSE',
      details: payload,
    });
  }

  if (payload.err) {
    throw new SuolinkApiError(`缩链 API 返回错误：${payload.err}`, {
      code: 'SUOLINK_PROVIDER_ERROR',
      status: 502,
      details: payload,
    });
  }
}

function extractShortCode(shortUrl) {
  const parsedUrl = new URL(shortUrl);
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  const shortCode = pathParts.at(-1);

  if (!shortCode) {
    throw new SuolinkApiError('缩链 API 返回的短链接中不包含短码', {
      code: 'SUOLINK_INVALID_RESPONSE',
      details: { shortUrl },
    });
  }

  return decodeURIComponent(shortCode);
}

function normalizeProviderShortUrl(providerUrl, expectedDomain, normalizedLongUrl, options = {}) {
  const validatedUrl = validateHttpUrl(providerUrl, '缩链 API 返回的 url');
  const normalizedProviderUrl = new URL(validatedUrl);
  const expectedHost = getDomain(expectedDomain).toLowerCase();
  const returnedHost = normalizedProviderUrl.host.toLowerCase();

  // Suolink 的部分共享域名会把 domain=i6q.cn / m6z.cn 规范化为
  // b.i6q.cn / b.m6z.cn 返回。只接受完全相同的主机或固定的 b. 子域，
  // 既兼容供应商的真实返回格式，也不会放宽到任意子域或其他注册域。
  if (returnedHost !== expectedHost && returnedHost !== `b.${expectedHost}`) {
    throw new SuolinkApiError('缩链 API 返回的域名与当前 Suolink 配置不一致', {
      code: 'SUOLINK_INVALID_RESPONSE',
      details: {
        expectedDomain: expectedHost,
        returnedDomain: normalizedProviderUrl.host,
      },
    });
  }

  const forceHttps = options.forceHttps ?? process.env.SUOLINK_FORCE_HTTPS !== '0';
  if (forceHttps) normalizedProviderUrl.protocol = 'https:';
  const shortUrl = normalizedProviderUrl.toString();

  if (shortUrl === normalizedLongUrl) {
    throw new SuolinkApiError('缩链 API 未生成短链接，而是返回了原链接', {
      code: 'SUOLINK_PROVIDER_ERROR',
    });
  }

  extractShortCode(shortUrl);
  return shortUrl;
}

function isProviderNotFoundPage(data) {
  const html = String(data || '').slice(0, 1024 * 1024);
  return /<title[^>]*>\s*404(?:\s*-\s*页面不存在)?\s*<\/title>/i.test(html)
    || /404\s*-\s*页面不存在/i.test(html)
    || /e_404\.css/i.test(html)
    || /若您长时间无法正常访问建议您扫码联系官方客服/.test(html);
}

function getPageTitle(data) {
  const match = String(data || '').match(/<title[^>]*>([^<]{0,200})<\/title>/i);
  return match ? match[1].trim() : '';
}

async function verifyShortLink(shortUrl, options = {}) {
  const attempts = Math.max(1, Math.min(readNonNegativeInteger(options.attempts, 3), 5));
  const retryDelayMs = readNonNegativeInteger(options.retryDelayMs, 300);
  let lastDiagnostic = {};

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await axios.get(shortUrl, {
        timeout: options.timeout || getTimeout(),
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        responseType: 'text',
        headers: {
          'cache-control': 'no-cache',
          'user-agent': 'video-delivery-short-link-verifier/1.0',
        },
        validateStatus: () => true,
      });
      const status = response.status;
      const location = response.headers?.location || '';
      const invalidPage = status >= 200 && status < 300
        && isProviderNotFoundPage(response.data);
      const validRedirect = status >= 300 && status < 400 && Boolean(location);
      const validPage = status >= 200 && status < 300 && !invalidPage;

      if (options.expectedLocation && !validRedirect) {
        lastDiagnostic = { status, reason: 'expected_redirect' };
        if (attempt + 1 < attempts) await wait(retryDelayMs * (attempt + 1));
        continue;
      }

      if (validRedirect && options.expectedLocation) {
        const resolvedLocation = new URL(location, shortUrl).toString();
        if (resolvedLocation !== options.expectedLocation) {
          lastDiagnostic = {
            status,
            reason: 'unexpected_redirect_target',
            location: resolvedLocation,
            expectedLocation: options.expectedLocation,
          };
          if (attempt + 1 < attempts) await wait(retryDelayMs * (attempt + 1));
          continue;
        }
      }

      if (validRedirect || validPage) {
        if (validRedirect) {
          try {
            validateHttpUrl(new URL(location, shortUrl).toString(), '缩链跳转地址');
          } catch {
            lastDiagnostic = { status, reason: 'invalid_redirect_location' };
            if (attempt + 1 < attempts) await wait(retryDelayMs * (attempt + 1));
            continue;
          }
        }

        return { status, location };
      }

      lastDiagnostic = {
        status,
        pageTitle: getPageTitle(response.data),
        reason: invalidPage ? 'provider_not_found_page' : 'unexpected_http_status',
      };
    } catch (error) {
      lastDiagnostic = {
        status: error.response?.status,
        reason: error.code || 'request_failed',
      };
    }

    if (attempt + 1 < attempts) await wait(retryDelayMs * (attempt + 1));
  }

  throw new SuolinkApiError('缩链 API 返回了未生效或无法访问的短链接', {
    code: 'SUOLINK_PROVIDER_LINK_INVALID',
    details: { shortUrl, ...lastDiagnostic },
  });
}

/**
 * 调用缩链 API 生成短链接。
 * 域名由后端域名池中已启用的 Suolink 记录提供，不再限制为单一固定域名；
 * 返回的短链 hostname 必须与本次选中的候选域名完全一致，否则拒绝保存。
 * @param {string} longUrl
 * @param {{domain?: string, expireDate?: string}} options
 * @returns {Promise<{shortCode: string, shortUrl: string}>}
 */
async function createShortLink(longUrl, options = {}) {
  const normalizedLongUrl = validateHttpUrl(longUrl, 'longUrl');
  const domain = assertSuolinkDomainAllowed(options.domain || process.env.SUOLINK_DOMAIN);
  const expireDate = options.expireDate
    || process.env.SUOLINK_EXPIRE_DATE
    || getDefaultExpireDate();
  const apiUrl = getApiUrl('SUOLINK_API_BASE_URL', DEFAULT_CREATE_API_URL);

  logger.info('suolink_create_request', {
    apiUrl,
    domain,
    expireDate,
    longUrl: normalizedLongUrl,
  });

  const response = await internals.requestWithRetry({
    url: apiUrl,
    params: {
      format: 'json',
      url: normalizedLongUrl,
      key: await internals.getApiKey(),
      expireDate,
      domain,
      protocol: '1',
    },
  });

  const payload = normalizeResponseData(response.data);
  logger.info('suolink_create_response', {
    status: response.status,
    providerCode: payload?.code,
    providerError: payload?.err || '',
    providerUrl: payload?.url || '',
  });
  assertProviderSuccess(payload);

  const shortUrl = normalizeProviderShortUrl(payload.url, domain, normalizedLongUrl);
  const verification = await internals.verifyShortLink(shortUrl, {
    expectedLocation: normalizedLongUrl,
  });
  logger.info('suolink_link_verified', {
    shortUrl,
    status: verification.status,
    location: verification.location,
  });

  return {
    shortCode: extractShortCode(shortUrl),
    shortUrl,
  };
}

/**
 * 获取短链点击统计。
 * 公开文档未提供固定统计接口路径，因此通过 SUOLINK_STATS_API_URL 配置。
 * 如供应商使用不同参数名，可通过 SUOLINK_STATS_CODE_PARAM 调整。
 * @param {string} shortCode
 * @returns {Promise<object>}
 */
async function getLinkStats(shortCode) {
  if (typeof shortCode !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(shortCode)) {
    throw new SuolinkApiError('shortCode 格式不正确', {
      code: 'SUOLINK_VALIDATION_ERROR',
    });
  }

  const statsApiUrl = process.env.SUOLINK_STATS_API_URL?.trim();

  if (!statsApiUrl) {
    throw new SuolinkApiError('缺少环境变量 SUOLINK_STATS_API_URL', {
      code: 'SUOLINK_CONFIG_ERROR',
    });
  }

  const codeParam = process.env.SUOLINK_STATS_CODE_PARAM?.trim() || 'shortCode';
  const response = await requestWithRetry({
    url: getApiUrl('SUOLINK_STATS_API_URL', statsApiUrl),
    params: {
      format: 'json',
      key: await getApiKey(),
      [codeParam]: shortCode,
    },
  });

  const payload = normalizeResponseData(response.data);
  assertProviderSuccess(payload);

  return payload.data || payload.stats || payload;
}

// 测试接缝：允许测试在不发起真实网络请求的情况下替换底层请求实现。
const internals = {
  getApiKey,
  requestWithRetry,
  verifyShortLink,
};

module.exports = {
  createShortLink,
  getLinkStats,
  getApiKey,
  getDomain,
  assertSuolinkDomainAllowed,
  getApiUrl,
  isPlaceholder,
  normalizeProviderShortUrl,
  isProviderNotFoundPage,
  verifyShortLink,
  SuolinkApiError,
  _internals: internals,
};
