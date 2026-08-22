const logger = require('../utils/logger');

// Express 通过四参数函数识别错误处理中间件。
function errorHandler(error, req, res, next) {
  void next;

  const status = Number(error.status) || 500;
  logger.error('http_request_failed', {
    method: req.method,
    path: req.path,
    status,
    code: error.code || 'INTERNAL_SERVER_ERROR',
    message: error.message || 'Internal server error',
  });

  res.status(status).json({
    success: false,
    data: null,
    code: error.code || 'INTERNAL_SERVER_ERROR',
    message:
      status >= 500 && !error.message
        ? '服务器内部错误'
        : error.message || '服务器内部错误',
  });
}

module.exports = errorHandler;
