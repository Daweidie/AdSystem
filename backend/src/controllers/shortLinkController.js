const pool = require('../config/db');
const shortLinkService = require('../services/shortLinkService');
const suolinkService = require('../services/suolinkService');
const unifiedShortLinkService = require('../services/unifiedShortLinkService');
const cloudflareShortLinkService = require('../services/cloudflareShortLinkService');
const logger = require('../utils/logger');
const {
  getPlayPageBaseUrl,
  getPublicCardBaseUrl,
} = require('../services/runtimeConfigService');
const {
  createCardToken,
  buildCardUrl,
  renderCardHtml,
  toPublicHttpsUrl,
  normalizeWechatCardMode,
  collapseWhitespace,
} = require('../services/cardPageService');
const {
  cacheRemoteCardCover,
  canonicalCardCoverPath,
  isManagedCardCoverAvailable,
} = require('../services/cardCoverService');

const WECHAT_CARD_MODES = new Set(['standard', 'text_description']);

function createHttpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeId(value, fieldName) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw createHttpError(400, `${fieldName} 必须是正整数`, 'VALIDATION_ERROR');
  }

  return String(value);
}

function isPlatformAdmin(user) {
  return ['super_admin', 'system_admin'].includes(user?.role);
}

function getShortLinkScope(user, linkAlias = 'sl', videoAlias = 'v') {
  if (isPlatformAdmin(user)) return { sql: '', params: [] };

  const conditions = [`${videoAlias}.business_group_id = ?`];
  const params = [user?.business_group_id || 0];

  // 推广员可以使用本组素材，但只能查看、统计和管理自己创建的短链接。
  if (user?.role === 'general_user') {
    conditions.push(`${linkAlias}.created_by = ?`);
    params.push(user.id);
  }

  return { sql: ` AND ${conditions.join(' AND ')}`, params };
}

function requestedWechatCardMode(value) {
  const mode = String(value || 'standard').trim().toLowerCase();
  if (!WECHAT_CARD_MODES.has(mode)) {
    throw createHttpError(
      400,
      'wechatCardMode 仅支持 standard 或 text_description',
      'VALIDATION_ERROR',
    );
  }
  return mode;
}

function cardContentSecurityPolicy(mode) {
  const imageSource = normalizeWechatCardMode(mode) === 'text_description'
    ? ''
    : ' img-src https:;';
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';${imageSource} base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

async function buildCardCoverUrl(value, req, baseUrl = '') {
  const cached = await cacheRemoteCardCover(value);
  return toPublicHttpsUrl(cached?.publicPath || value, req, baseUrl);
}

async function prepareCardTarget(target) {
  if (normalizeWechatCardMode(target.wechatCardMode || target.wechat_card_mode) === 'text_description') {
    return target;
  }

  const candidates = [
    target.cardCoverUrl,
    target.card_cover_url,
    target.coverUrl,
    target.video_cover_url,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  let resolvedCover = null;
  for (const source of candidates) {
    if (isManagedCardCoverAvailable(source)) {
      resolvedCover = { publicPath: canonicalCardCoverPath(source) };
      break;
    }
    const cached = await cacheRemoteCardCover(source);
    if (cached?.publicPath && isManagedCardCoverAvailable(cached.publicPath)) {
      resolvedCover = cached;
      break;
    }
  }
  if (!resolvedCover) return target;

  const shortLinkId = target.shortLinkId || target.short_link_id;
  const currentCardCover = target.cardCoverUrl ?? target.card_cover_url ?? null;
  if (shortLinkId) {
    try {
      await pool.execute(
        `UPDATE short_links
         SET card_cover_url = ?
         WHERE id = ? AND (card_cover_url IS NULL OR card_cover_url = ?)`,
        [resolvedCover.publicPath, shortLinkId, currentCardCover],
      );
    } catch (error) {
      logger.warn('card_cover_cache_persist_failed', {
        code: error.code || 'DB_UPDATE_FAILED',
        shortLinkId,
      });
    }
  }

  return {
    ...target,
    cardCoverUrl: resolvedCover.publicPath,
    card_cover_url: resolvedCover.publicPath,
  };
}

function absoluteHttpUrl(value, req) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, `${req.protocol}://${req.get('host')}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function renderShortLinkCardPage(target, req, redirectUrl) {
  const title = String(target.cardTitle || target.title || '视频播放').slice(0, 255);
  const description = String(
    target.cardDescription || target.description || '点击查看视频素材',
  ).slice(0, 2000);
  // Nginx 会把公开的 /:code 重写到 /api/short/:code，必须使用数据库中保存的
  // 原始短链，避免微信卡片展示内部 API 路径。
  const shareUrl = absoluteHttpUrl(target.shortUrl || req.originalUrl, req);
  const targetUrl = new URL(redirectUrl);
  const redirectTarget = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  let cardBaseUrl = target.domain || '';
  try {
    cardBaseUrl = new URL(target.longUrl || target.url).origin;
  } catch {
    // 历史异常数据回退到当前请求域名，不影响短链本身的路由。
  }
  return renderCardHtml({
    card_token: target.cardToken,
    card_title: title,
    card_description: description,
    card_cover_url: target.cardCoverUrl || target.coverUrl,
    wechat_card_mode: target.wechatCardMode,
  }, req, redirectTarget, { pageUrl: shareUrl, baseUrl: cardBaseUrl });
}

function buildSelfPlayPath(fileId, shortLinkId) {
  const query = new URLSearchParams({
    fileId: String(fileId),
    shortLinkId: String(shortLinkId),
  });
  return `/play?${query.toString()}`;
}

function renderSelfShortLinkCardPage(target, req) {
  const playPath = buildSelfPlayPath(target.fileId, target.shortLinkId);
  return renderCardHtml({
    card_token: target.cardToken,
    card_title: target.cardTitle,
    card_description: target.cardDescription,
    card_cover_url: target.cardCoverUrl,
    video_title: target.title,
    video_description: target.description,
    video_cover_url: target.coverUrl,
    wechat_card_mode: target.wechatCardMode,
  }, req, playPath, { baseUrl: target.domain || target.shortUrl || '' });
}

function renderPublicShortLinkError(status) {
  const message = status === 410 ? '短链接已过期' : '短链接不存在或已停用';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" />`+
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`+
    `<title>${message}</title></head><body><main><h1>${message}</h1></main></body></html>`;
}

async function serveCardPage(req, res, next) {
  try {
    const cardToken = String(req.params.cardToken || '').trim();
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(cardToken)) {
      return res.status(404).type('html').send('卡片不存在');
    }

    const [rows] = await pool.execute(
      `SELECT sl.id AS short_link_id, sl.short_code, sl.card_token, sl.card_title,
              sl.card_description, sl.card_cover_url, sl.card_status,
              sl.wechat_card_mode, d.domain,
              sl.status AS short_link_status, sl.expires_at,
              v.file_id, v.title AS video_title, v.description AS video_description,
              v.cover_url AS video_cover_url, v.status AS video_status,
              v.expires_at AS video_expires_at
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.card_token = ?
       LIMIT 1`,
      [cardToken],
    );
    const card = rows[0];
    if (!card) return res.status(404).type('html').send('卡片不存在');

    const expired = card.short_link_status === 'expired'
      || card.video_status === 'expired'
      || (card.expires_at && new Date(card.expires_at).getTime() <= Date.now())
      || (card.video_expires_at && new Date(card.video_expires_at).getTime() <= Date.now());
    if (expired) return res.status(410).type('html').send('卡片已失效');
    if (card.short_link_status !== 'active' || card.video_status !== 'ready') {
      return res.status(404).type('html').send('卡片不存在');
    }

    if (String(req.query._shortCode || '') !== String(card.short_code)) {
      await shortLinkService.recordClickById(card.short_link_id, {
        referer: req.get('referer'),
        userAgent: req.get('user-agent'),
        ipAddress: req.ip,
      });
    }

    const playPath = buildSelfPlayPath(card.file_id, card.short_link_id);
    const html = renderCardHtml(await prepareCardTarget(card), req, playPath, {
      baseUrl: card.domain,
    });
    return res
      .status(200)
      .set('Content-Type', 'text/html; charset=UTF-8')
      .set('Cache-Control', 'public, max-age=0, must-revalidate')
      .set('Content-Security-Policy', cardContentSecurityPolicy(card.wechat_card_mode))
      .set('Referrer-Policy', 'no-referrer')
      .set('X-Content-Type-Options', 'nosniff')
      .send(html);
  } catch (error) {
    return next(error);
  }
}

async function buildPlayUrl(req, fileId, baseUrl) {
  const configuredUrl =
    baseUrl || (await getPlayPageBaseUrl()) || req.get('origin');

  if (!configuredUrl) {
    throw createHttpError(
      500,
      '缺少 PLAY_PAGE_BASE_URL 或 FRONTEND_URL，无法生成播放页地址',
      'PLAY_URL_CONFIG_ERROR',
    );
  }

  const url = new URL(configuredUrl);

  if (!/\/play\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/play`;
  }

  url.searchParams.set('fileId', fileId);
  return url.toString();
}

function extractProviderClicks(stats) {
  const candidates = [
    stats?.totalClicks,
    stats?.total_clicks,
    stats?.clicks,
    stats?.click,
    stats?.count,
    stats?.pv,
  ];

  for (const value of candidates) {
    const parsed = Number(value);

    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return null;
}

async function generateShortLink(req, res, next) {
  try {
    const wechatCardMode = requestedWechatCardMode(
      req.body?.wechatCardMode ?? req.body?.wechat_card_mode,
    );
    const requestedVideoId = req.body?.videoId ?? req.body?.video_id;
    const providedLongUrl =
      typeof req.body?.longUrl === 'string' ? req.body.longUrl.trim() : '';
    let videoRows;

    if (requestedVideoId !== undefined && requestedVideoId !== null) {
      const videoId = normalizeId(requestedVideoId, 'videoId');
      [videoRows] = await pool.execute(
        `SELECT id, file_id, title, description, cover_url, business_group_id,
                status, expires_at
         FROM videos WHERE id = ? LIMIT 1`,
        [videoId],
      );
    } else {
      let fileId;

      try {
        fileId = new URL(providedLongUrl).searchParams.get('fileId');
      } catch {
        fileId = null;
      }

      if (!fileId) {
        throw createHttpError(
          400,
          'videoId 不能为空，或 longUrl 中必须包含 fileId',
          'VALIDATION_ERROR',
        );
      }

      [videoRows] = await pool.execute(
        `SELECT id, file_id, title, description, cover_url, business_group_id,
                status, expires_at
         FROM videos WHERE file_id = ? LIMIT 1`,
        [fileId],
      );
    }

    if (videoRows.length === 0) {
      throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
    }

    if (
      !['super_admin', 'system_admin'].includes(req.auth?.role) &&
      String(videoRows[0].business_group_id || '') !== String(req.auth?.business_group_id || '')
    ) {
      throw createHttpError(403, '只能使用本业务组的素材', 'PERMISSION_DENIED');
    }

    // 生成入口提前拦截过期视频，避免把已过期的日期传给第三方缩链服务。
    if (
      videoRows[0].status !== 'ready'
      || (videoRows[0].expires_at
        && new Date(videoRows[0].expires_at).getTime() <= Date.now())
    ) {
      throw createHttpError(410, '视频未就绪或已过期', 'VIDEO_NOT_AVAILABLE');
    }

    const videoId = String(videoRows[0].id);
    const cardToken = createCardToken();
    const cardBaseUrl = await getPublicCardBaseUrl();
    const longUrl = buildCardUrl(req, cardToken, cardBaseUrl);
    const result = await unifiedShortLinkService.createShortLink(
      longUrl,
      req.body?.platform || 'auto',
      {
        videoId,
        cardToken,
        cardTitle: videoRows[0].title,
        cardDescription: videoRows[0].description,
        cardCoverUrl: wechatCardMode === 'text_description'
          ? null
          : await buildCardCoverUrl(videoRows[0].cover_url, req, cardBaseUrl),
        wechatCardMode,
        allowFallback: req.body?.allowFallback !== false,
        preferredSelfOrigin: new URL(cardBaseUrl).origin,
        requirePreferredSelfOrigin: true,
        createdBy: req.auth.id,
      },
    );

    return res.status(201).json({
      success: true,
      data: {
        ...result,
        cardToken: result.cardToken || cardToken,
        cardUrl: buildCardUrl(req, result.cardToken || cardToken, cardBaseUrl),
        cardStatus: result.cardStatus || 'draft',
        wechatCardMode,
      },
      message: result.fallbackFrom
        ? '缩链服务不可用，已降级为自建短链'
        : '短链接生成成功',
    });
  } catch (error) {
    return next(error);
  }
}

async function selfCreateShortLink(req, res, next) {
  try {
    const wechatCardMode = requestedWechatCardMode(
      req.body?.wechatCardMode ?? req.body?.wechat_card_mode,
    );
    const videoId = normalizeId(req.body?.videoId ?? req.body?.video_id, 'videoId');
    const [videoRows] = await pool.execute(
      `SELECT id, file_id, title, description, cover_url, business_group_id,
              status, expires_at
       FROM videos WHERE id = ? LIMIT 1`,
      [videoId],
    );
    const video = videoRows[0];
    if (!video) throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
    if (
      !['super_admin', 'system_admin'].includes(req.auth?.role)
      && String(video.business_group_id || '')
        !== String(req.auth?.business_group_id || '')
    ) {
      throw createHttpError(403, '只能使用本业务组的素材', 'PERMISSION_DENIED');
    }
    if (
      video.status !== 'ready'
      || (video.expires_at && new Date(video.expires_at).getTime() <= Date.now())
    ) {
      throw createHttpError(410, '视频未就绪或已过期', 'VIDEO_NOT_AVAILABLE');
    }

    const cardToken = createCardToken();
    const longUrl = await buildPlayUrl(req, video.file_id);
    const cardBaseUrl = await getPublicCardBaseUrl();
    const publicOrigin = new URL(cardBaseUrl).origin;
    const requestedTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const requestedDescription = typeof req.body?.description === 'string'
      ? req.body.description.trim()
      : '';
    if (requestedTitle.length > 255) {
      throw createHttpError(400, '卡片标题不能超过 255 个字符', 'VALIDATION_ERROR');
    }
    if (requestedDescription.length > 2000) {
      throw createHttpError(400, '卡片描述不能超过 2000 个字符', 'VALIDATION_ERROR');
    }

    const result = await unifiedShortLinkService.createShortLink(longUrl, 'self', {
      videoId,
      cardToken,
      cardTitle: requestedTitle || video.title,
      cardDescription: requestedDescription || video.description,
      cardCoverUrl: wechatCardMode === 'text_description'
        ? null
        : await buildCardCoverUrl(req.body?.coverUrl || video.cover_url, req, cardBaseUrl),
      wechatCardMode,
      shortPathPrefix: 's',
      preferredSelfOrigin: publicOrigin,
      requirePreferredSelfOrigin: true,
      allowFallback: false,
      createdBy: req.auth.id,
    });

    return res.status(201).json({
      success: true,
      data: {
        ...result,
        platform: 'self',
        cardToken,
        cardUrl: result.shortUrl,
        cardStatus: result.cardStatus || 'draft',
        wechatCardMode,
      },
      message: '自建短链接生成成功',
    });
  } catch (error) {
    return next(error);
  }
}

async function createSelfAbTestLinks(req, res, next) {
  const createdLinks = [];
  try {
    const videoId = normalizeId(req.body?.videoId ?? req.body?.video_id, 'videoId');
    const [videoRows] = await pool.execute(
      `SELECT id, file_id, title, description, cover_url, business_group_id,
              status, expires_at
       FROM videos WHERE id = ? LIMIT 1`,
      [videoId],
    );
    const video = videoRows[0];
    if (!video) throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
    if (
      !['super_admin', 'system_admin'].includes(req.auth?.role)
      && String(video.business_group_id || '')
        !== String(req.auth?.business_group_id || '')
    ) {
      throw createHttpError(403, '只能使用本业务组的素材', 'PERMISSION_DENIED');
    }
    if (
      video.status !== 'ready'
      || (video.expires_at && new Date(video.expires_at).getTime() <= Date.now())
    ) {
      throw createHttpError(410, '视频未就绪或已过期', 'VIDEO_NOT_AVAILABLE');
    }

    const requestedTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const requestedDescription = typeof req.body?.description === 'string'
      ? req.body.description
      : '';
    if (requestedTitle.length > 255) {
      throw createHttpError(400, '卡片标题不能超过 255 个字符', 'VALIDATION_ERROR');
    }
    if (requestedDescription.length > 2000) {
      throw createHttpError(400, '卡片描述不能超过 2000 个字符', 'VALIDATION_ERROR');
    }
    const title = requestedTitle || video.title || '视频播放';
    const normalizedDescription = collapseWhitespace(
      requestedDescription || video.description || '点击查看视频内容',
    );
    const description = Array.from(normalizedDescription)
      .slice(0, 120)
      .join('') || '点击查看视频内容';
    const longUrl = await buildPlayUrl(req, video.file_id);
    const cardBaseUrl = await getPublicCardBaseUrl();

    for (const wechatCardMode of ['standard', 'text_description']) {
      const cardToken = createCardToken();
      const publicOrigin = new URL(cardBaseUrl).origin;
      const result = await unifiedShortLinkService.createShortLink(longUrl, 'self', {
        videoId,
        cardToken,
        cardTitle: title,
        cardDescription: description,
        cardCoverUrl: wechatCardMode === 'standard'
          ? await buildCardCoverUrl(req.body?.coverUrl || video.cover_url, req, cardBaseUrl)
          : null,
        wechatCardMode,
        shortPathPrefix: 's',
        preferredSelfOrigin: publicOrigin,
        requirePreferredSelfOrigin: true,
        allowFallback: false,
        createdBy: req.auth.id,
      });
      createdLinks.push({
        ...result,
        platform: 'self',
        cardToken,
        cardUrl: result.shortUrl,
        cardStatus: result.cardStatus || 'draft',
        wechatCardMode,
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        standard: createdLinks[0],
        textDescription: createdLinks[1],
      },
      message: 'A/B 测试短链接已生成',
    });
  } catch (error) {
    if (createdLinks.length) {
      await Promise.allSettled(createdLinks.map(async (link) => {
        if (link.externalService === 'cloudflare') {
          await cloudflareShortLinkService.deleteMapping(link.shortCode);
        }
        await pool.execute('DELETE FROM short_links WHERE id = ?', [link.id]);
      }));
    }
    return next(error);
  }
}

async function listShortLinks(req, res, next) {
  try {
    const parameters = [];
    const conditions = [];

    const requestedVideoId = req.query.videoId ?? req.query.video_id;

    if (requestedVideoId) {
      parameters.push(normalizeId(requestedVideoId, 'videoId'));
      conditions.push('sl.video_id = ?');
    }
    const scope = getShortLinkScope(req.auth);
    parameters.push(...scope.params);
    if (scope.sql) conditions.push(scope.sql.slice(5));
    const videoFilter = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sortDirection = String(req.query.sort || '').toLowerCase() === 'asc'
      ? 'ASC'
      : 'DESC';

    await pool.execute(
      `UPDATE short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       SET sl.status = 'expired'
       WHERE sl.status <> 'expired'
         AND ((sl.expires_at IS NOT NULL AND sl.expires_at <= NOW())
              OR v.expires_at <= NOW()
              OR v.status IN ('expired', 'deleted'))`,
    );

    const [rows] = await pool.execute(
      `SELECT sl.id, sl.video_id, v.title AS video_title, v.file_id,
              sl.short_code, sl.long_url, sl.short_url,
              sl.card_token, sl.card_title, sl.card_description,
              sl.card_cover_url, sl.card_status, sl.wechat_card_mode,
              COALESCE(sl.platform, d.platform,
                CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
              ) AS platform,
              d.domain, sl.clicks, sl.status, sl.expires_at,
              sl.created_at, sl.updated_at
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       ${videoFilter}
       ORDER BY sl.created_at ${sortDirection}, sl.id ${sortDirection}`,
      parameters,
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        clicks: Number(row.clicks || 0),
        external_service: cloudflareShortLinkService.isManagedDomain(row.domain)
          ? 'cloudflare'
          : null,
        card_status: row.card_status || 'draft',
        wechat_card_mode: normalizeWechatCardMode(row.wechat_card_mode),
        needs_regeneration: row.platform === 'suolink'
          && (!row.card_token || !/\/card\/[A-Za-z0-9_-]+(?:$|\?)/.test(row.long_url || '')),
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function getShortLinkStats(req, res, next) {
  try {
    const shortLinkId = normalizeId(req.params.id, 'shortLinkId');
    const scope = getShortLinkScope(req.auth);
    const scopeParameters = [shortLinkId, ...scope.params];
    const [rows] = await pool.execute(
      `SELECT sl.id, sl.short_url, sl.short_code, sl.provider_link_id, sl.clicks,
              d.domain,
              COALESCE(sl.platform, d.platform,
                CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
              ) AS platform,
              SUM(CASE WHEN pl.device_type = 'mobile' THEN 1 ELSE 0 END) AS mobile_clicks,
              SUM(CASE WHEN pl.device_type = 'pc' THEN 1 ELSE 0 END) AS pc_clicks
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       LEFT JOIN play_logs pl
         ON pl.short_link_id = sl.id AND pl.event_type = 'redirect'
       WHERE sl.id = ?${scope.sql}
       GROUP BY sl.id, sl.short_url, sl.short_code, sl.provider_link_id,
                sl.clicks, sl.platform, d.platform, d.type, d.domain
       LIMIT 1`,
      scopeParameters,
    );

    if (rows.length === 0) {
      throw createHttpError(404, '短链接不存在', 'SHORT_LINK_NOT_FOUND');
    }

    let totalClicks = Number(rows[0].clicks || 0);

    if (cloudflareShortLinkService.isManagedDomain(rows[0].domain)) {
      try {
        const externalStats = await cloudflareShortLinkService.getMapping(rows[0].short_code);
        const externalClicks = Number(externalStats?.clickCount);
        if (Number.isFinite(externalClicks) && externalClicks >= 0) {
          totalClicks = Math.max(totalClicks, Math.floor(externalClicks));
          await pool.execute(
            `UPDATE short_links SET clicks = GREATEST(clicks, ?) WHERE id = ?`,
            [totalClicks, shortLinkId],
          );
        }
      } catch (error) {
        logger.warn('cloudflare_statistics_cache_fallback', {
          code: error.code || 'CLOUDFLARE_STATS_FAILED',
          shortLinkId,
          cacheValue: totalClicks,
        });
      }
    }

    if (rows[0].platform === 'suolink' && process.env.SUOLINK_STATS_API_URL) {
      try {
        const providerStats = await suolinkService.getLinkStats(
          rows[0].provider_link_id || rows[0].short_code,
        );
        const providerClicks = extractProviderClicks(providerStats);

        if (providerClicks !== null) {
          totalClicks = Math.max(totalClicks, providerClicks);
          await pool.execute(
            `UPDATE short_links SET clicks = GREATEST(clicks, ?) WHERE id = ?`,
            [totalClicks, shortLinkId],
          );
        }
      } catch (error) {
        // 第三方统计不可用时仍返回数据库中的最近一次点击量。
        logger.warn('suolink_statistics_cache_fallback', {
          code: error.code || 'SUOLINK_STATS_FAILED',
          shortLinkId,
          targetPlatform: 'suolink',
          cacheValue: totalClicks,
        });
      }
    }

    return res.json({
      success: true,
      data: {
        id: rows[0].id,
        shortUrl: rows[0].short_url,
        totalClicks,
        mobileClicks: Number(rows[0].mobile_clicks || 0),
        pcClicks: Number(rows[0].pc_clicks || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function toggleShortLink(req, res, next) {
  let connection;
  let transactionFinished = false;

  try {
    const shortLinkId = normalizeId(
      req.body?.shortLinkId ?? req.body?.id,
      'shortLinkId',
    );
    const scope = getShortLinkScope(req.auth);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT sl.id, sl.short_code, sl.long_url, sl.short_url,
              sl.card_title, sl.card_description, sl.card_cover_url,
              sl.wechat_card_mode,
              sl.status, sl.expires_at, d.domain,
              v.title AS video_title, v.description AS video_description,
              v.cover_url AS video_cover_url, v.business_group_id,
              v.status AS video_status, v.expires_at AS video_expires_at
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.id = ?${scope.sql}
       LIMIT 1
       FOR UPDATE`,
      [shortLinkId, ...scope.params],
    );

    if (rows.length === 0) {
      throw createHttpError(404, '短链接不存在', 'SHORT_LINK_NOT_FOUND');
    }

    const row = rows[0];
    const expired =
      (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) ||
      (row.video_expires_at &&
        new Date(row.video_expires_at).getTime() <= Date.now()) ||
      ['expired', 'deleted'].includes(row.video_status);

    if (expired) {
      await connection.execute(
        `UPDATE short_links SET status = 'expired' WHERE id = ?`,
        [shortLinkId],
      );
      await connection.commit();
      transactionFinished = true;
      throw createHttpError(409, '已过期的短链接不能重新启用', 'SHORT_LINK_EXPIRED');
    }

    const shouldEnable =
      typeof req.body?.enabled === 'boolean'
        ? req.body.enabled
        : row.status !== 'active';
    const status = shouldEnable ? 'active' : 'disabled';

    await connection.execute(
      `UPDATE short_links SET status = ? WHERE id = ?`,
      [status, shortLinkId],
    );
    await connection.commit();
    transactionFinished = true;

    if (
      cloudflareShortLinkService.isManagedDomain(row.domain)
      && normalizeWechatCardMode(row.wechat_card_mode) === 'standard'
    ) {
      if (status === 'active') {
        await cloudflareShortLinkService.createMapping({
          shortCode: row.short_code,
          targetUrl: row.long_url,
          ogTitle: row.card_title || row.video_title || '视频播放',
          ogDescription: row.card_description || row.video_description || '点击查看视频素材',
          ogImage: toPublicHttpsUrl(row.card_cover_url || row.video_cover_url, req),
          ogUrl: row.short_url,
          expiresAt: row.expires_at,
        });
      } else {
        await cloudflareShortLinkService.deleteMapping(row.short_code);
      }
    }

    return res.json({
      success: true,
      data: { id: row.id, status },
      message: status === 'active' ? '短链接已启用' : '短链接已停用',
    });
  } catch (error) {
    if (connection && !transactionFinished) {
      await connection.rollback();
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

async function redirectByCode(req, res, next) {
  try {
    const target = await shortLinkService.redirect(req.params.code, {
      referer: req.get('referer'),
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });

    if (!target?.url) {
      return res.status(404).json({
        success: false,
        data: null,
        code: 'SHORT_LINK_NOT_FOUND',
        message: '短链接不存在',
      });
    }

    const redirectUrl = new URL(target.url);
    redirectUrl.searchParams.set('shortLinkId', String(target.shortLinkId));
    if (/^\/card\/[A-Za-z0-9_-]{20,128}\/?$/.test(redirectUrl.pathname)) {
      redirectUrl.searchParams.set('_shortCode', req.params.code);
    }
    const html = renderShortLinkCardPage(await prepareCardTarget(target), req, redirectUrl);
    return res
      .status(200)
      .set('Cache-Control', 'public, max-age=0, must-revalidate')
      .set('Content-Security-Policy', cardContentSecurityPolicy(target.wechatCardMode))
      .set('Referrer-Policy', 'no-referrer')
      .set('X-Content-Type-Options', 'nosniff')
      .type('html')
      .send(html);
  } catch (error) {
    return next(error);
  }
}

async function serveSelfShortLinkCard(req, res, next) {
  try {
    const target = await shortLinkService.resolveSelfCard(req.params.shortCode, {
      referer: req.get('referer'),
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });
    if (!target) {
      return res
        .status(404)
        .set('Content-Type', 'text/html; charset=UTF-8')
        .send(renderPublicShortLinkError(404));
    }

    return res
      .status(200)
      .set('Content-Type', 'text/html; charset=UTF-8')
      .set('Cache-Control', 'public, max-age=0, must-revalidate')
      .set('Content-Security-Policy', cardContentSecurityPolicy(target.wechatCardMode))
      .set('Referrer-Policy', 'no-referrer')
      .set('X-Content-Type-Options', 'nosniff')
        .send(renderSelfShortLinkCardPage(await prepareCardTarget(target), req));
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) {
      return res
        .status(error.status)
        .set('Content-Type', 'text/html; charset=UTF-8')
        .send(renderPublicShortLinkError(error.status));
    }
    return next(error);
  }
}

async function deleteSelfShortLink(req, res, next) {
  try {
    const shortLinkId = normalizeId(req.params.id, 'shortLinkId');
    const scope = getShortLinkScope(req.auth);
    const [rows] = await pool.execute(
      `SELECT sl.id, sl.short_code, sl.card_cover_url,
              COALESCE(sl.platform, d.platform,
                CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END) AS platform,
              d.domain, v.business_group_id
       FROM short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.id = ?${scope.sql} LIMIT 1`,
      [shortLinkId, ...scope.params],
    );
    const link = rows[0];
    if (!link) throw createHttpError(404, '短链接不存在', 'SHORT_LINK_NOT_FOUND');
    if (
      !['super_admin', 'system_admin'].includes(req.auth?.role)
      && String(link.business_group_id || '')
        !== String(req.auth?.business_group_id || '')
    ) {
      throw createHttpError(403, '只能删除本业务组的短链', 'PERMISSION_DENIED');
    }
    if (link.platform !== 'self') {
      throw createHttpError(
        409,
        '此接口仅删除自建短链，Suolink 数据未作修改',
        'SELF_SHORT_LINK_REQUIRED',
      );
    }

    if (cloudflareShortLinkService.isManagedDomain(link.domain)) {
      await cloudflareShortLinkService.deleteMapping(link.short_code);
    }
    await pool.execute('DELETE FROM short_links WHERE id = ?', [shortLinkId]);
    return res.json({
      success: true,
      data: { id: shortLinkId },
      message: '自建短链接已删除',
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getShortLinkScope,
  generateShortLink,
  selfCreateShortLink,
  createSelfAbTestLinks,
  listShortLinks,
  getShortLinkStats,
  toggleShortLink,
  redirectByCode,
  serveSelfShortLinkCard,
  deleteSelfShortLink,
  serveCardPage,
  renderShortLinkCardPage,
  renderSelfShortLinkCardPage,
};
