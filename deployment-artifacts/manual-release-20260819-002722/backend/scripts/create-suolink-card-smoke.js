const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = require('../src/config/db');
const unifiedShortLinkService = require('../src/services/unifiedShortLinkService');
const {
  createCardToken,
  toPublicHttpsUrl,
} = require('../src/services/cardPageService');

async function main() {
  if (process.env.ALLOW_PRODUCTION_SMOKE_LINK !== '1') {
    throw new Error('Set ALLOW_PRODUCTION_SMOKE_LINK=1 to create a smoke-test Suolink');
  }

  const publicOrigin = new URL(
    process.env.SMOKE_PUBLIC_ORIGIN || 'https://vod.hotwharf.com',
  ).origin;
  const [videos] = await pool.execute(
    `SELECT id, file_id, title, description, cover_url
     FROM videos
     WHERE status = 'ready'
       AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  );
  const video = videos[0];
  if (!video) throw new Error('No active video is available for the Suolink smoke test');

  const cardToken = createCardToken();
  const cardUrl = new URL(`/card/${cardToken}`, `${publicOrigin}/`).toString();
  const result = await unifiedShortLinkService.createShortLink(
    cardUrl,
    'suolink',
    {
      videoId: video.id,
      cardToken,
      cardTitle: video.title,
      cardDescription: video.description,
      cardCoverUrl: toPublicHttpsUrl(video.cover_url),
      allowFallback: false,
    },
  );
  if (result.platform !== 'suolink') {
    throw new Error('Suolink smoke test unexpectedly returned a different platform');
  }

  process.stdout.write(`${JSON.stringify({
    videoId: String(video.id),
    shortLinkId: String(result.id),
    shortCode: result.shortCode,
    shortUrl: result.shortUrl,
    cardToken,
    cardUrl,
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
