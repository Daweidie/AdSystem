const pool = require('../config/db');
const vodService = require('./vodService');
const cloudflareShortLinkService = require('./cloudflareShortLinkService');
const logger = require('../utils/logger');

const LOCK_NAME = 'video_ad_manager_expiry_cleanup';
const DEFAULT_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 50;

let cleanupRunning = false;

async function deleteExpiredVideos() {
  if (cleanupRunning) {
    return { skipped: true, reason: 'local_cleanup_already_running' };
  }

  cleanupRunning = true;
  const connection = await pool.getConnection();
  let lockAcquired = false;

  try {
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [
      LOCK_NAME,
    ]);
    lockAcquired = Number(lockRows[0]?.acquired) === 1;

    if (!lockAcquired) {
      return { skipped: true, reason: 'distributed_cleanup_already_running' };
    }

    const [videos] = await connection.execute(
      `SELECT id, file_id
       FROM videos
       WHERE expires_at <= NOW()
         AND status <> 'deleted'
       ORDER BY expires_at ASC
       LIMIT ${DELETE_BATCH_SIZE}`,
    );
    const result = { processed: videos.length, deleted: 0, failed: 0 };
    const affectedLinks = [];

    for (const video of videos) {
      const [links] = await connection.execute(
        `SELECT sl.short_code, d.domain
         FROM short_links sl
         INNER JOIN domains d ON d.id = sl.domain_id
         WHERE sl.video_id = ? AND sl.status <> 'expired'`,
        [video.id],
      );
      affectedLinks.push(...links);
      await connection.execute(
        `UPDATE videos SET status = 'expired' WHERE id = ? AND status <> 'deleted'`,
        [video.id],
      );
      await connection.execute(
        `UPDATE short_links SET status = 'expired'
         WHERE video_id = ? AND status <> 'expired'`,
        [video.id],
      );

      try {
        await vodService.deleteVideo(video.file_id);
        await connection.execute(
          `UPDATE videos
           SET status = 'deleted', deleted_at = NOW(), delete_error = NULL
           WHERE id = ?`,
          [video.id],
        );
        result.deleted += 1;
      } catch (error) {
        await connection.execute(
          `UPDATE videos
           SET status = 'expired', delete_error = ?
           WHERE id = ?`,
          [String(error.message || error).slice(0, 1000), video.id],
        );
        result.failed += 1;
        logger.warn('expired_video_delete_failed', {
          code: error.code || 'VOD_DELETE_FAILED',
          videoId: video.id,
        });
      }
    }

    await cloudflareShortLinkService.deleteMappingsBestEffort(
      affectedLinks,
      'scheduled_expiry',
    );

    return result;
  } finally {
    if (lockAcquired) {
      await connection.execute('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }

    connection.release();
    cleanupRunning = false;
  }
}

function startVideoExpiryScheduler() {
  const configuredInterval = Number.parseInt(
    process.env.VIDEO_EXPIRY_SCAN_INTERVAL_MS,
    10,
  );
  const interval =
    Number.isInteger(configuredInterval) && configuredInterval >= 60000
      ? configuredInterval
      : DEFAULT_SCAN_INTERVAL_MS;

  const runCleanup = () => {
    deleteExpiredVideos().catch((error) => {
      logger.error('video_expiry_cleanup_failed', {
        code: error.code || 'VIDEO_EXPIRY_CLEANUP_FAILED',
        message: error.message,
      });
    });
  };

  runCleanup();
  const timer = setInterval(runCleanup, interval);
  timer.unref();
  return timer;
}

module.exports = {
  deleteExpiredVideos,
  startVideoExpiryScheduler,
};
