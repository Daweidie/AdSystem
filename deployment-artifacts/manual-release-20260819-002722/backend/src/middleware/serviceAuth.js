const crypto = require('crypto');

function unauthorized(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function authenticateWorker(req, res, next) {
  void res;
  const expected = String(process.env.WORKER_SYNC_API_KEY || '').trim();
  if (!expected) {
    next(unauthorized('服务同步尚未配置', 'SERVICE_AUTH_NOT_CONFIGURED', 503));
    return;
  }

  const authorization = String(req.get('authorization') || '');
  const provided = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
  if (!provided || !safeEqual(provided, expected)) {
    next(unauthorized('服务认证失败', 'SERVICE_AUTH_FAILED', 401));
    return;
  }
  next();
}

module.exports = { authenticateWorker, safeEqual };
