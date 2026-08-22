const crypto = require('crypto');
const { getPlayPageBaseUrl } = require('./runtimeConfigService');
const {
  canonicalCardCoverPath,
  readCardCoverDimensions,
} = require('./cardCoverService');

const WECHAT_CARD_MODES = new Set(['standard', 'text_description']);
const TEXT_DESCRIPTION_FALLBACK = '点击查看视频内容';

function createCardToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function configuredBaseUrl() {
  return String(process.env.PUBLIC_CARD_BASE_URL || process.env.CARD_PAGE_BASE_URL || '')
    .trim().replace(/\/+$/, '');
}

function requestBaseUrl(req) {
  try {
    const protocol = ['http', 'https'].includes(req?.protocol) ? req.protocol : 'https';
    return new URL(`${protocol}://${req.get('host')}`).origin;
  } catch {
    return '';
  }
}

function publicBaseUrl(req, explicitBaseUrl = '') {
  const raw = String(explicitBaseUrl || configuredBaseUrl() || requestBaseUrl(req)).trim();
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('invalid public card base url');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return requestBaseUrl(req);
  }
}

function buildCardUrl(req, cardToken, baseUrl = '') {
  const base = publicBaseUrl(req, baseUrl);
  if (!base) throw new Error('无法确定公共卡片域名');
  return new URL(`/card/${encodeURIComponent(cardToken)}`, `${base}/`).toString();
}

function currentRequestPageUrl(req) {
  const protocol = ['http', 'https'].includes(req.protocol) ? req.protocol : 'https';
  const baseUrl = new URL(`${protocol}://${req.get('host')}`);
  const url = new URL(req.originalUrl || req.url || '/', baseUrl);
  if (
    url.origin !== baseUrl.origin
    || url.username
    || url.password
    || !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new Error('invalid public request URL');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^(fc|fd|fe[89ab])[0-9a-f:]*$/i.test(host)) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

function toPublicHttpsUrl(value, req, baseUrl = '') {
  const raw = String(value || '').trim();
  const fallback = new URL('/wechat-share-default.png', `${publicBaseUrl(req, baseUrl)}/`).toString();
  if (!raw) return fallback;

  try {
    const url = new URL(raw, `${publicBaseUrl(req, baseUrl)}/`);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || isPrivateHostname(url.hostname)
    ) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function serializeInlineJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function normalizeWechatCardMode(value) {
  const mode = String(value || 'standard').trim().toLowerCase();
  return WECHAT_CARD_MODES.has(mode) ? mode : 'standard';
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function truncateCharacters(value, maximum) {
  return Array.from(String(value || '')).slice(0, maximum).join('');
}

function encodePlayTarget(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function renderAutoOpenBody({ title, description, coverUrl, playToken, includeCover = true }) {
  return `<body data-play-token="${playToken}">
  <main class="card">
    ${includeCover ? `<img class="cover" src="${escapeHtml(coverUrl)}" alt="${escapeHtml(title)}" />` : ''}
    <section class="content">
      <h1>${escapeHtml(title)}</h1>
      <div class="opening" role="status"><span class="spinner" aria-hidden="true"></span>正在打开视频…</div>
      <p>${escapeHtml(description)}</p>
      <noscript>请启用 JavaScript 后播放</noscript>
    </section>
  </main>
  <script>
    (() => {
      try {
        const token = document.body.getAttribute('data-play-token') || '';
        const padded = token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '=');
        const target = atob(padded);
        if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\\\')) return;
        const destination = new URL(target, window.location.origin);
        if (destination.origin !== window.location.origin || destination.username || destination.password) return;
        window.location.assign(destination.pathname + destination.search + destination.hash);
      } catch {
        // 无效或被篡改的 token 保持在安全卡片页，不执行跳转。
      }
    })();
  </script>
</body>`;
}

async function buildPlayUrl(fileId, req) {
  let baseUrl = process.env.PUBLIC_PLAY_BASE_URL || process.env.PLAY_PAGE_BASE_URL;
  if (!baseUrl) baseUrl = await getPlayPageBaseUrl();
  if (!baseUrl) baseUrl = publicBaseUrl(req);

  const url = new URL(baseUrl);
  url.protocol = 'https:';
  if (!/\/play\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/play`;
  }
  url.searchParams.set('fileId', fileId);
  return url.toString();
}

function renderCardHtml(card, req, redirectUrl, options = {}) {
  const mode = normalizeWechatCardMode(card.wechat_card_mode);
  const textDescriptionMode = mode === 'text_description';
  const title = textDescriptionMode
    ? truncateCharacters(
      collapseWhitespace(card.card_title)
        || collapseWhitespace(card.video_title)
        || '视频播放',
      255,
    )
    : String(card.card_title || card.video_title || '视频播放').slice(0, 255);
  const rawDescription = textDescriptionMode
    ? collapseWhitespace(card.card_description)
      || collapseWhitespace(card.video_description)
      || TEXT_DESCRIPTION_FALLBACK
    : card.card_description || card.video_description || '点击查看视频素材';
  const description = textDescriptionMode
    ? truncateCharacters(collapseWhitespace(rawDescription), 120) || TEXT_DESCRIPTION_FALLBACK
    : String(rawDescription).slice(0, 2000);
  const cardUrl = options.pageUrl || currentRequestPageUrl(req);
  const playToken = encodePlayTarget(redirectUrl);
  let structuredMetadata;
  let coverUrl;

  if (textDescriptionMode) {
    const jsonLd = serializeInlineJson({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: title,
      description,
      url: cardUrl,
    });
    structuredMetadata = `  <meta itemprop="name" content="${escapeHtml(title)}" />
  <meta itemprop="description" content="${escapeHtml(description)}" />
  <script type="application/ld+json">${jsonLd}</script>`;
  } else {
    const savedCoverUrl = card.card_cover_url || card.video_cover_url;
    const rawCoverUrl = canonicalCardCoverPath(savedCoverUrl) || savedCoverUrl;
    coverUrl = toPublicHttpsUrl(rawCoverUrl, req, options.baseUrl || '');
    const dimensions = readCardCoverDimensions(rawCoverUrl) || { width: 600, height: 600 };
    structuredMetadata = `  <meta property="og:image" content="${escapeHtml(coverUrl)}" />
  <meta property="og:image:secure_url" content="${escapeHtml(coverUrl)}" />
  <meta property="og:image:width" content="${dimensions.width}" />
  <meta property="og:image:height" content="${dimensions.height}" />
  <meta name="image" content="${escapeHtml(coverUrl)}" />
  <link rel="image_src" href="${escapeHtml(coverUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${escapeHtml(coverUrl)}" />`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(cardUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(cardUrl)}" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
${structuredMetadata}
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#070b14;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(560px,100%);overflow:hidden;border:1px solid #1e293b;border-radius:20px;background:#0f172a;box-shadow:0 24px 70px rgba(0,0,0,.35)}${textDescriptionMode ? '' : '.cover{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:#111827}'}.content{padding:24px}h1{margin:0 0 10px;font-size:24px;line-height:1.35}p{margin:18px 0 0;color:#94a3b8;line-height:1.7;white-space:pre-wrap}.opening{display:flex;align-items:center;gap:10px;color:#5eead4;font-size:14px}.spinner{width:16px;height:16px;border:2px solid rgba(94,234,212,.25);border-top-color:#5eead4;border-radius:50%;animation:spin .7s linear infinite}noscript{display:block;margin-top:16px;color:#fca5a5}@keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
${renderAutoOpenBody({
    title,
    description,
    coverUrl,
    playToken,
    includeCover: !textDescriptionMode,
  })}
</html>`;
}

module.exports = {
  createCardToken,
  buildCardUrl,
  buildPlayUrl,
  renderCardHtml,
  currentRequestPageUrl,
  encodePlayTarget,
  renderAutoOpenBody,
  toPublicHttpsUrl,
  isPrivateHostname,
  escapeHtml,
  normalizeWechatCardMode,
  serializeInlineJson,
  collapseWhitespace,
};
