const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function encryptionKey() {
  const secret = process.env.CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret || secret === 'replace_with_a_long_random_secret') {
    throw new Error('保存敏感配置前必须设置 CONFIG_ENCRYPTION_KEY 或 JWT_SECRET');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSecret(value) {
  const stored = String(value || '');
  if (!stored) return '';
  // 兼容上线前可能人工写入 system_configs 的明文值；下次保存会自动加密。
  if (!stored.startsWith(PREFIX)) return stored;
  const [ivText, tagText, ciphertextText] = stored.slice(PREFIX.length).split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('敏感配置密文格式不正确');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function maskSecret(value) {
  const normalized = String(value || '');
  if (!normalized) return '';
  return `••••••••${normalized.slice(-4)}`;
}

module.exports = { encryptSecret, decryptSecret, maskSecret };
