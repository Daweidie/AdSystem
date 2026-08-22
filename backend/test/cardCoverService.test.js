const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const {
  CARD_COVER_DIRECTORY,
  readCardCoverDimensions,
  processCardCover,
  removeCardCover,
} = require('../src/services/cardCoverService');

test('reads dimensions from current and legacy managed cover URLs', async () => {
  const filename = `${crypto.randomUUID()}.png`;
  const filePath = path.join(CARD_COVER_DIRECTORY, filename);
  const publicPath = `/card-covers/${filename}`;
  const legacyPath = `/api/media/share-cards/${filename}`;
  const absoluteUrl = `https://vod.hotwharf.com${publicPath}`;
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  await fs.writeFile(filePath, onePixelPng);
  try {
    assert.deepEqual(readCardCoverDimensions(publicPath), { width: 1, height: 1 });
    assert.deepEqual(readCardCoverDimensions(absoluteUrl), { width: 1, height: 1 });
    assert.deepEqual(readCardCoverDimensions(legacyPath), { width: 1, height: 1 });
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('normalizes JPG, PNG, and WebP uploads to immutable public JPEG covers', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const inputs = [
    { mimetype: 'image/png', extension: 'png', data: png },
    { mimetype: 'image/jpeg', extension: 'jpg', data: await sharp(png).jpeg().toBuffer() },
    { mimetype: 'image/webp', extension: 'webp', data: await sharp(png).webp().toBuffer() },
  ];
  const created = [];

  try {
    for (const input of inputs) {
      const filePath = path.join(CARD_COVER_DIRECTORY, `${crypto.randomUUID()}.${input.extension}`);
      await fs.writeFile(filePath, input.data);
      const normalized = await processCardCover({
        path: filePath,
        mimetype: input.mimetype,
        originalname: `cover.${input.extension}`,
      });
      created.push(normalized.publicPath);
      assert.match(normalized.publicPath, /^\/card-covers\/[0-9a-f]{64}\.jpg$/);
      assert.ok(normalized.size > 0 && normalized.size <= 300 * 1024);
      const metadata = await sharp(normalized.path).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert.ok(metadata.width <= 600 && metadata.height <= 600);
    }
  } finally {
    await Promise.all(created.map((value) => removeCardCover(value)));
  }
});
