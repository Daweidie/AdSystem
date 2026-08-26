const path = require('path');
const fs = require('fs/promises');
const pool = require('../config/db');
const vodService = require('../services/vodService');
const unifiedShortLinkService = require('../services/unifiedShortLinkService');
const cloudflareShortLinkService = require('../services/cloudflareShortLinkService');
const { detectDeviceType } = require('../services/shortLinkService');
const logger = require('../utils/logger');
const { getPlayPageBaseUrl, getPublicCardBaseUrl } = require('../services/runtimeConfigService');
const {
  createCardToken,
  buildCardUrl,
  toPublicHttpsUrl,
} = require('../services/cardPageService');
const {
  cacheRemoteCardCover,
  canonicalCardCoverPath,
  isManagedCardCoverAvailable,
  readCardCoverDimensions,
} = require('../services/cardCoverService');

const DEFAULT_RETENTION_DAYS = 3;
const MAX_VIDEO_UPLOAD_SIZE_BYTES = 800 * 1024 * 1024;

function getRetentionDays() {
  const parsed = Number.parseInt(process.env.VIDEO_RETENTION_DAYS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function createHttpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isPositiveId(value) {
  return /^\d+$/.test(String(value)) && BigInt(value) > 0n;
}

function normalizePositiveId(value, fieldName) {
  if (!isPositiveId(value)) {
    throw createHttpError(400, `${fieldName} 必须是正整数`, 'VIDEO_VALIDATION_ERROR');
  }

  return String(value);
}

function normalizeText(value, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  return value.trim().slice(0, maximumLength);
}

function normalizeFileId(value) {
  const fileId = typeof value === 'string' ? value.trim() : '';

  if (!fileId || fileId.length > 128) {
    throw createHttpError(400, 'fileId 格式不正确', 'VIDEO_VALIDATION_ERROR');
  }

  return fileId;
}

async function markVideoExpired(videoId) {
  const connection = await pool.getConnection();
  let links = [];

  try {
    await connection.beginTransaction();
    [links] = await connection.execute(
      `SELECT sl.short_code, d.domain
       FROM short_links sl
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.video_id = ? AND sl.status <> 'expired'`,
      [videoId],
    );
    await connection.execute(
      `UPDATE videos SET status = 'expired'
       WHERE id = ? AND status NOT IN ('expired', 'deleted')`,
      [videoId],
    );
    await connection.execute(
      `UPDATE short_links SET status = 'expired'
       WHERE video_id = ? AND status <> 'expired'`,
      [videoId],
    );
    await connection.commit();
    await cloudflareShortLinkService.deleteMappingsBestEffort(links, 'video_expired');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function findVideoAccess(fileId) {
  const [rows] = await pool.execute(
    `SELECT id, file_id, title, description, cover_url, status, expires_at,
            (expires_at <= NOW()) AS is_expired
     FROM videos
     WHERE file_id = ?
     LIMIT 1`,
    [normalizeFileId(fileId)],
  );
  const video = rows[0];

  if (!video) {
    throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
  }

  if (video.status === 'deleted') {
    throw createHttpError(410, '视频已删除，无法播放', 'VIDEO_DELETED');
  }

  if (video.is_expired || video.status === 'expired') {
    await markVideoExpired(video.id);
    throw createHttpError(410, '视频已过期，无法播放', 'VIDEO_EXPIRED');
  }

  if (video.status === 'disabled') {
    throw createHttpError(403, '视频已停用', 'VIDEO_DISABLED');
  }

  if (video.status !== 'ready') {
    throw createHttpError(409, '视频暂未准备好', 'VIDEO_NOT_READY');
  }

  return video;
}

function isExpiredAt(value) {
  return Boolean(value) && new Date(value).getTime() <= Date.now();
}

function buildDatabaseSharePath(link) {
  if (link.platform === 'self' && /^[A-Za-z0-9]{6,8}$/.test(String(link.short_code || ''))) {
    return `/s/${link.short_code}`;
  }
  if (
    link.platform === 'suolink'
    && /^[A-Za-z0-9_-]{20,128}$/.test(String(link.card_token || ''))
  ) {
    return `/card/${link.card_token}`;
  }
  return null;
}

async function findPlaybackShareContext(shortLinkId, video) {
  if (shortLinkId == null || String(shortLinkId).trim() === '') return null;
  if (!isPositiveId(shortLinkId)) {
    throw createHttpError(404, '短链接不存在', 'SHORT_LINK_NOT_FOUND');
  }

  const [rows] = await pool.execute(
    `SELECT sl.id AS short_link_id, sl.video_id, v.file_id,
            COALESCE(sl.platform, d.platform,
              CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END) AS platform,
            sl.short_code, sl.short_url, sl.card_token, sl.status AS short_link_status,
            sl.expires_at AS short_link_expires_at,
            sl.card_title, sl.card_description, sl.card_cover_url, sl.card_status,
            v.title AS video_title, v.description AS video_description,
            v.cover_url AS video_cover_url, v.status AS linked_video_status,
            v.expires_at AS linked_video_expires_at
     FROM short_links sl
     INNER JOIN videos v ON v.id = sl.video_id
     LEFT JOIN domains d ON d.id = sl.domain_id
     WHERE sl.id = ?
     LIMIT 1`,
    [String(shortLinkId)],
  );
  const link = rows[0];
  if (
    !link
    || String(link.video_id) !== String(video.id)
    || String(link.file_id) !== String(video.file_id)
  ) {
    throw createHttpError(404, '短链接与当前视频不匹配', 'SHORT_LINK_NOT_FOUND');
  }

  if (
    link.short_link_status === 'expired'
    || link.linked_video_status === 'expired'
    || isExpiredAt(link.short_link_expires_at)
    || isExpiredAt(link.linked_video_expires_at)
  ) {
    throw createHttpError(410, '短链接或视频已过期', 'SHORT_LINK_GONE');
  }
  if (
    link.short_link_status !== 'active'
    || link.linked_video_status !== 'ready'
    || !['self', 'suolink'].includes(link.platform)
  ) {
    throw createHttpError(404, '短链接不存在或已停用', 'SHORT_LINK_NOT_FOUND');
  }

  const sharePath = buildDatabaseSharePath(link);
  if (!sharePath && link.platform !== 'suolink') {
    throw createHttpError(404, '短链接恢复路径无效', 'SHORT_LINK_NOT_FOUND');
  }

  return { ...link, sharePath };
}

async function buildPlayPageUrl(req, fileId, providedUrl) {
  const baseUrl =
    (await getPlayPageBaseUrl()) ||
    (typeof providedUrl === 'string' && providedUrl.trim()) ||
    req.get('origin');

  if (!baseUrl) {
    throw createHttpError(
      500,
      '缺少 PLAY_PAGE_BASE_URL 或 FRONTEND_URL，无法生成播放页地址',
      'PLAY_URL_CONFIG_ERROR',
    );
  }

  const url = new URL(baseUrl);

  if (!/\/play\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/play`;
  }

  url.searchParams.set('fileId', fileId);
  return url.toString();
}

async function getUploadSignature(req, res, next) {
  try {
    const fileSize = Number(req.body?.fileSize);
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw createHttpError(400, '视频文件大小无效，请重新选择文件', 'VIDEO_FILE_SIZE_INVALID');
    }
    if (fileSize > MAX_VIDEO_UPLOAD_SIZE_BYTES) {
      throw createHttpError(413, '视频文件不能超过 800MB', 'VIDEO_FILE_TOO_LARGE');
    }

    const signature = await vodService.getUploadSignature();
    const configuredTtl = Number.parseInt(
      process.env.TENCENT_UPLOAD_SIGNATURE_TTL_SECONDS || '3600',
      10,
    );
    const ttl = Number.isInteger(configuredTtl) && configuredTtl > 0
      ? Math.min(configuredTtl, 7776000)
      : 3600;

    res.json({
      success: true,
      data: {
        signature,
        signatureExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        retentionDays: getRetentionDays(),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function completeUpload(req, res, next) {
  const {
    fileId, title, description, videoUrl, coverUrl, duration,
    businessGroupId, materialGroupId,
  } = req.body;

  let normalizedFileId;

  try {
    normalizedFileId = normalizeFileId(fileId);
  } catch (error) {
    return next(error);
  }

  if (typeof title !== 'string' || !title.trim()) {
    return next(createHttpError(400, '视频标题不能为空', 'VIDEO_VALIDATION_ERROR'));
  }

  if (title.trim().length > 255) {
    return next(createHttpError(400, '视频标题不能超过 255 个字符', 'VIDEO_VALIDATION_ERROR'));
  }

  const retentionDays = getRetentionDays();
  const scopedBusinessGroupId = ['super_admin', 'system_admin'].includes(req.auth?.role)
    ? businessGroupId
    : req.auth?.business_group_id;

  if (!scopedBusinessGroupId || !isPositiveId(scopedBusinessGroupId)) {
    return next(createHttpError(400, '必须选择有效业务组', 'VIDEO_VALIDATION_ERROR'));
  }

  if (!materialGroupId || !isPositiveId(materialGroupId)) {
    return next(createHttpError(400, '必须选择有效素材组', 'VIDEO_VALIDATION_ERROR'));
  }

  try {
    const [groupRows] = await pool.execute(
      `SELECT id FROM material_groups
       WHERE id = ? AND business_group_id = ? AND is_enabled = 1 LIMIT 1`,
      [materialGroupId, scopedBusinessGroupId],
    );
    if (!groupRows[0]) {
      return next(createHttpError(400, '素材组不属于所选业务组或已停用', 'VIDEO_VALIDATION_ERROR'));
    }
  } catch (error) {
    return next(error);
  }
  let expiresAt;

  try {
    await pool.execute(
      `INSERT INTO videos
         (file_id, title, description, cover_url, video_url, duration,
          business_group_id, material_group_id, created_by, status, expires_at, delete_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', DATE_ADD(NOW(), INTERVAL ? DAY), NULL)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         description = VALUES(description),
         cover_url = VALUES(cover_url),
         video_url = VALUES(video_url),
         duration = VALUES(duration),
         business_group_id = COALESCE(VALUES(business_group_id), business_group_id),
         material_group_id = COALESCE(VALUES(material_group_id), material_group_id),
         created_by = COALESCE(created_by, VALUES(created_by)),
         status = 'processing',
         expires_at = VALUES(expires_at),
         deleted_at = NULL,
         delete_error = NULL`,
      [
        normalizedFileId,
        title.trim(),
        normalizeText(description, 2000),
        coverUrl || null,
        videoUrl || null,
        Number.isFinite(Number(duration)) ? Number(duration) : null,
        String(scopedBusinessGroupId),
        materialGroupId && isPositiveId(materialGroupId) ? String(materialGroupId) : null,
        req.auth.id,
        retentionDays,
      ],
    );

    const [expiryRows] = await pool.execute(
      'SELECT expires_at FROM videos WHERE file_id = ? LIMIT 1',
      [normalizedFileId],
    );
    expiresAt = expiryRows[0]?.expires_at;

    if (!expiresAt) {
      throw createHttpError(500, '无法确定视频过期时间', 'VIDEO_EXPIRY_PERSIST_FAILED');
    }

    try {
      // 客户端直传不支持直接指定媒资过期时间，上传完成后通过云 API 设置。
      await vodService.setVideoExpireTime(normalizedFileId, expiresAt);
    } catch (error) {
      await pool.execute(
        `UPDATE videos
         SET status = 'failed', delete_error = ?
         WHERE file_id = ?`,
        [String(error.message || error).slice(0, 1000), normalizedFileId],
      );
      throw error;
    }

    await pool.execute(
      `UPDATE videos
       SET status = 'ready', delete_error = NULL
       WHERE file_id = ?`,
      [normalizedFileId],
    );

    const [rows] = await pool.execute(
      `SELECT id, file_id, title, description, cover_url, video_url, duration, status,
              expires_at, created_at, updated_at
       FROM videos
       WHERE file_id = ?
       LIMIT 1`,
      [normalizedFileId],
    );

    let shortLink = null;
    let shortLinkError = null;

    try {
      const cardToken = createCardToken();
      const cardBaseUrl = await getPublicCardBaseUrl();
      const longUrl = buildCardUrl(req, cardToken, cardBaseUrl);
      shortLink = await unifiedShortLinkService.createShortLink(
        longUrl,
        'auto',
        {
          videoId: rows[0].id,
          cardToken,
          cardTitle: rows[0].title,
          cardDescription: rows[0].description,
          cardCoverUrl: toPublicHttpsUrl(rows[0].cover_url, req, cardBaseUrl),
          preferredSelfOrigin: new URL(cardBaseUrl).origin,
          requirePreferredSelfOrigin: true,
          createdBy: req.auth.id,
        },
      );
    } catch (error) {
      // 短链失败不回滚已经成功的云端上传；前端仍可稍后手动重试。
      shortLinkError = error.message || '短链接自动生成失败';
      logger.warn('automatic_short_link_failed', {
        code: error.code || 'SHORT_LINK_CREATE_FAILED',
        videoId: rows[0].id,
        targetPlatform: 'auto',
        message: error.message,
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        ...rows[0],
        short_link: shortLink,
        short_link_error: shortLinkError,
      },
      message: shortLink
        ? `上传及短链生成完成，视频将在 ${retentionDays} 天后自动删除`
        : `上传完成，但短链自动生成失败，可在列表中重试`,
    });
  } catch (error) {
    return next(error);
  }
}

async function listVideos(req, res, next) {
  try {
    await pool.execute(
      `UPDATE videos
       SET status = 'expired'
       WHERE expires_at <= NOW()
         AND status NOT IN ('expired', 'deleted')`,
    );
    await pool.execute(
      `UPDATE short_links sl
       INNER JOIN videos v ON v.id = sl.video_id
       SET sl.status = 'expired'
       WHERE sl.status <> 'expired'
         AND (v.expires_at <= NOW() OR v.status IN ('expired', 'deleted'))`,
    );

    const includeDeleted = ['1', 'true'].includes(
      String(req.query.includeDeleted || '').toLowerCase(),
    );
    const scopeCondition = req.auth && !['super_admin', 'system_admin'].includes(req.auth.role)
      ? ' AND v.business_group_id = ?'
      : '';
    const scopeParameters = scopeCondition ? [req.auth.business_group_id || 0] : [];
    const [rows] = await pool.execute(
      `SELECT
         v.id,
         v.file_id,
         v.title,
         v.cover_url,
         v.video_url,
         v.duration,
         v.status,
         v.expires_at,
         v.deleted_at,
         v.created_at,
         v.updated_at,
         (SELECT COUNT(*)
          FROM play_logs pl
          WHERE pl.video_id = v.id AND pl.event_type = 'start') AS play_count,
         sl.id AS short_link_id,
         sl.short_url,
         sl.status AS short_link_status,
         sl.clicks AS short_link_clicks,
         COALESCE(sl.platform, d.platform,
           CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
         ) AS short_link_platform
       FROM videos v
       LEFT JOIN short_links sl ON sl.id = (
         SELECT sl2.id
         FROM short_links sl2
         WHERE sl2.video_id = v.id
         ORDER BY sl2.created_at DESC, sl2.id DESC
         LIMIT 1
       )
       LEFT JOIN domains d ON d.id = sl.domain_id
       WHERE (? = 1 OR v.status <> 'deleted')${scopeCondition}
       ORDER BY v.created_at DESC`,
      [includeDeleted ? 1 : 0, ...scopeParameters],
    );

    res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        play_count: Number(row.play_count || 0),
        short_link_clicks: Number(row.short_link_clicks || 0),
      })),
    });
  } catch (error) {
    next(error);
  }
}

async function getVideoInfo(req, res, next) {
  try {
    const identifier = String(req.params.id || '').trim();

    if (!identifier) {
      throw createHttpError(400, '视频标识不能为空', 'VIDEO_VALIDATION_ERROR');
    }

    const parameters = [identifier];
    let whereClause = 'file_id = ?';

    if (isPositiveId(identifier)) {
      whereClause = '(file_id = ? OR id = ?)';
      parameters.push(identifier);
    }

    const [rows] = await pool.execute(
      `SELECT id, file_id, title, description, cover_url, video_url, duration,
              status, expires_at, deleted_at, created_at, updated_at,
              (expires_at <= NOW()) AS is_expired
       FROM videos
       WHERE ${whereClause}
       LIMIT 1`,
      parameters,
    );
    const video = rows[0];

    if (!video) {
      throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
    }

    if (video.status === 'deleted') {
      throw createHttpError(410, '视频已删除，无法播放', 'VIDEO_DELETED');
    }

    if (Boolean(video.is_expired) || video.status === 'expired') {
      await markVideoExpired(video.id);
      throw createHttpError(410, '视频已过期，无法播放', 'VIDEO_EXPIRED');
    }

    if (video.status === 'disabled') {
      throw createHttpError(403, '视频已停用', 'VIDEO_DISABLED');
    }

    if (video.status !== 'ready') {
      throw createHttpError(409, '视频暂未准备好', 'VIDEO_NOT_READY');
    }

    const shareContext = await findPlaybackShareContext(req.query.shortLinkId, video);
    const shareCard = shareContext ? {
      shortLinkId: String(shareContext.short_link_id),
      platform: shareContext.platform,
      title: shareContext.card_title || video.title || '',
      description: shareContext.card_description || video.description || '',
      coverUrl: shareContext.card_cover_url || video.cover_url || '',
      link: shareContext.sharePath
        ? absoluteHttpUrl(shareContext.sharePath, req)
        : shareContext.short_url,
      status: shareContext.card_status || 'draft',
    } : null;

    const providerVideo = await vodService.getVideoInfo(
      video.file_id,
      video.expires_at,
    );

    res.json({
      success: true,
      data: {
        ...video,
        ...providerVideo,
        title: video.title || providerVideo.title,
        coverUrl: video.cover_url || providerVideo.coverUrl,
        shareCard,
        expiresAt: video.expires_at,
        is_expired: undefined,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function checkVideoAccess(req, res, next) {
  try {
    const video = await findVideoAccess(req.query.fileId);
    return res.json({
      success: true,
      data: { id: video.id, fileId: video.file_id, status: video.status },
      message: '视频可播放',
    });
  } catch (error) {
    return next(error);
  }
}

function renderStatusPage(status, title, message) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070a;color:#e2e8f0;font-family:system-ui,sans-serif}.panel{text-align:center;padding:32px}h1{font-size:24px;margin:0 0 12px}p{color:#94a3b8;margin:0}</style></head>
<body><main class="panel"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

async function renderPlayPage(video, req) {
  const indexPath = path.resolve(__dirname, '../../../frontend/dist/index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  const shareContext = video.shareContext || {};
  const title = shareContext.card_title || video.title || '视频播放';
  const description = shareContext.card_description || video.description || '点击查看视频素材';
  const sharePath = shareContext.sharePath || '';
  const pageUrl = sharePath
    ? absoluteHttpUrl(sharePath, req)
    : absoluteHttpUrl(req.originalUrl, req);
  const coverCandidates = [
    shareContext.card_cover_url,
    video.cover_url,
    '/wechat-share-default.png',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  let coverPath = '/wechat-share-default.png';
  let cachedCover = null;
  let externalFallback = '';
  for (const candidate of coverCandidates) {
    if (isManagedCardCoverAvailable(candidate)) {
      coverPath = canonicalCardCoverPath(candidate) || candidate;
      break;
    }
    if (
      !/^\/api\/media\/share-cards\//iu.test(candidate)
      && /^https:\/\//iu.test(candidate)
      && !externalFallback
    ) {
      externalFallback = candidate;
    }
    const cached = await cacheRemoteCardCover(candidate);
    if (cached?.publicPath && isManagedCardCoverAvailable(cached.publicPath)) {
      cachedCover = cached;
      coverPath = cached.publicPath;
      break;
    }
    if (/\/wechat-share-default\.png$/iu.test(candidate)) {
      coverPath = candidate;
      break;
    }
  }
  if (coverPath === '/wechat-share-default.png' && externalFallback) {
    coverPath = externalFallback;
  }
  const coverUrl = toPublicHttpsUrl(coverPath, req);
  const coverDimensions = cachedCover?.dimensions
    || readCardCoverDimensions(coverPath)
    || { width: 600, height: 600 };
  const meta = [
    sharePath
      ? `<meta name="demo18-share-path" content="${escapeHtml(sharePath)}" />`
      : '',
    `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(coverUrl)}" />`,
    `<meta property="og:image:secure_url" content="${escapeHtml(coverUrl)}" />`,
    '<meta property="og:image:type" content="image/jpeg" />',
    `<meta property="og:image:width" content="${coverDimensions.width}" />`,
    `<meta property="og:image:height" content="${coverDimensions.height}" />`,
    `<meta itemprop="name" content="${escapeHtml(title)}" />`,
    `<meta itemprop="description" content="${escapeHtml(description)}" />`,
    `<meta itemprop="image" content="${escapeHtml(coverUrl)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(coverUrl)}" />`,
  ].filter(Boolean).join('\n    ');

  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta\s+name=["']description["'][^>]*>/i,
      `<meta name="description" content="${escapeHtml(description)}" />`,
    )
    .replace('</head>', `    ${meta}\n  </head>`);
  return html;
}

async function servePlayPage(req, res, next) {
  try {
    const video = await findVideoAccess(req.query.fileId);
    const shareContext = await findPlaybackShareContext(req.query.shortLinkId, video);
    const html = await renderPlayPage({ ...video, shareContext }, req);
    return res
      .status(200)
      .set('Cache-Control', 'private, no-cache')
      .set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://web.sdk.qcloud.com; style-src 'self' 'unsafe-inline' https://web.sdk.qcloud.com; img-src 'self' https: data: blob:; media-src https: blob:; connect-src 'self' https:; worker-src blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
      .set('Referrer-Policy', 'strict-origin-when-cross-origin')
      .set('X-Content-Type-Options', 'nosniff')
      .type('html')
      .send(html);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return next(createHttpError(503, '前端尚未构建，无法加载播放页', 'PLAY_PAGE_NOT_BUILT'));
    }
    if ([404, 410].includes(error.status)) {
      return res
        .status(error.status)
        .type('html')
        .send(renderStatusPage(error.status, error.status === 410 ? '视频不可用' : '视频不存在', error.message));
    }

    return next(error);
  }
}

async function reportPlaybackEvent(req, res, next) {
  let connection;

  try {
    const videoId = normalizePositiveId(req.params.id, 'videoId');
    const eventType = String(req.body?.eventType || req.body?.event_type || '').trim();
    const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim();
    const playedSeconds = Number(req.body?.playedSeconds ?? req.body?.played_seconds ?? 0);
    const shortLinkValue = req.body?.shortLinkId ?? req.body?.short_link_id;

    if (!['start', 'progress', 'complete', 'error'].includes(eventType)) {
      throw createHttpError(400, 'eventType 不受支持', 'PLAY_EVENT_VALIDATION_ERROR');
    }

    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
      throw createHttpError(400, 'sessionId 格式不正确', 'PLAY_EVENT_VALIDATION_ERROR');
    }

    if (!Number.isFinite(playedSeconds) || playedSeconds < 0 || playedSeconds > 8640000) {
      throw createHttpError(400, 'playedSeconds 格式不正确', 'PLAY_EVENT_VALIDATION_ERROR');
    }

    const shortLinkId = shortLinkValue == null || shortLinkValue === ''
      ? null
      : normalizePositiveId(shortLinkValue, 'shortLinkId');
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [videoRows] = await connection.execute(
      `SELECT id, status, expires_at FROM videos WHERE id = ? LIMIT 1 FOR UPDATE`,
      [videoId],
    );
    const video = videoRows[0];

    if (!video) {
      throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
    }

    if (
      ['expired', 'deleted'].includes(video.status) ||
      new Date(video.expires_at).getTime() <= Date.now()
    ) {
      throw createHttpError(410, '视频已过期或已删除', 'VIDEO_GONE');
    }

    if (shortLinkId) {
      const [linkRows] = await connection.execute(
        `SELECT id FROM short_links WHERE id = ? AND video_id = ? LIMIT 1`,
        [shortLinkId, videoId],
      );

      if (linkRows.length === 0) {
        throw createHttpError(400, 'shortLinkId 与视频不匹配', 'PLAY_EVENT_VALIDATION_ERROR');
      }
    }

    if (eventType === 'start') {
      const [existing] = await connection.execute(
        `SELECT id FROM play_logs
         WHERE video_id = ? AND session_id = ? AND event_type = 'start'
         LIMIT 1`,
        [videoId, sessionId],
      );

      if (existing.length > 0) {
        await connection.commit();
        return res.json({
          success: true,
          data: { id: existing[0].id, duplicate: true },
          message: '播放开始事件已记录',
        });
      }
    }

    if (eventType === 'progress') {
      const [recent] = await connection.execute(
        `SELECT id, played_seconds, played_at FROM play_logs
         WHERE video_id = ? AND session_id = ? AND event_type = 'progress'
         ORDER BY played_at DESC, id DESC LIMIT 1`,
        [videoId, sessionId],
      );

      if (
        recent[0] &&
        Date.now() - new Date(recent[0].played_at).getTime() < 8000
      ) {
        await connection.commit();
        return res.json({
          success: true,
          data: { id: recent[0].id, throttled: true },
          message: '播放进度事件已节流',
        });
      }
    }

    const userAgent = normalizeText(req.get('user-agent'), 65535);
    const [result] = await connection.execute(
      `INSERT INTO play_logs
         (video_id, short_link_id, session_id, event_type, played_seconds,
          referer, user_agent, device_type, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        videoId,
        shortLinkId,
        sessionId,
        eventType,
        Math.round(playedSeconds * 1000) / 1000,
        normalizeText(req.get('referer'), 2048),
        userAgent,
        detectDeviceType(userAgent),
        normalizeText(req.ip, 45),
      ],
    );
    await connection.commit();

    return res.status(201).json({
      success: true,
      data: { id: result.insertId, eventType },
      message: '播放事件已记录',
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

async function deleteVideo(req, res, next) {
  let connection;
  let transactionFinished = false;
  let video;
  let affectedLinks = [];

  try {
    const videoId = normalizePositiveId(req.params.id, 'videoId');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT id, file_id, status, deleted_at, business_group_id
       FROM videos WHERE id = ? LIMIT 1 FOR UPDATE`,
      [videoId],
    );
    video = rows[0];

    if (!video) {
      throw createHttpError(404, '视频不存在', 'VIDEO_NOT_FOUND');
    }

    if (
      !['super_admin', 'system_admin'].includes(req.auth?.role) &&
      String(video.business_group_id || '') !== String(req.auth?.business_group_id || '')
    ) {
      throw createHttpError(403, '只能删除本业务组的素材', 'PERMISSION_DENIED');
    }

    if (video.status === 'deleted') {
      await connection.commit();
      transactionFinished = true;
      return res.json({
        success: true,
        data: { id: video.id, status: 'deleted', alreadyDeleted: true },
        message: '视频已经删除',
      });
    }

    try {
      await vodService.deleteVideo(video.file_id);
    } catch (error) {
      await connection.rollback();
      transactionFinished = true;
      const deleteMessage = String(error.message || '腾讯云媒资删除失败').slice(0, 1000);
      await pool.execute('UPDATE videos SET delete_error = ? WHERE id = ?', [
        deleteMessage,
        videoId,
      ]);
      logger.warn('vod_delete_failed', {
        code: error.code || 'VOD_DELETE_FAILED',
        videoId,
        status: error.status || 502,
      });
      throw createHttpError(
        error.status === 503 || error.code === 'VOD_TIMEOUT' ? 503 : 502,
        '腾讯云媒资删除失败，请稍后安全重试',
        error.code || 'VOD_DELETE_FAILED',
      );
    }

    [affectedLinks] = await connection.execute(
      `SELECT sl.short_code, d.domain
       FROM short_links sl
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.video_id = ? AND sl.status <> 'expired'`,
      [videoId],
    );

    await connection.execute(
      `UPDATE short_links SET status = 'expired'
       WHERE video_id = ? AND status <> 'expired'`,
      [videoId],
    );
    await connection.execute(
      `UPDATE videos
       SET status = 'deleted', deleted_at = COALESCE(deleted_at, NOW()), delete_error = NULL
       WHERE id = ?`,
      [videoId],
    );
    await connection.commit();
    transactionFinished = true;
    await cloudflareShortLinkService.deleteMappingsBestEffort(affectedLinks, 'video_deleted');

    return res.json({
      success: true,
      data: { id: video.id, status: 'deleted' },
      message: '视频及腾讯云媒资已删除',
    });
  } catch (error) {
    if (connection && !transactionFinished) {
      await connection.rollback().catch(() => {});
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  MAX_VIDEO_UPLOAD_SIZE_BYTES,
  getRetentionDays,
  getUploadSignature,
  completeUpload,
  listVideos,
  getVideoInfo,
  checkVideoAccess,
  servePlayPage,
  reportPlaybackEvent,
  deleteVideo,
};
