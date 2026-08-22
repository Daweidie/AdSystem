const pool = require('../config/db');

async function getShortLinkStatistics(req, res, next) {
  try {
    const scoped = !['super_admin', 'system_admin'].includes(req.auth?.role);
    const groupId = req.auth?.business_group_id || 0;
    const promoterScoped = req.auth?.role === 'general_user';
    const groupScope = scoped ? ' AND v.business_group_id = ?' : '';
    const creatorScope = promoterScoped ? ' AND sl.created_by = ?' : '';
    const scopedParams = [
      ...(scoped ? [groupId] : []),
      ...(promoterScoped ? [req.auth.id] : []),
    ];
    const [[totals], [platformRows], [todayRows]] = await Promise.all([
      pool.execute(
        `SELECT COUNT(*) AS total_links,
                COALESCE(SUM(clicks), 0) AS total_clicks
         FROM short_links sl
         INNER JOIN videos v ON v.id = sl.video_id
         WHERE 1=1${groupScope}${creatorScope}`,
        scopedParams,
      ),
      pool.execute(
        `SELECT COALESCE(sl.platform, d.platform,
                  CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
                ) AS platform,
                COUNT(*) AS link_count
         FROM short_links sl
         INNER JOIN domains d ON d.id = sl.domain_id
         INNER JOIN videos v ON v.id = sl.video_id
         WHERE 1=1${groupScope}${creatorScope}
         GROUP BY sl.platform, d.platform, d.type`,
        scopedParams,
      ),
      pool.execute(
        `SELECT COUNT(*) AS today_clicks
         FROM play_logs pl
         INNER JOIN short_links sl ON sl.id = pl.short_link_id
         INNER JOIN videos v ON v.id = pl.video_id
         WHERE pl.event_type = 'redirect'
           AND played_at >= CURRENT_DATE
           AND played_at < CURRENT_DATE + INTERVAL 1 DAY
           ${groupScope}${creatorScope}`,
        scopedParams,
      ),
    ]);

    const totalLinks = Number(totals[0]?.total_links || 0);
    const platformCounts = { suolink: 0, self: 0 };

    for (const row of platformRows) {
      if (Object.prototype.hasOwnProperty.call(platformCounts, row.platform)) {
        platformCounts[row.platform] = Number(row.link_count || 0);
      }
    }

    return res.json({
      success: true,
      data: {
        totalLinks,
        todayClicks: Number(todayRows[0]?.today_clicks || 0),
        totalClicks: Number(totals[0]?.total_clicks || 0),
        platforms: {
          suolink: {
            count: platformCounts.suolink,
            percentage: totalLinks
              ? Number(((platformCounts.suolink / totalLinks) * 100).toFixed(1))
              : 0,
          },
          self: {
            count: platformCounts.self,
            percentage: totalLinks
              ? Number(((platformCounts.self / totalLinks) * 100).toFixed(1))
              : 0,
          },
        },
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getShortLinkStatistics,
};
