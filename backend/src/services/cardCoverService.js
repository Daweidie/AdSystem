const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const sharp = require('sharp');

const CARD_COVER_DIRECTORY = path.resolve(__dirname, '../../uploads/share-cards');
const CARD_COVER_PUBLIC_PREFIX = '/card-covers/';
const LEGACY_CARD_COVER_PUBLIC_PREFIX = '/api/media/share-cards/';
const MAX_CARD_COVER_BYTES = 5 * 1024 * 1024;
const MAX_CARD_COVER_DIMENSION = 600;
const TARGET_CARD_COVER_QUALITY = 82;
const MAX_CARD_COVER_OUTPUT_BYTES = 300 * 1024;
const REMOTE_CARD_COVER_TIMEOUT_MS = 10000;
const REMOTE_CARD_COVER_FAILURE_TTL_MS = 60 * 1000;
const SUPPORTED_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
const SUPPORTED_EXTENSIONS = new Map([
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['image/webp', new Set(['.webp'])],
]);

const remoteCardCoverCache = new Map();
const remoteCardCoverInflight = new Map();

fs.mkdirSync(CARD_COVER_DIRECTORY, { recursive: true, mode: 0o750 });

function uploadError(message, code = 'CARD_COVER_INVALID', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

const storage = multer.diskStorage({
  destination: CARD_COVER_DIRECTORY,
  filename(req, file, callback) {
    void req;
    callback(null, `${crypto.randomUUID()}${SUPPORTED_TYPES.get(file.mimetype)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_CARD_COVER_BYTES, files: 1 },
  fileFilter(req, file, callback) {
    void req;
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    if (
      !SUPPORTED_TYPES.has(file.mimetype)
      || !SUPPORTED_EXTENSIONS.get(file.mimetype)?.has(extension)
    ) {
      callback(uploadError('卡片图片仅支持 JPG、PNG 或 WebP 格式'));
      return;
    }
    callback(null, true);
  },
}).single('cover');

function uploadCardCover(req, res, next) {
  upload(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      next(uploadError('卡片图片不能超过 5MB', 'CARD_COVER_TOO_LARGE', 413));
      return;
    }
    next(error);
  });
}

function matchesFileSignature(buffer, mimeType) {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3
      && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

async function validateCardCover(file) {
  if (!file) throw uploadError('请选择要上传的卡片图片');
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!matchesFileSignature(buffer.subarray(0, bytesRead), file.mimetype)) {
      throw uploadError('卡片图片内容与文件格式不匹配');
    }
  } finally {
    await handle.close();
  }
}

function publicCardCoverPath(file) {
  return `${CARD_COVER_PUBLIC_PREFIX}${file.filename}`;
}

async function persistNormalizedCardCover(input) {
  let quality = TARGET_CARD_COVER_QUALITY;
  const render = () => sharp(input, { failOn: 'error' })
    .rotate()
    .resize({
      width: MAX_CARD_COVER_DIMENSION,
      height: MAX_CARD_COVER_DIMENSION,
      fit: 'inside',
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  let output = await render();

  // Keep large covers within the practical WeCom card range without making
  // small images needlessly noisy. A hard 300KB ceiling also protects crawlers.
  while (output.length > MAX_CARD_COVER_OUTPUT_BYTES && quality > 75) {
    quality -= 2;
    output = await render();
  }

  const filename = `${crypto.createHash('sha256').update(output).digest('hex')}.jpg`;
  const finalPath = path.resolve(CARD_COVER_DIRECTORY, filename);
  try {
    await fs.promises.access(finalPath, fs.constants.R_OK);
  } catch {
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, output, { mode: 0o640 });
      await fs.promises.rename(temporaryPath, finalPath);
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  const metadata = await sharp(output).metadata();
  return {
    filename,
    path: finalPath,
    publicPath: `${CARD_COVER_PUBLIC_PREFIX}${filename}`,
    dimensions: {
      width: metadata.width || MAX_CARD_COVER_DIMENSION,
      height: metadata.height || MAX_CARD_COVER_DIMENSION,
    },
    size: output.length,
  };
}

/**
 * Normalize an uploaded image into a WeCom-friendly immutable JPEG.
 * The multer file is removed after the normalized file has been persisted.
 */
async function processCardCover(file) {
  await validateCardCover(file);
  const input = await fs.promises.readFile(file.path);
  try {
    return await persistNormalizedCardCover(input);
  } finally {
    await fs.promises.rm(file.path, { force: true });
  }
}

function isManagedCardCoverAvailable(value) {
  const filePath = managedFilePath(value);
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function canonicalCardCoverPath(value) {
  let pathname = String(value || '').trim();
  if (/^https?:\/\//iu.test(pathname)) {
    try {
      const url = new URL(pathname);
      if (url.username || url.password || url.search || url.hash) return null;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  const prefix = [CARD_COVER_PUBLIC_PREFIX, LEGACY_CARD_COVER_PUBLIC_PREFIX]
    .find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return null;
  const filename = pathname.slice(prefix.length);
  if (!/^(?:[0-9a-f-]{36}|[0-9a-f]{64})\.(jpg|png|webp)$/i.test(filename)) return null;
  return `${CARD_COVER_PUBLIC_PREFIX}${filename}`;
}

function managedFilePath(publicPath) {
  const canonicalPath = canonicalCardCoverPath(publicPath);
  if (!canonicalPath) return null;
  const filename = canonicalPath.slice(CARD_COVER_PUBLIC_PREFIX.length);
  const resolved = path.resolve(CARD_COVER_DIRECTORY, filename);
  return path.dirname(resolved) === CARD_COVER_DIRECTORY ? resolved : null;
}

function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer) {
  const type = buffer.subarray(12, 16).toString('ascii');
  if (type === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (type === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (type === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function parseImageDimensions(buffer) {
  if (buffer.length >= 24 && matchesFileSignature(buffer, 'image/png')) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 12 && matchesFileSignature(buffer, 'image/jpeg')) {
    return readJpegDimensions(buffer);
  }
  if (buffer.length >= 30 && matchesFileSignature(buffer, 'image/webp')) {
    return readWebpDimensions(buffer);
  }
  return null;
}

function readCardCoverDimensions(publicPath) {
  const filePath = managedFilePath(publicPath);
  if (!filePath) return null;
  try {
    const dimensions = parseImageDimensions(fs.readFileSync(filePath));
    if (
      !dimensions
      || !Number.isInteger(dimensions.width)
      || !Number.isInteger(dimensions.height)
      || dimensions.width <= 0
      || dimensions.height <= 0
    ) return null;
    return dimensions;
  } catch {
    return null;
  }
}

function isAllowedRemoteCoverUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return false;

    const configuredHosts = String(process.env.CARD_COVER_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const allowedHosts = configuredHosts.length
      ? configuredHosts
      : ['myqcloud.com', 'qcloud.com', 'vod-qcloud.com'];
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
    return allowedHosts.some((allowed) => {
      const normalized = allowed.replace(/^\.+/u, '').replace(/\.$/u, '');
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function detectImageType(buffer) {
  for (const [mimeType, extension] of SUPPORTED_TYPES.entries()) {
    if (matchesFileSignature(buffer, mimeType)) return { mimeType, extension };
  }
  return null;
}

async function downloadRemoteCardCover(rawUrl) {
  if (!isAllowedRemoteCoverUrl(rawUrl)) return null;

  const response = await axios.get(rawUrl, {
    responseType: 'arraybuffer',
    timeout: REMOTE_CARD_COVER_TIMEOUT_MS,
    maxContentLength: MAX_CARD_COVER_BYTES,
    maxBodyLength: MAX_CARD_COVER_BYTES,
    headers: { Accept: 'image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1' },
    validateStatus: (status) => status === 200,
  });
  const buffer = Buffer.from(response.data || '');
  if (!buffer.length || buffer.length > MAX_CARD_COVER_BYTES) return null;

  const imageType = detectImageType(buffer);
  if (!imageType) return null;
  const responseMime = String(response.headers?.['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (responseMime && responseMime.startsWith('image/') && responseMime !== imageType.mimeType) {
    return null;
  }

  const dimensions = parseImageDimensions(buffer);
  if (
    !dimensions
    || !Number.isInteger(dimensions.width)
    || !Number.isInteger(dimensions.height)
    || dimensions.width <= 0
    || dimensions.height <= 0
  ) return null;

  void imageType;
  void dimensions;
  return persistNormalizedCardCover(buffer);
}

async function cacheRemoteCardCover(value) {
  const rawUrl = String(value || '').trim();
  if (!isAllowedRemoteCoverUrl(rawUrl)) return null;

  const cached = remoteCardCoverCache.get(rawUrl);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.result?.publicPath && managedFilePath(cached.result.publicPath)) {
      return cached.result;
    }
    if (!cached.result) return null;
  }

  if (remoteCardCoverInflight.has(rawUrl)) {
    return remoteCardCoverInflight.get(rawUrl);
  }

  const promise = downloadRemoteCardCover(rawUrl)
    .catch(() => null)
    .then((result) => {
      remoteCardCoverCache.set(rawUrl, {
        result,
        expiresAt: Date.now() + (result ? 24 * 60 * 60 * 1000 : REMOTE_CARD_COVER_FAILURE_TTL_MS),
      });
      return result;
    })
    .finally(() => remoteCardCoverInflight.delete(rawUrl));
  remoteCardCoverInflight.set(rawUrl, promise);
  return promise;
}

async function removeCardCover(value) {
  const filePath = value?.path || managedFilePath(value);
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true });
}

module.exports = {
  CARD_COVER_DIRECTORY,
  MAX_CARD_COVER_BYTES,
  MAX_CARD_COVER_DIMENSION,
  TARGET_CARD_COVER_QUALITY,
  uploadCardCover,
  validateCardCover,
  processCardCover,
  publicCardCoverPath,
  canonicalCardCoverPath,
  readCardCoverDimensions,
  isManagedCardCoverAvailable,
  cacheRemoteCardCover,
  removeCardCover,
};
