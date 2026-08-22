const crypto = require('crypto');
const pool = require('../config/db');
const shortLinkService = require('./shortLinkService');
const suolinkService = require('./suolinkService');
const cloudflareShortLinkService = require('./cloudflareShortLinkService');
const logger = require('../utils/logger');
const { normalizeWechatCardMode } = require('./cardPageService');

const SUPPORTED_PLATFORMS = new Set(['auto', 'suolink', 'self']);

class UnifiedShortLinkServiceError extends Error {
  constructor(message, code, status = 500, cause) {
    super(message);
    this.name = 'UnifiedShortLinkServiceError';
    this.code = code;
    this.status = status;

    if (cause) {
      this.cause = cause;
    }
  }
}

function normalizeId(value, fieldName) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw new UnifiedShortLinkServiceError(
      `${fieldName} 必须是正整数`,
      'SHORT_LINK_VALIDATION_ERROR',
      400,
    );
  }

  return String(value);
}

function normalizePlatform(platform) {
  const normalized = String(platform || 'auto').toLowerCase();

  if (!SUPPORTED_PLATFORMS.has(normalized)) {
    throw new UnifiedShortLinkServiceError(
      'platform 仅支持 suolink、self 或 auto',
      'SHORT_LINK_VALIDATION_ERROR',
      400,
    );
  }

  return normalized;
}

function getDomainPlatform(domain) {
  return domain.platform || (domain.type === 'suolink' ? 'suolink' : 'self');
}

function toSuolinkDomain(value) {
  const raw = String(value || '').trim();

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.host;
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }
}

function reconcileConfiguredSuolinkDomain(domains, config = {}) {
  // suolink_enabled = 0 时，所有 Suolink 域名都不能参与生成。
  if (!config.enabled) {
    return domains.filter((domain) => domain.platform !== 'suolink');
  }

  // suolink_enabled = 1 时保留已启用的 Suolink 域名信息，但生成器会在
  // selectGenerationCandidates 中固定选用 is_preferred 的唯一域名。
  // 自建域名不会被误当成 Suolink 域名，停用域名在进入本函数前已被过滤。
  const configuredDomain = config.domain
    ? toSuolinkDomain(config.domain).toLowerCase()
    : '';

  return domains.map((domain) => {
    if (domain.platform !== 'suolink') return domain;

    const isPreferred = Boolean(configuredDomain)
      && toSuolinkDomain(domain.domain).toLowerCase() === configuredDomain;
    return { ...domain, is_preferred: isPreferred ? 1 : 0 };
  });
}

async function getAvailableDomains() {
  const [configRows, domainResult] = await Promise.all([
    pool.execute(
      `SELECT
         MAX(CASE WHEN config_key = 'suolink_enabled' THEN config_value END) AS enabled,
         MAX(CASE WHEN config_key = 'suolink_domain' THEN config_value END) AS domain
       FROM system_configs
       WHERE config_key IN ('suolink_enabled', 'suolink_domain')`,
    ).then(([configRows]) => configRows),
    pool.execute(
    `SELECT d.id, d.domain, d.type, d.platform, d.is_primary,
            COALESCE(usage_count.link_count, 0) AS link_count
     FROM domains d
     LEFT JOIN (
       SELECT domain_id, COUNT(*) AS link_count
       FROM short_links
       GROUP BY domain_id
     ) usage_count ON usage_count.domain_id = d.id
     WHERE d.is_enabled = 1
     ORDER BY COALESCE(usage_count.link_count, 0) ASC,
              d.is_primary DESC,
              d.id ASC`,
    ),
  ]);
  const [config] = configRows;
  const [rows] = domainResult;

  const normalizedDomains = rows.map((domain) => ({
    ...domain,
    platform: getDomainPlatform(domain),
  }));
  return reconcileConfiguredSuolinkDomain(normalizedDomains, {
    enabled: config?.enabled === '1',
    domain: config?.domain || '',
  });
}

function selectCandidates(domains, requestedPlatform) {
  // 候选排序：已分配有效链接数较少的优先；数量相同时首选域名优先；
  // 再按 domain.id 保证结果稳定。
  const balanced = (items) => [...items].sort((left, right) =>
    Number(left.link_count || 0) - Number(right.link_count || 0) ||
    Number(Boolean(right.is_preferred)) - Number(Boolean(left.is_preferred)) ||
    Number(Boolean(right.is_primary)) - Number(Boolean(left.is_primary)) ||
    Number(left.id) - Number(right.id));

  if (requestedPlatform !== 'auto') {
    return balanced(domains.filter((domain) => domain.platform === requestedPlatform));
  }

  // auto 模式先尝试符合配置的 Suolink 域名，再按 fallback 规则使用自建域名。
  const preferredSuolink = balanced(domains.filter(
    (domain) => domain.platform === 'suolink',
  ));
  const fallbackSelf = balanced(domains.filter((domain) => domain.platform === 'self'));
  return [...preferredSuolink, ...fallbackSelf];
}

// 新链接必须使用一个稳定的公开域名。域名池仍然保留多域名能力，供历史
// 链接和运维查看，但生成时只选当前主域名；显式请求 Suolink 时优先使用
// 后台配置的 Suolink 域名，这样供应商返回的 b.* 规范化域名也始终一致。
function selectGenerationCandidates(domains, requestedPlatform) {
  const eligible = domains.filter((domain) => domain.platform === requestedPlatform
    || requestedPlatform === 'auto');
  if (!eligible.length) return [];

  const stableFallback = [...eligible].sort((left, right) => Number(left.id) - Number(right.id))[0];

  const primary = eligible.find((domain) => Boolean(domain.is_primary));
  if (requestedPlatform === 'auto') return primary ? [primary] : [stableFallback];

  if (requestedPlatform === 'suolink') {
    const configured = eligible.find((domain) => Boolean(domain.is_preferred));
    return [configured || primary || stableFallback];
  }

  return [primary || stableFallback];
}

async function getAvailableVideo(videoId) {
  const [rows] = await pool.execute(
    `SELECT id, expires_at
     FROM videos
     WHERE id = ?
       AND status = 'ready'
       AND expires_at > NOW()
     LIMIT 1`,
    [videoId],
  );

  if (rows.length === 0) {
    throw new UnifiedShortLinkServiceError(
      '视频不存在、未就绪或已过期',
      'VIDEO_NOT_AVAILABLE',
      410,
    );
  }

  return rows[0];
}

async function resolveVideoId(longUrl, providedVideoId) {
  if (providedVideoId !== undefined && providedVideoId !== null) {
    return normalizeId(providedVideoId, 'videoId');
  }

  let fileId;

  try {
    fileId = new URL(longUrl).searchParams.get('fileId');
  } catch {
    fileId = null;
  }

  if (!fileId) {
    throw new UnifiedShortLinkServiceError(
      '生成可用短链需要 videoId，或长链接中包含 fileId 参数',
      'SHORT_LINK_VALIDATION_ERROR',
      400,
    );
  }

  const [rows] = await pool.execute(
    `SELECT id FROM videos WHERE file_id = ? LIMIT 1`,
    [fileId],
  );

  if (rows.length === 0) {
    throw new UnifiedShortLinkServiceError(
      '长链接关联的视频不存在',
      'VIDEO_NOT_FOUND',
      404,
    );
  }

  return String(rows[0].id);
}

async function persistSuolinkResult(video, domain, longUrl, providerResult, options = {}) {
  const originalCode = String(providerResult.shortCode || '').slice(0, 64);

  if (!originalCode) {
    throw new UnifiedShortLinkServiceError(
      '缩链服务未返回短码',
      'SUOLINK_INVALID_RESPONSE',
      502,
    );
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shortCode =
      attempt === 0
        ? originalCode
        : `${originalCode.slice(0, 54)}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const [result] = await pool.execute(
        `INSERT INTO short_links
           (video_id, created_by, domain_id, platform, short_code, long_url, short_url,
            provider_link_id, card_token, card_title, card_description,
            card_cover_url, card_status, wechat_card_mode, status, expires_at, created_at)
         VALUES (?, ?, ?, 'suolink', ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 'active', ?, UTC_TIMESTAMP())`,
        [
          video.id,
          options.createdBy || null,
          domain.id,
          shortCode,
          longUrl,
          providerResult.shortUrl,
          originalCode,
          options.cardToken,
          options.cardTitle || null,
          options.cardDescription || null,
          options.cardCoverUrl || null,
          normalizeWechatCardMode(options.wechatCardMode),
          video.expires_at,
        ],
      );

      return {
        id: result.insertId,
        videoId: String(video.id),
        domainId: String(domain.id),
        shortCode,
        longUrl,
        shortUrl: providerResult.shortUrl,
        platform: 'suolink',
        domain: domain.domain,
        status: 'active',
        expiresAt: video.expires_at,
        cardToken: options.cardToken,
        cardStatus: 'draft',
        wechatCardMode: normalizeWechatCardMode(options.wechatCardMode),
      };
    } catch (error) {
      const duplicate = error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

      if (!duplicate) {
        throw new UnifiedShortLinkServiceError(
          '缩链已生成，但保存到数据库失败',
          'SHORT_LINK_PERSIST_FAILED',
          500,
          error,
        );
      }
    }
  }

  throw new UnifiedShortLinkServiceError(
    '缩链短码与现有记录冲突，请稍后重试',
    'SHORT_CODE_GENERATION_FAILED',
    503,
  );
}

/**
 * 短链统一入口。auto 模式遵循当前主域名的平台；主域名属于缩链平台时，
 * 优先调用缩链服务并在失败后降级到可用的自建域名。
 *
 * @param {string} longUrl
 * @param {'suolink'|'self'|'auto'} platform
 * @param {{videoId: number|string}} options
 */
async function createShortLink(longUrl, platform = 'auto', options = {}) {
  const startedAt = Date.now();
  const requestedPlatform = normalizePlatform(platform);
  const videoId = await resolveVideoId(longUrl, options.videoId);
  const domains = await getAvailableDomains();
  let generationDomains = domains;

  if (requestedPlatform === 'self' && options.preferredSelfOrigin) {
    let preferredOrigin = '';
    try {
      preferredOrigin = new URL(options.preferredSelfOrigin).origin.toLowerCase();
    } catch {
      preferredOrigin = '';
    }
    if (preferredOrigin) {
      const matchesPreferredOrigin = (domain) => {
        try {
          const raw = /^https?:\/\//i.test(domain.domain)
            ? domain.domain
            : `https://${domain.domain}`;
          return new URL(raw).origin.toLowerCase() === preferredOrigin;
        } catch {
          return false;
        }
      };
      if (options.requirePreferredSelfOrigin) {
        generationDomains = generationDomains.filter(matchesPreferredOrigin);
      }
    }
  }

  let candidates = selectGenerationCandidates(generationDomains, requestedPlatform);
  const selectedDomainIds = new Set(candidates.map((domain) => String(domain.id)));
  // 管理台显式传 allowFallback=false 时只尝试一个域名。兼容调用未关闭
  // fallback 时，主服务明确失败后才启用同平台备用域名或 auto 自建容灾。
  const fallbackPlatform = requestedPlatform === 'auto'
    ? 'self'
    : requestedPlatform === 'suolink'
      ? 'suolink'
      : null;
  const fallbackCandidates = options.allowFallback !== false && fallbackPlatform
    ? selectCandidates(generationDomains, fallbackPlatform)
      .filter((domain) => !selectedDomainIds.has(String(domain.id)))
    : [];

  // 显式 platform=suolink 或 allowFallback=false 时禁止降级到自建 /s 链接。
  if (options.allowFallback === false && requestedPlatform !== 'self') {
    candidates = candidates.filter((domain) => domain.platform !== 'self');
  }

  if (candidates.length === 0) {
    throw new UnifiedShortLinkServiceError(
      '没有与所选平台匹配的可用域名',
      'SHORT_LINK_DOMAIN_NOT_FOUND',
      409,
    );
  }

  const video = await getAvailableVideo(videoId);
  let lastProviderError;
  let lastSuolinkError;
  let fallbackFrom = null;
  const providerRejectedDomains = [];

  for (const domain of [...candidates, ...fallbackCandidates]) {
    if (domain.platform === 'self') {
      let result;
      try {
        if (
          cloudflareShortLinkService.isManagedDomain(domain.domain)
          && normalizeWechatCardMode(options.wechatCardMode) === 'standard'
        ) {
          if (!cloudflareShortLinkService.isConfigured()) {
            throw new UnifiedShortLinkServiceError(
              'Cloudflare 短链服务配置不完整',
              'CLOUDFLARE_CONFIG_ERROR',
              503,
            );
          }
          result = await shortLinkService.createShortLink(
            videoId,
            domain.id,
            longUrl,
            options,
          );
          try {
            const external = await cloudflareShortLinkService.createMapping({
              shortCode: result.shortCode,
              targetUrl: longUrl,
              ogTitle: options.cardTitle || '视频播放',
              ogDescription: options.cardDescription || '点击查看视频素材',
              ogImage: options.cardCoverUrl,
              ogUrl: result.shortUrl,
              expiresAt: video.expires_at,
            });
            if (
              external.shortCode !== result.shortCode
              || new URL(external.shortUrl).origin !== new URL(result.shortUrl).origin
            ) {
              throw new UnifiedShortLinkServiceError(
                'Cloudflare 短链服务返回了不一致的短码或域名',
                'CLOUDFLARE_INVALID_RESPONSE',
                502,
              );
            }
          } catch (error) {
            await Promise.allSettled([
              pool.execute('DELETE FROM short_links WHERE id = ?', [result.id]),
              cloudflareShortLinkService.deleteMapping(result.shortCode),
            ]);
            throw error;
          }

          return {
            ...result,
            platform: 'self',
            externalService: 'cloudflare',
            domain: domain.domain,
            status: 'active',
            expiresAt: video.expires_at,
            cardToken: options.cardToken || null,
            cardStatus: options.cardToken ? 'draft' : null,
            fallbackFrom,
          };
        }

        result = await shortLinkService.createShortLink(
          videoId,
          domain.id,
          longUrl,
          options,
        );
        return {
          ...result,
          platform: 'self',
          domain: domain.domain,
          status: 'active',
          expiresAt: video.expires_at,
          cardToken: options.cardToken || null,
          cardStatus: options.cardToken ? 'draft' : null,
          fallbackFrom,
        };
      } catch (error) {
        if (!cloudflareShortLinkService.isManagedDomain(domain.domain)) throw error;
        lastProviderError = error;
        fallbackFrom = 'cloudflare';
        logger.warn('short_link_provider_fallback', {
          code: error.code || 'CLOUDFLARE_SYNC_FAILED',
          durationMs: Date.now() - startedAt,
          targetPlatform: 'cloudflare',
          fallbackPlatform: 'self',
          videoId,
        });
        continue;
      }
    }

    let providerResult;

    try {
      if (!options.cardToken) {
        throw new UnifiedShortLinkServiceError(
          'Suolink 短链必须先生成 cardToken',
          'CARD_TOKEN_REQUIRED',
          500,
        );
      }

      providerResult = await suolinkService.createShortLink(longUrl, {
        domain: toSuolinkDomain(domain.domain),
        expireDate: new Date(video.expires_at).toISOString().slice(0, 10),
      });
    } catch (error) {
      if (error.code === 'CARD_TOKEN_REQUIRED') throw error;

      // 某个 Suolink 域名被供应商拒绝时，记录脱敏错误并尝试下一个 Suolink 域名；
      // 只有所有候选都失败后才在循环结束后统一报错。
      lastProviderError = error;
      lastSuolinkError = error;
      fallbackFrom = 'suolink';
      providerRejectedDomains.push(domain.domain);

      logger.warn('short_link_provider_fallback', {
        code: error.code || 'SUOLINK_PROVIDER_ERROR',
        domain: domain.domain,
        durationMs: Date.now() - startedAt,
        targetPlatform: 'suolink',
        fallbackPlatform: options.allowFallback === false || requestedPlatform === 'suolink'
          ? null
          : 'self',
        videoId,
      });

      continue;
    }

    const result = await persistSuolinkResult(video, domain, longUrl, providerResult, options);
    return {
      ...result,
      // 域名池中的记录只代表“允许尝试”。若域名未绑定到当前 Suolink
      // API Key，供应商会拒绝本次生成；把失败候选返回给管理端，避免
      // 后端改用下一个域名成功后，操作者误以为域名池只会循环少数域名。
      providerRejectedDomains: [...new Set(providerRejectedDomains)],
    };
  }

  // 所有 Suolink 域名都失败后，返回最后一个明确的供应商错误，不静默生成自建链接。
  if (
    lastSuolinkError
    && (requestedPlatform === 'suolink' || options.allowFallback === false)
  ) {
    throw lastSuolinkError;
  }

  throw new UnifiedShortLinkServiceError(
    lastProviderError
      ? `缩链服务不可用且没有可用的自建域名：${lastProviderError.message}`
      : '没有可用的短链服务',
    'SHORT_LINK_PROVIDER_UNAVAILABLE',
    503,
    lastProviderError,
  );
}

module.exports = {
  createShortLink,
  selectCandidates,
  selectGenerationCandidates,
  reconcileConfiguredSuolinkDomain,
  UnifiedShortLinkServiceError,
};
