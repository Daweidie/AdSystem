const crypto = require('crypto');
const pool = require('../config/db');
const { normalizeWechatCardMode } = require('./cardPageService');
const {
  consumeGroupVisitQuota,
  GroupVisitLimitError,
} = require('./visitQuotaService');

const SHORT_CODE_CHARACTERS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MIN_SHORT_CODE_LENGTH = 6;
const MAX_SHORT_CODE_LENGTH = 8;
const MAX_GENERATION_ATTEMPTS = 20;

class ShortLinkServiceError extends Error {
  constructor(message, code, cause, status) {
    super(message);
    this.name = 'ShortLinkServiceError';
    this.code = code;
    this.status = status || {
      SHORT_LINK_VALIDATION_ERROR: 400,
      VIDEO_NOT_FOUND: 404,
      VIDEO_NOT_AVAILABLE: 410,
      PRIMARY_DOMAIN_NOT_FOUND: 409,
      PRIMARY_DOMAIN_INVALID: 500,
      SHORT_CODE_GENERATION_FAILED: 503,
    }[code] || 500;

    if (cause) {
      this.cause = cause;
    }
  }
}

function normalizeId(value, fieldName) {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^\d+$/.test(String(value)) ||
    BigInt(value) <= 0n
  ) {
    throw new ShortLinkServiceError(
      `${fieldName} 必须是正整数`,
      'SHORT_LINK_VALIDATION_ERROR',
    );
  }

  return String(value);
}

function normalizeLongUrl(longUrl) {
  if (typeof longUrl !== 'string' || !longUrl.trim()) {
    throw new ShortLinkServiceError(
      'longUrl 不能为空',
      'SHORT_LINK_VALIDATION_ERROR',
    );
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(longUrl.trim());
  } catch (error) {
    throw new ShortLinkServiceError(
      'longUrl 不是合法 URL',
      'SHORT_LINK_VALIDATION_ERROR',
      error,
    );
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new ShortLinkServiceError(
      'longUrl 仅支持 http 或 https 协议',
      'SHORT_LINK_VALIDATION_ERROR',
    );
  }

  return parsedUrl.toString();
}

function createRandomCode() {
  const length = crypto.randomInt(
    MIN_SHORT_CODE_LENGTH,
    MAX_SHORT_CODE_LENGTH + 1,
  );
  let code = '';

  for (let index = 0; index < length; index += 1) {
    const characterIndex = crypto.randomInt(0, SHORT_CODE_CHARACTERS.length);
    code += SHORT_CODE_CHARACTERS[characterIndex];
  }

  return code;
}

async function generateUniqueShortCode(database) {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const shortCode = createRandomCode();
    const [rows] = await database.execute(
      'SELECT id FROM short_links WHERE short_code = ? LIMIT 1',
      [shortCode],
    );

    if (rows.length === 0) {
      return shortCode;
    }
  }

  throw new ShortLinkServiceError(
    '多次生成短码均发生碰撞，请稍后重试',
    'SHORT_CODE_GENERATION_FAILED',
  );
}

/**
 * 生成 6-8 位、由数字和大小写字母组成且数据库中尚不存在的短码。
 * @returns {Promise<string>}
 */
async function generateShortCode() {
  return generateUniqueShortCode(pool);
}

function buildShortUrl(domain, shortCode, pathPrefix = '') {
  if (typeof domain !== 'string' || !domain.trim()) {
    throw new ShortLinkServiceError(
      '主域名配置为空',
      'PRIMARY_DOMAIN_INVALID',
    );
  }

  const domainWithProtocol = /^https?:\/\//i.test(domain.trim())
    ? domain.trim()
    : `https://${domain.trim()}`;

  let baseUrl;

  try {
    baseUrl = new URL(domainWithProtocol);
  } catch (error) {
    throw new ShortLinkServiceError(
      '主域名格式不正确',
      'PRIMARY_DOMAIN_INVALID',
      error,
    );
  }

  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new ShortLinkServiceError(
      '主域名仅支持 http 或 https 协议',
      'PRIMARY_DOMAIN_INVALID',
    );
  }

  const normalizedPrefix = String(pathPrefix || '').replace(/^\/+|\/+$/g, '');
  baseUrl.pathname = [
    baseUrl.pathname.replace(/\/+$/, ''),
    normalizedPrefix,
    shortCode,
  ].filter(Boolean).join('/').replace(/^([^/])/, '/$1');
  baseUrl.search = '';
  baseUrl.hash = '';
  return baseUrl.toString();
}

function isDuplicateKeyError(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

/**
 * 使用当前启用的主域名为视频创建短链接并写入数据库。
 * @param {number|string} videoId
 * @param {number|string} domainId
 * @param {string} longUrl
 * @returns {Promise<{
 *   id: number|string,
 *   videoId: string,
 *   domainId: string,
 *   shortCode: string,
 *   longUrl: string,
 *   shortUrl: string
 * }>}
 */
async function createShortLink(videoId, domainId, longUrl, cardOptions = {}) {
  const normalizedVideoId = normalizeId(videoId, 'videoId');
  const normalizedDomainId = normalizeId(domainId, 'domainId');
  const normalizedLongUrl = normalizeLongUrl(longUrl);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [videoRows] = await connection.execute(
      `SELECT id, expires_at
       FROM videos
       WHERE id = ?
         AND status = 'ready'
         AND expires_at > NOW()
       LIMIT 1`,
      [normalizedVideoId],
    );

    if (videoRows.length === 0) {
      throw new ShortLinkServiceError(
        '视频不存在、未就绪或已过期',
        'VIDEO_NOT_AVAILABLE',
      );
    }

    const [domainRows] = await connection.execute(
      `SELECT id, domain
       FROM domains
       WHERE id = ? AND is_enabled = 1
       LIMIT 1
       FOR UPDATE`,
      [normalizedDomainId],
    );

    if (domainRows.length === 0) {
      throw new ShortLinkServiceError(
        '指定域名不存在或未启用',
        'PRIMARY_DOMAIN_NOT_FOUND',
      );
    }

    let insertResult;
    let shortCode;
    let shortUrl;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      shortCode = await generateUniqueShortCode(connection);
      shortUrl = buildShortUrl(
        domainRows[0].domain,
        shortCode,
        cardOptions.shortPathPrefix,
      );

      try {
        [insertResult] = await connection.execute(
          `INSERT INTO short_links
             (video_id, created_by, domain_id, platform, short_code, long_url, short_url,
              card_token, card_title, card_description, card_cover_url, card_status,
              wechat_card_mode, status, expires_at, created_at)
           VALUES (?, ?, ?, 'self', ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 'active', ?, UTC_TIMESTAMP())`,
          [
            normalizedVideoId,
            cardOptions.createdBy || null,
            normalizedDomainId,
            shortCode,
            normalizedLongUrl,
            shortUrl,
            cardOptions.cardToken || null,
            cardOptions.cardTitle || null,
            cardOptions.cardDescription || null,
            cardOptions.cardCoverUrl || null,
            normalizeWechatCardMode(cardOptions.wechatCardMode),
            videoRows[0].expires_at,
          ],
        );
        break;
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }

    if (!insertResult) {
      throw new ShortLinkServiceError(
        '短码写入时连续发生碰撞，请稍后重试',
        'SHORT_CODE_GENERATION_FAILED',
      );
    }

    await connection.commit();

    return {
      id: insertResult.insertId,
      videoId: normalizedVideoId,
      domainId: normalizedDomainId,
      shortCode,
      longUrl: normalizedLongUrl,
      shortUrl,
      wechatCardMode: normalizeWechatCardMode(cardOptions.wechatCardMode),
    };
  } catch (error) {
    await connection.rollback();

    if (error instanceof ShortLinkServiceError) {
      throw error;
    }

    throw new ShortLinkServiceError(
      '创建短链接失败',
      'SHORT_LINK_CREATE_FAILED',
      error,
    );
  } finally {
    connection.release();
  }
}

/**
 * 根据 User-Agent 将访问设备归类为移动端或 PC。
 * @param {string} userAgent
 * @returns {'mobile'|'pc'}
 */
function detectDeviceType(userAgent) {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
    String(userAgent || ''),
  )
    ? 'mobile'
    : 'pc';
}

function normalizeLogValue(value, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  return value.trim().slice(0, maxLength);
}

/**
 * 解析有效短码，并在同一事务内原子增加点击数、写入访问日志。
 * @param {string} shortCode
 * @param {{referer?: string, userAgent?: string, ipAddress?: string}} context
 * @returns {Promise<{
 *   url: string,
 *   longUrl: string,
 *   shortLinkId: number|string,
 *   shortUrl: string,
 *   title: string|null,
 *   description: string|null,
 *   coverUrl: string|null
 * }|null>}
 */
async function redirect(shortCode, context = {}) {
  if (typeof shortCode !== 'string' || !/^[A-Za-z0-9]{6,8}$/.test(shortCode)) {
    throw new ShortLinkServiceError(
      'shortCode 格式不正确',
      'SHORT_LINK_VALIDATION_ERROR',
    );
  }

  const connection = await pool.getConnection();
  let transactionFinished = false;

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT sl.id, sl.video_id, sl.long_url, sl.short_url, sl.status, sl.expires_at,
              sl.card_token, sl.card_title, sl.card_description, sl.card_cover_url, sl.card_status,
              sl.wechat_card_mode, d.domain,
              v.title, v.description, v.cover_url, v.business_group_id,
              v.status AS video_status, v.expires_at AS video_expires_at
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.short_code = ?
       LIMIT 1
       FOR UPDATE`,
      [shortCode],
    );

    if (rows.length === 0) {
      await connection.rollback();
      return null;
    }

    const shortLink = rows[0];
    const linkExpired =
      shortLink.expires_at && new Date(shortLink.expires_at).getTime() <= Date.now();
    const videoExpired =
      shortLink.video_expires_at &&
      new Date(shortLink.video_expires_at).getTime() <= Date.now();
    const isUnavailable =
      shortLink.status !== 'active' ||
      linkExpired ||
      videoExpired ||
      shortLink.video_status !== 'ready';

    if (isUnavailable) {
      if (
        shortLink.status === 'active' &&
        (linkExpired || videoExpired || ['expired', 'deleted'].includes(shortLink.video_status))
      ) {
        await connection.execute(
          `UPDATE short_links SET status = 'expired' WHERE id = ?`,
          [shortLink.id],
        );
      }

      await connection.commit();
      transactionFinished = true;
      throw new ShortLinkServiceError(
        '短链接已停用或已过期',
        'SHORT_LINK_GONE',
        null,
        410,
      );
    }

    // 业务组月度访问量控制：超限访问在事务内被拒绝，点击数与日志一并回滚。
    await consumeGroupVisitQuota(connection, shortLink.business_group_id);

    await connection.execute(
      'UPDATE short_links SET clicks = COALESCE(clicks, 0) + 1 WHERE id = ?',
      [shortLink.id],
    );

    const userAgent = normalizeLogValue(context.userAgent, 65535);
    await connection.execute(
      `INSERT INTO play_logs
         (video_id, short_link_id, ip_address, user_agent, referer, device_type,
          event_type, played_seconds)
       VALUES (?, ?, ?, ?, ?, ?, 'redirect', 0)`,
      [
        shortLink.video_id,
        shortLink.id,
        normalizeLogValue(context.ipAddress, 45),
        userAgent,
        normalizeLogValue(context.referer, 2048),
        detectDeviceType(userAgent),
      ],
    );
    await connection.commit();
    transactionFinished = true;

    return {
      url: shortLink.long_url,
      longUrl: shortLink.long_url,
      shortLinkId: shortLink.id,
      shortUrl: shortLink.short_url,
      title: shortLink.title,
      description: shortLink.description,
      coverUrl: shortLink.cover_url,
      cardToken: shortLink.card_token,
      cardTitle: shortLink.card_title,
      cardDescription: shortLink.card_description,
      cardCoverUrl: shortLink.card_cover_url,
      cardStatus: shortLink.card_status,
      wechatCardMode: normalizeWechatCardMode(shortLink.wechat_card_mode),
      domain: shortLink.domain,
    };
  } catch (error) {
    if (!transactionFinished) {
      await connection.rollback();
    }

    if (error instanceof ShortLinkServiceError || error instanceof GroupVisitLimitError) {
      throw error;
    }

    throw new ShortLinkServiceError(
      '解析短链接失败',
      'SHORT_LINK_REDIRECT_FAILED',
      error,
    );
  } finally {
    connection.release();
  }
}

function selfLinkAvailability(shortLink) {
  const linkExpired = shortLink.status === 'expired'
    || (shortLink.expires_at && new Date(shortLink.expires_at).getTime() <= Date.now());
  const videoExpired = ['expired', 'deleted'].includes(shortLink.video_status)
    || (shortLink.video_expires_at
      && new Date(shortLink.video_expires_at).getTime() <= Date.now());

  if (linkExpired || videoExpired) return 'expired';
  if (shortLink.status !== 'active' || shortLink.video_status !== 'ready') return 'unavailable';
  return 'active';
}

/**
 * 解析新的 /s/{shortCode} 卡片。该入口只接受自建短链，并在同一事务中
 * 复用现有的 clicks 与 redirect 类型 play_logs 统计口径。
 */
async function resolveSelfCard(shortCode, context = {}) {
  if (typeof shortCode !== 'string' || !/^[A-Za-z0-9]{6,8}$/.test(shortCode)) {
    return null;
  }

  const connection = await pool.getConnection();
  let transactionFinished = false;

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT sl.id, sl.video_id, sl.short_code, sl.short_url, sl.status, sl.expires_at,
              sl.card_title, sl.card_description, sl.card_cover_url, sl.card_status,
              sl.wechat_card_mode, d.domain,
              v.file_id, v.title, v.description, v.cover_url, v.business_group_id,
              v.status AS video_status, v.expires_at AS video_expires_at
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.short_code = ?
         AND COALESCE(sl.platform, d.platform,
           CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END) = 'self'
       LIMIT 1
       FOR UPDATE`,
      [shortCode],
    );
    const shortLink = rows[0];

    if (!shortLink) {
      await connection.rollback();
      transactionFinished = true;
      return null;
    }

    const availability = selfLinkAvailability(shortLink);
    if (availability !== 'active') {
      if (availability === 'expired' && shortLink.status !== 'expired') {
        await connection.execute(
          `UPDATE short_links SET status = 'expired' WHERE id = ?`,
          [shortLink.id],
        );
      }
      await connection.commit();
      transactionFinished = true;
      throw new ShortLinkServiceError(
        availability === 'expired' ? '短链接已过期' : '短链接不存在或已停用',
        availability === 'expired' ? 'SHORT_LINK_GONE' : 'SHORT_LINK_NOT_FOUND',
        null,
        availability === 'expired' ? 410 : 404,
      );
    }

    // 业务组月度访问量控制：超限访问在事务内被拒绝，点击数与日志一并回滚。
    await consumeGroupVisitQuota(connection, shortLink.business_group_id);

    await connection.execute(
      'UPDATE short_links SET clicks = COALESCE(clicks, 0) + 1 WHERE id = ?',
      [shortLink.id],
    );
    const userAgent = normalizeLogValue(context.userAgent, 65535);
    await connection.execute(
      `INSERT INTO play_logs
         (video_id, short_link_id, ip_address, user_agent, referer, device_type,
          event_type, played_seconds)
       VALUES (?, ?, ?, ?, ?, ?, 'redirect', 0)`,
      [
        shortLink.video_id,
        shortLink.id,
        normalizeLogValue(context.ipAddress, 45),
        userAgent,
        normalizeLogValue(context.referer, 2048),
        detectDeviceType(userAgent),
      ],
    );
    await connection.commit();
    transactionFinished = true;

    return {
      shortLinkId: shortLink.id,
      shortCode: shortLink.short_code,
      shortUrl: shortLink.short_url,
      fileId: shortLink.file_id,
      title: shortLink.title,
      description: shortLink.description,
      coverUrl: shortLink.cover_url,
      cardTitle: shortLink.card_title,
      cardDescription: shortLink.card_description,
      cardCoverUrl: shortLink.card_cover_url,
      cardStatus: shortLink.card_status,
      wechatCardMode: normalizeWechatCardMode(shortLink.wechat_card_mode),
      domain: shortLink.domain,
    };
  } catch (error) {
    if (!transactionFinished) await connection.rollback();
    if (error instanceof ShortLinkServiceError || error instanceof GroupVisitLimitError) throw error;
    throw new ShortLinkServiceError(
      '解析自建短链接失败',
      'SHORT_LINK_REDIRECT_FAILED',
      error,
    );
  } finally {
    connection.release();
  }
}

async function recordClick(whereClause, identifier, context = {}, externalEventId = null) {
  const connection = await pool.getConnection();
  let transactionFinished = false;

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT sl.id, sl.video_id, sl.status, sl.expires_at,
              v.business_group_id,
              v.status AS video_status, v.expires_at AS video_expires_at
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       WHERE ${whereClause}
       LIMIT 1
       FOR UPDATE`,
      [identifier],
    );
    const link = rows[0];
    if (!link) {
      throw new ShortLinkServiceError(
        '短链接不存在',
        'SHORT_LINK_NOT_FOUND',
        null,
        404,
      );
    }

    const expired = link.status !== 'active'
      || link.video_status !== 'ready'
      || (link.expires_at && new Date(link.expires_at).getTime() <= Date.now())
      || (link.video_expires_at && new Date(link.video_expires_at).getTime() <= Date.now());
    if (expired) {
      if (link.status === 'active') {
        await connection.execute(
          `UPDATE short_links SET status = 'expired' WHERE id = ?`,
          [link.id],
        );
      }
      await connection.commit();
      transactionFinished = true;
      throw new ShortLinkServiceError(
        '短链接已停用或已过期',
        'SHORT_LINK_GONE',
        null,
        410,
      );
    }

    const userAgent = normalizeLogValue(context.userAgent, 65535);
    try {
      const logValues = [
        link.video_id,
        link.id,
        normalizeLogValue(context.ipAddress, 45),
        userAgent,
        normalizeLogValue(context.referer, 2048),
        detectDeviceType(userAgent),
      ];
      if (externalEventId) {
        await connection.execute(
          `INSERT INTO play_logs
             (video_id, short_link_id, ip_address, user_agent, referer, device_type,
              external_event_id, event_type, played_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'redirect', 0)`,
          [...logValues, externalEventId],
        );
      } else {
        await connection.execute(
          `INSERT INTO play_logs
             (video_id, short_link_id, ip_address, user_agent, referer, device_type,
              event_type, played_seconds)
           VALUES (?, ?, ?, ?, ?, ?, 'redirect', 0)`,
          logValues,
        );
      }
    } catch (error) {
      if (!(externalEventId && isDuplicateKeyError(error))) throw error;
      await connection.commit();
      transactionFinished = true;
      return { id: link.id, recorded: false, duplicate: true };
    }

    // 先写入带唯一事件 ID 的日志，再在同一事务内扣减额度。这样重复的
    // Worker 回写会在唯一键冲突处直接返回，不会白白消耗业务组月度额度；
    // 超限时事务回滚，日志也不会残留。
    await consumeGroupVisitQuota(connection, link.business_group_id);

    await connection.execute(
      'UPDATE short_links SET clicks = COALESCE(clicks, 0) + 1 WHERE id = ?',
      [link.id],
    );
    await connection.commit();
    transactionFinished = true;
    return { id: link.id, recorded: true, duplicate: false };
  } catch (error) {
    if (!transactionFinished) await connection.rollback();
    if (error instanceof ShortLinkServiceError || error instanceof GroupVisitLimitError) throw error;
    throw new ShortLinkServiceError(
      '记录短链接点击失败',
      'SHORT_LINK_CLICK_FAILED',
      error,
    );
  } finally {
    connection.release();
  }
}

function recordClickById(shortLinkId, context = {}) {
  const normalizedId = normalizeId(shortLinkId, 'shortLinkId');
  return recordClick('sl.id = ?', normalizedId, context);
}

function recordExternalClick(shortCode, context = {}) {
  if (typeof shortCode !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(shortCode)) {
    throw new ShortLinkServiceError(
      'shortCode 格式不正确',
      'SHORT_LINK_VALIDATION_ERROR',
    );
  }
  const eventId = normalizeLogValue(context.eventId, 64);
  if (!eventId) {
    throw new ShortLinkServiceError(
      'eventId 不能为空',
      'SHORT_LINK_VALIDATION_ERROR',
    );
  }
  return recordClick('sl.short_code = ?', shortCode, context, eventId);
}

module.exports = {
  generateShortCode,
  createShortLink,
  redirect,
  resolveSelfCard,
  recordClickById,
  recordExternalClick,
  detectDeviceType,
  ShortLinkServiceError,
};
