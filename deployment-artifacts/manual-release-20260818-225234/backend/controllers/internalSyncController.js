const shortLinkService = require('../services/shortLinkService');

function validationError(message) {
  const error = new Error(message);
  error.code = 'SYNC_VALIDATION_ERROR';
  error.status = 400;
  return error;
}

async function recordShortLinkClick(req, res, next) {
  try {
    const eventId = String(req.body?.eventId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(eventId)) {
      throw validationError('eventId 格式不正确');
    }

    const result = await shortLinkService.recordExternalClick(req.params.shortCode, {
      eventId,
      occurredAt: req.body?.occurredAt,
      userAgent: req.body?.userAgent,
      referer: req.body?.referer,
      ipAddress: req.body?.ipAddress,
    });
    return res.json({
      success: true,
      data: result,
      message: result.recorded ? '点击已记录' : '重复事件已忽略',
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { recordShortLinkClick };
