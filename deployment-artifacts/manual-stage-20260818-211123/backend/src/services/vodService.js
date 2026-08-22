const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');

const VOD_HOST = 'vod.tencentcloudapi.com';
const VOD_ENDPOINT = `https://${VOD_HOST}`;
const VOD_SERVICE = 'vod';
const VOD_VERSION = '2018-07-17';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const DEFAULT_UPLOAD_SIGNATURE_TTL_SECONDS = 3600;
const DEFAULT_PLAY_SIGNATURE_TTL_SECONDS = 3600;
const DEFAULT_API_TIMEOUT_MS = 10000;
const DEFAULT_API_MAX_RETRIES = 2;

let distributionConfigPromise = null;
let distributionConfigExpiresAt = 0;
let playerKeyMismatchLogged = false;

class VodServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'VodServiceError';
    this.code = options.code || 'VOD_SERVICE_ERROR';
    this.status = options.status;
    this.details = options.details;

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new VodServiceError(`缺少环境变量 ${name}`, {
      code: 'VOD_CONFIG_ERROR',
    });
  }

  return value;
}

function readPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function getVodSubAppId() {
  const value = process.env.TENCENT_VOD_SUB_APP_ID?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new VodServiceError('TENCENT_VOD_SUB_APP_ID 必须是正整数', {
      code: 'VOD_CONFIG_ERROR',
    });
  }

  return parsed;
}

/**
 * 为腾讯云服务端 API 请求生成 TC3-HMAC-SHA256 Authorization。
 * Web 直传 SDK 使用的是另一套“客户端上传签名”，见 getUploadSignature。
 */
function createTc3Authorization(action, payload, timestamp) {
  const secretId = requireEnvironment('TENCENT_SECRET_ID');
  const secretKey = requireEnvironment('TENCENT_SECRET_KEY');
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\n` +
    `host:${VOD_HOST}\n` +
    `x-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join('\n');
  const credentialScope = `${date}/${VOD_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, VOD_SERVICE);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign, 'hex');

  return (
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

async function callVodApi(action, parameters = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(parameters);
  const headers = {
    Authorization: createTc3Authorization(action, body, timestamp),
    'Content-Type': CONTENT_TYPE,
    Host: VOD_HOST,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': VOD_VERSION,
  };
  const region = process.env.TENCENT_VOD_REGION?.trim();
  const securityToken = process.env.TENCENT_SESSION_TOKEN?.trim();

  if (region) {
    headers['X-TC-Region'] = region;
  }

  if (securityToken) {
    headers['X-TC-Token'] = securityToken;
  }

  const timeout = readPositiveInteger(
    process.env.TENCENT_VOD_API_TIMEOUT_MS,
    DEFAULT_API_TIMEOUT_MS,
    60000,
  );
  const maxRetries = readPositiveInteger(
    process.env.TENCENT_VOD_API_MAX_RETRIES,
    DEFAULT_API_MAX_RETRIES,
    5,
  );
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await axios.post(VOD_ENDPOINT, body, {
        headers,
        timeout,
        transformRequest: [(data) => data],
      });
      const result = response.data?.Response;

      if (!result) {
        throw new VodServiceError('腾讯云 VOD 返回了无法识别的数据', {
          code: 'VOD_INVALID_RESPONSE',
          status: 502,
        });
      }

      if (result.Error) {
        const notFound = /ResourceNotFound|InvalidParameterValue\.FileId/i.test(
          result.Error.Code || '',
        );
        throw new VodServiceError(`腾讯云 VOD 调用失败：${result.Error.Message}`, {
          code: result.Error.Code || 'VOD_PROVIDER_ERROR',
          status: notFound ? 404 : 502,
          details: { requestId: result.RequestId },
        });
      }

      return result;
    } catch (error) {
      if (error instanceof VodServiceError) {
        throw error;
      }

      lastError = error;
      const retryable =
        !error.response ||
        [408, 425, 429].includes(error.response.status) ||
        error.response.status >= 500;

      if (!retryable || attempt >= maxRetries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }

  const isTimeout =
    lastError?.code === 'ECONNABORTED' || lastError?.code === 'ETIMEDOUT';
  throw new VodServiceError(
    isTimeout ? '腾讯云 VOD 请求超时' : '腾讯云 VOD 请求失败',
    {
      code: isTimeout ? 'VOD_TIMEOUT' : 'VOD_REQUEST_FAILED',
      status: isTimeout ? 503 : 502,
      cause: lastError,
    },
  );
}

function encodeUploadParameter(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 生成腾讯云 Web/客户端上传 SDK 所需签名。
 * 该签名按腾讯云客户端上传规范使用 HMAC-SHA1；TC3 用于后端云 API 调用。
 * @returns {Promise<string>}
 */
async function getUploadSignature() {
  const secretId = requireEnvironment('TENCENT_SECRET_ID');
  const secretKey = requireEnvironment('TENCENT_SECRET_KEY');
  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const ttl = readPositiveInteger(
    process.env.TENCENT_UPLOAD_SIGNATURE_TTL_SECONDS,
    DEFAULT_UPLOAD_SIGNATURE_TTL_SECONDS,
    7776000,
  );
  const parameters = {
    secretId,
    currentTimeStamp,
    expireTime: currentTimeStamp + ttl,
    random: crypto.randomInt(0, 4294967296),
    oneTimeValid: 1,
  };
  const subAppId = getVodSubAppId();

  if (subAppId) {
    parameters.vodSubAppId = subAppId;
  }

  if (process.env.TENCENT_VOD_PROCEDURE?.trim()) {
    parameters.procedure = process.env.TENCENT_VOD_PROCEDURE.trim();
  }

  if (process.env.TENCENT_VOD_STORAGE_REGION?.trim()) {
    parameters.storageRegion = process.env.TENCENT_VOD_STORAGE_REGION.trim();
  }

  const original = Object.entries(parameters)
    .map(([key, value]) => `${key}=${encodeUploadParameter(value)}`)
    .join('&');
  const digest = crypto.createHmac('sha1', secretKey).update(original).digest();

  return Buffer.concat([digest, Buffer.from(original, 'utf8')]).toString('base64');
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function isValidPlayerKey(value) {
  return /^[A-Za-z0-9]{8,20}$/.test(String(value || ''));
}

async function getDistributionConfig() {
  if (distributionConfigPromise && distributionConfigExpiresAt > Date.now()) {
    return distributionConfigPromise;
  }

  const parameters = {};
  const subAppId = getVodSubAppId();

  if (subAppId) {
    parameters.SubAppId = subAppId;
  }

  distributionConfigPromise = callVodApi(
    'DescribeDefaultDistributionConfig',
    parameters,
  ).catch((error) => {
    distributionConfigPromise = null;
    distributionConfigExpiresAt = 0;
    throw error;
  });
  distributionConfigExpiresAt = Date.now() + 5 * 60 * 1000;
  return distributionConfigPromise;
}

async function getPlayerSigningKey() {
  const configuredKey =
    process.env.PLAYER_SIGN_KEY?.trim() || process.env.TENCENT_VOD_PLAY_KEY?.trim();

  try {
    const distribution = await getDistributionConfig();
    const providerKey = distribution.PlayKey;

    if (!isValidPlayerKey(providerKey)) {
      throw new VodServiceError('腾讯云默认分发配置未返回有效播放密钥', {
        code: 'VOD_PLAY_KEY_INVALID',
        status: 503,
      });
    }

    if (configuredKey) {
      const matches =
        configuredKey.length === providerKey.length &&
        crypto.timingSafeEqual(Buffer.from(configuredKey), Buffer.from(providerKey));

      if (!matches && !playerKeyMismatchLogged) {
        playerKeyMismatchLogged = true;
        logger.warn('vod_player_key_mismatch', {
          code: 'VOD_PLAY_KEY_MISMATCH',
          configuredKeyLength: configuredKey.length,
          providerKeyLength: providerKey.length,
          action: 'using_provider_distribution_key',
        });
      }
    }

    return providerKey;
  } catch (error) {
    if (isValidPlayerKey(configuredKey)) {
      logger.warn('vod_distribution_config_unavailable', {
        code: error.code || 'VOD_DISTRIBUTION_CONFIG_ERROR',
        action: 'using_validated_configured_key',
      });
      return configuredKey;
    }

    throw error;
  }
}

function createPlayerSignature(fileId, maximumExpireAt, playKey) {
  const signingKey = playKey ||
    process.env.PLAYER_SIGN_KEY?.trim() ||
    process.env.TENCENT_VOD_PLAY_KEY?.trim();

  if (!isValidPlayerKey(signingKey)) {
    throw new VodServiceError('播放器签名密钥无效', {
      code: 'VOD_PLAY_KEY_INVALID',
      status: 503,
    });
  }
  const appId = getVodSubAppId() || Number(requireEnvironment('TENCENT_APP_ID'));

  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new VodServiceError('TENCENT_APP_ID 必须是正整数', {
      code: 'VOD_CONFIG_ERROR',
    });
  }

  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const defaultTtl = readPositiveInteger(
    process.env.TENCENT_PLAY_SIGNATURE_TTL_SECONDS,
    DEFAULT_PLAY_SIGNATURE_TTL_SECONDS,
    86400,
  );
  const maximumExpireTimestamp = maximumExpireAt
    ? Math.floor(new Date(maximumExpireAt).getTime() / 1000)
    : currentTimeStamp + defaultTtl;
  const expireTimeStamp = Math.min(
    currentTimeStamp + defaultTtl,
    maximumExpireTimestamp,
  );

  if (!Number.isFinite(expireTimeStamp) || expireTimeStamp <= currentTimeStamp) {
    throw new VodServiceError('视频已过期，无法生成播放签名', {
      code: 'VOD_VIDEO_EXPIRED',
      status: 410,
    });
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      appId,
      fileId: String(fileId),
      contentInfo: {
        audioVideoType: process.env.TENCENT_VOD_AUDIO_VIDEO_TYPE || 'Original',
      },
      currentTimeStamp,
      expireTimeStamp,
      urlAccessInfo: {
        t: expireTimeStamp.toString(16),
      },
    }),
  );
  const unsignedToken = `${header}.${payload}`;
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(unsignedToken)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${unsignedToken}.${signature}`;
}

/**
 * 查询媒资详情并生成不超过视频业务过期时间的播放器签名。
 */
async function getVideoInfo(fileId, maximumExpireAt) {
  if (!fileId) {
    throw new VodServiceError('fileId 不能为空', {
      code: 'VOD_VALIDATION_ERROR',
      status: 400,
    });
  }

  const parameters = {
    FileIds: [String(fileId)],
    Filters: ['basicInfo', 'metaData'],
  };
  const subAppId = getVodSubAppId();

  if (subAppId) {
    parameters.SubAppId = subAppId;
  }

  const [result, playerKey] = await Promise.all([
    callVodApi('DescribeMediaInfos', parameters),
    getPlayerSigningKey(),
  ]);
  const media = result.MediaInfoSet?.[0];

  if (!media) {
    throw new VodServiceError('腾讯云 VOD 中不存在该视频', {
      code: 'VOD_VIDEO_NOT_FOUND',
      status: 404,
    });
  }

  return {
    fileId: String(fileId),
    appId: String(process.env.TENCENT_VOD_SUB_APP_ID || process.env.TENCENT_APP_ID),
    psign: createPlayerSignature(fileId, maximumExpireAt, playerKey),
    licenseUrl: process.env.TENCENT_PLAYER_LICENSE_URL || undefined,
    title: media.BasicInfo?.Name || '',
    description: media.BasicInfo?.Description || '',
    coverUrl: media.BasicInfo?.CoverUrl || '',
    duration: media.MetaData?.Duration ?? null,
    size: media.MetaData?.Size ?? null,
    providerExpireTime: media.BasicInfo?.ExpireTime || null,
  };
}

async function setVideoExpireTime(fileId, expiresAt) {
  const expireDate = new Date(expiresAt);

  if (!fileId || Number.isNaN(expireDate.getTime())) {
    throw new VodServiceError('fileId 或 expiresAt 不正确', {
      code: 'VOD_VALIDATION_ERROR',
      status: 400,
    });
  }

  const parameters = {
    FileId: String(fileId),
    ExpireTime: expireDate.toISOString(),
  };
  const subAppId = getVodSubAppId();

  if (subAppId) {
    parameters.SubAppId = subAppId;
  }

  return callVodApi('ModifyMediaInfo', parameters);
}

async function deleteVideo(fileId) {
  const parameters = { FileId: String(fileId) };
  const subAppId = getVodSubAppId();

  if (subAppId) {
    parameters.SubAppId = subAppId;
  }

  try {
    return await callVodApi('DeleteMedia', parameters);
  } catch (error) {
    if (
      error instanceof VodServiceError &&
      /ResourceNotFound|InvalidParameterValue\.FileId/i.test(error.code)
    ) {
      return { alreadyDeleted: true };
    }

    throw error;
  }
}

module.exports = {
  getUploadSignature,
  getVideoInfo,
  setVideoExpireTime,
  deleteVideo,
  createTc3Authorization,
  createPlayerSignature,
  getPlayerSigningKey,
  getDistributionConfig,
  VodServiceError,
};
