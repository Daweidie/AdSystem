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
    throw new Error('Set ALLOW_PRODUCTION_SMOKE_LINK=1 to create a smoke-test short link');
  }

  const publicOrigin = new URL(
    process.env.SMOKE_PUBLIC_ORIGIN || 'https://vod.zzqixiangkeji.cn',
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
  if (!video) throw new Error('No active video is available for the smoke-test card');

  const targetUrl = new URL('/play', `${publicOrigin}/`);
  targetUrl.searchParams.set('fileId', video.file_id);
  const cardToken = createCardToken();
  const result = await unifiedShortLinkService.createShortLink(
    targetUrl.toString(),
    'self',
    {
      videoId: video.id,
      cardToken,
      cardTitle: video.title,
      cardDescription: video.description,
      cardCoverUrl: toPublicHttpsUrl(video.cover_url),
      shortPathPrefix: 's',
      preferredSelfOrigin: publicOrigin,
      requirePreferredSelfOrigin: true,
      allowFallback: false,
    },
  );

  process.stdout.write(`${JSON.stringify({
    videoId: String(video.id),
    shortCode: result.shortCode,
    shortUrl: result.shortUrl,
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
