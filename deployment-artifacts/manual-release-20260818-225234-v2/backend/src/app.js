const express = require('express');
const cors = require('cors');
const path = require('path');
const { CARD_COVER_DIRECTORY } = require('./services/cardCoverService');

const videoRoutes = require('./routes/videoRoutes');
const shortLinkRoutes = require('./routes/shortLinkRoutes');
const domainRoutes = require('./routes/domainRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const managementRoutes = require('./routes/managementRoutes');
const internalSyncRoutes = require('./routes/internalSyncRoutes');
const videoController = require('./controllers/videoController');
const shortLinkController = require('./controllers/shortLinkController');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const FRONTEND_DIST_DIRECTORY = path.resolve(__dirname, '../../frontend/dist');

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
// Cover files are public crawler assets, not API responses. Production Nginx
// serves /card-covers directly; Express provides the same route for local use
// and keeps the old API-shaped URLs working for cards saved before migration.
const cardCoverStaticOptions = {
  dotfiles: 'deny',
  fallthrough: false,
  immutable: true,
  maxAge: '1d',
  setHeaders(response) {
    response.removeHeader('Vary');
    response.removeHeader('ETag');
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  },
};
app.use('/card-covers', express.static(CARD_COVER_DIRECTORY, cardCoverStaticOptions));
app.use('/api/media/share-cards', express.static(CARD_COVER_DIRECTORY, cardCoverStaticOptions));
function configuredOrigins() {
  const values = [
    process.env.FRONTEND_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS || '').split(','),
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (process.env.NODE_ENV !== 'production') {
    values.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }

  return new Set(values);
}

const allowedOrigins = configuredOrigins();

app.use(cors((req, callback) => {
  const origin = req.get('origin');
  let requestOrigin = null;
  try {
    requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
  } catch {
    // 非法 Host 会由后续路由拒绝，不能把它加入 CORS 许可集合。
  }
  if (!origin || origin === requestOrigin || allowedOrigins.has(origin)) {
    callback(null, { origin: true });
    return;
  }

  const error = new Error('当前来源不允许访问该服务');
  error.status = 403;
  error.code = 'CORS_ORIGIN_DENIED';
  callback(error);
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Nginx 在生产环境直接提供这些构建产物；Express 同时提供只读兜底，
// 让精确代理到后端的 /play 在本地验收与简化部署中也能完整初始化 SPA。
app.use('/assets', express.static(path.join(FRONTEND_DIST_DIRECTORY, 'assets'), {
  dotfiles: 'deny',
  fallthrough: true,
  immutable: true,
  maxAge: '1y',
}));
app.get('/wechat-share-default.png', (req, res, next) => {
  res.sendFile(
    path.join(FRONTEND_DIST_DIRECTORY, 'wechat-share-default.png'),
    { dotfiles: 'deny', maxAge: '1d' },
    (error) => (error ? next(error) : undefined),
  );
});
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && typeof body.success === 'boolean') {
      const normalized = {
        success: body.success,
        data: body.data ?? null,
        code: body.code ?? null,
        message: body.message || (body.success ? '请求成功' : '请求失败'),
      };
      return sendJson({ ...body, ...normalized });
    }

    return sendJson(body);
  };
  next();
});

app.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' }, message: 'ok' });
});

// 生产环境由 Nginx 将顶层 /play 精确代理到这里，确保过期/已删除页面
// 在返回 SPA 之前就得到正确的 410 文档状态。
app.get('/play', videoController.servePlayPage);
app.get('/card/:cardToken', shortLinkController.serveCardPage);
app.get('/s/:shortCode', shortLinkController.serveSelfShortLinkCard);

app.use('/api/video', videoRoutes);
app.use('/api/shortlink', shortLinkRoutes);
// 兼容原有 /api/short 路径。
app.use('/api/short', shortLinkRoutes);
app.use('/api/domain', domainRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/internal', internalSyncRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
