const crypto = require('crypto');

const TOKEN_TTL_SECONDS = 12 * 60 * 60;

function secret() {
  return process.env.JWT_SECRET || 'development-only-secret-change-me';
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function createToken(user) {
  const payload = encode(JSON.stringify({
    sub: String(user.id),
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.');

  if (!payload || !signature) {
    return null;
  }

  const expected = sign(payload);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.exp > Math.floor(Date.now() / 1000) ? decoded : null;
  } catch {
    return null;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, 64).toString('hex'),
  };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  createToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  TOKEN_TTL_SECONDS,
};
