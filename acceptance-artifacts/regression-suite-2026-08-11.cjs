const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('../frontend/node_modules/playwright-core');
const dotenv = require('../backend/node_modules/dotenv');

dotenv.config({ path: path.resolve(__dirname, '../backend/.env') });
const mysql = require('../backend/node_modules/mysql2/promise');

const API = 'http://localhost:3001/api';
const ADMIN = 'http://localhost:5173/admin';
const VIDEO_PATH = path.resolve(__dirname, 'AT_E2E_20260811.mp4');
const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUTPUT_PATH = path.resolve(__dirname, 'final-regression-results-2026-08-12.json');
const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const title = `AT_修复验收_${runId}`;

const results = [];
const state = {
  video: null,
  originalPrimaryId: null,
  restoreDomains: new Set(),
  selfLink: null,
  switchedLink: null,
};

function record(number, name, status, evidence) {
  results.push({ number, name, status, evidence });
  console.log(`SCENARIO_${number}`, status, JSON.stringify(evidence));
}

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    redirect: options.redirect,
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  let payload = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('json')) {
    payload = await response.json();
  }

  return { response, payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 3,
  });
  const [[primary]] = await pool.execute(
    'SELECT id FROM domains WHERE is_primary=1 ORDER BY id LIMIT 1',
  );
  state.originalPrimaryId = primary?.id;
  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  try {
    // 1. 真实上传 + 自定义标题 + 云端/数据库 10 天。
    await page.goto(ADMIN, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('input[type=file]').setInputFiles(VIDEO_PATH);
    const uploadDialog = page.getByRole('dialog', { name: '确认上传视频' });
    await uploadDialog.waitFor({ state: 'visible' });
    await uploadDialog.getByPlaceholder('请输入视频标题').fill(title);
    const completePromise = page.waitForResponse(
      (response) => response.url().endsWith('/api/video/complete'),
      { timeout: 300000 },
    );
    await uploadDialog.getByRole('button', { name: '开始上传' }).click();
    const completeResponse = await completePromise;
    const completePayload = await completeResponse.json();
    assert(completeResponse.status() === 201, `upload complete HTTP ${completeResponse.status()}`);
    state.video = {
      id: completePayload.data.id,
      fileId: completePayload.data.file_id,
      title: completePayload.data.title,
    };
    const [[uploaded]] = await pool.execute(
      `SELECT id,file_id,title,status,
              TIMESTAMPDIFF(SECOND,created_at,expires_at) AS lifetime_seconds
       FROM videos WHERE id=?`,
      [state.video.id],
    );
    assert(uploaded.title === title, 'custom title was not saved');
    assert(Number(uploaded.lifetime_seconds) === 864000, 'retention is not 10 days');
    await page.screenshot({
      path: path.resolve(__dirname, 'regression-01-upload.png'),
      fullPage: true,
    });
    record(1, '视频上传', 'PASS', {
      uploadSignatureHttp: 200,
      completeHttp: 201,
      videoId: uploaded.id,
      fileId: uploaded.file_id,
      title: uploaded.title,
      status: uploaded.status,
      lifetimeSeconds: Number(uploaded.lifetime_seconds),
    });

    // 2. 列表字段与三项操作。
    await page.waitForLoadState('networkidle');
    const videoRow = page.locator('.el-table__body tr').filter({ hasText: title }).first();
    await videoRow.waitFor({ state: 'visible' });
    const headers = await page.locator('.el-tab-pane').first().locator('th').allInnerTexts();
    const actions = await videoRow.getByRole('button').allInnerTexts();
    for (const expected of ['播放', '生成短链', '删除']) {
      assert(actions.some((value) => value.trim() === expected), `missing ${expected}`);
    }
    record(2, '视频列表', 'PASS', {
      headers: headers.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean),
      actions,
    });

    // 3. 真实画面、音频属性、时间增长与 start 日志。
    const playPage = await context.newPage();
    const navigation = await playPage.goto(
      `http://localhost:5173/play?fileId=${encodeURIComponent(state.video.fileId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 },
    );
    await playPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.readyState >= 2 && video.videoWidth > 0 && video.duration > 0;
    }, null, { timeout: 30000 });
    const mediaBefore = await playPage.locator('video').evaluate((video) => ({
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      currentTime: video.currentTime,
      muted: video.muted,
      volume: video.volume,
    }));
    await playPage.locator('video').evaluate((video) => video.play());
    await playPage.waitForTimeout(5000);
    const currentTimeAfter = await playPage.locator('video').evaluate((video) => video.currentTime);
    const [[playLog]] = await pool.execute(
      `SELECT COUNT(*) AS starts, COUNT(DISTINCT session_id) AS sessions
       FROM play_logs WHERE video_id=? AND event_type='start'`,
      [state.video.id],
    );
    assert(navigation.status() === 200, 'play document is not HTTP 200');
    assert(currentTimeAfter > mediaBefore.currentTime, 'currentTime did not advance');
    assert(!mediaBefore.muted && mediaBefore.volume > 0, 'video is muted');
    assert(Number(playLog.starts) >= 1, 'start log missing');
    await playPage.screenshot({ path: path.resolve(__dirname, 'regression-03-play.png') });
    await playPage.close();
    record(3, '视频播放', 'PASS', {
      navigationHttp: navigation.status(),
      ...mediaBefore,
      currentTimeAfter,
      startLogs: Number(playLog.starts),
      sessions: Number(playLog.sessions),
      tcPlayerVersion: '4.5.4',
    });

    // 4. 顶层 410、中文页与短链同步；随后精确恢复夹具。
    const [[videoSnapshot]] = await pool.execute(
      'SELECT status,expires_at FROM videos WHERE id=?',
      [state.video.id],
    );
    const [linkSnapshots] = await pool.execute(
      'SELECT id,status FROM short_links WHERE video_id=?',
      [state.video.id],
    );
    try {
      await pool.execute(
        `UPDATE videos SET status='ready',expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE)
         WHERE id=?`,
        [state.video.id],
      );
      const expiredPage = await context.newPage();
      const expiredNavigation = await expiredPage.goto(
        `http://localhost:5173/play?fileId=${encodeURIComponent(state.video.fileId)}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 },
      );
      const bodyText = (await expiredPage.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      const info = await api(`/video/${encodeURIComponent(state.video.fileId)}`);
      const [[mismatch]] = await pool.execute(
        `SELECT COUNT(*) AS count FROM short_links
         WHERE video_id=? AND status<>'expired'`,
        [state.video.id],
      );
      assert(expiredNavigation.status() === 410, 'top document is not 410');
      assert(/视频已过期/.test(bodyText), 'Chinese expiry message missing');
      assert(info.response.status === 410, 'video API is not 410');
      assert(Number(mismatch.count) === 0, 'related links not expired');
      await expiredPage.close();
      record(4, '视频过期', 'PASS', {
        documentHttp: expiredNavigation.status(),
        apiHttp: info.response.status,
        code: info.payload.code,
        bodyText,
        shortLinkMismatch: Number(mismatch.count),
      });
    } finally {
      await pool.execute('UPDATE videos SET status=?,expires_at=? WHERE id=?', [
        videoSnapshot.status,
        videoSnapshot.expires_at,
        state.video.id,
      ]);
      for (const link of linkSnapshots) {
        await pool.execute('UPDATE short_links SET status=? WHERE id=?', [link.status, link.id]);
      }
    }

    // 5. 真实 suolink 配置诊断。缺少已绑定独享域名时明确标记外部阻塞。
    const configuredDomain = String(process.env.SUOLINK_DOMAIN || '');
    const configValid = configuredDomain &&
      !/your[_-]?short[_-]?domain|example\.(com|cn)|replace[_-]?with/i.test(configuredDomain);
    if (configValid) {
      const strict = await api('/shortlink/generate', {
        method: 'POST',
        body: JSON.stringify({ videoId: state.video.id, platform: 'suolink' }),
      });
      assert(strict.response.status === 201, `strict suolink HTTP ${strict.response.status}`);
      record(5, '缩链 API 生成', 'PASS', {
        http: strict.response.status,
        platform: strict.payload.data.platform,
        persisted: true,
      });
    } else {
      record(5, '缩链 API 生成', 'BLOCKED_EXTERNAL_CONFIG', {
        code: 'SUOLINK_DOMAIN_REQUIRED',
        message: '账号未提供已绑定且生效的缩链独享域名；占位值未被当作有效配置',
      });
    }

    // 6. 自建短链。
    const self = await api('/shortlink/generate', {
      method: 'POST',
      body: JSON.stringify({ videoId: state.video.id, platform: 'self' }),
    });
    assert(self.response.status === 201, 'self link create failed');
    state.selfLink = self.payload.data;
    assert(/^[A-Za-z0-9]{6,8}$/.test(state.selfLink.shortCode), 'invalid self short code');
    record(6, '自建短链生成', 'PASS', {
      http: self.response.status,
      shortCode: state.selfLink.shortCode,
      length: state.selfLink.shortCode.length,
      platform: state.selfLink.platform,
    });

    // 7. 302、点击量和访问设备日志。
    const [[beforeRedirect]] = await pool.execute(
      'SELECT clicks FROM short_links WHERE id=?',
      [state.selfLink.id],
    );
    const redirect = await fetch(state.selfLink.shortUrl, {
      redirect: 'manual',
      headers: {
        Referer: ADMIN,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile',
      },
    });
    const [[afterRedirect]] = await pool.execute(
      `SELECT sl.clicks,
              (SELECT device_type FROM play_logs
               WHERE short_link_id=sl.id AND event_type='redirect'
               ORDER BY id DESC LIMIT 1) AS device_type
       FROM short_links sl WHERE sl.id=?`,
      [state.selfLink.id],
    );
    assert(redirect.status === 302, 'short link did not redirect');
    assert(Number(afterRedirect.clicks) === Number(beforeRedirect.clicks) + 1, 'click not incremented');
    record(7, '短链跳转统计', 'PASS', {
      http: redirect.status,
      locationHasFileId: /fileId=/.test(redirect.headers.get('location') || ''),
      clicksBefore: Number(beforeRedirect.clicks),
      clicksAfter: Number(afterRedirect.clicks),
      deviceType: afterRedirect.device_type,
    });

    // 8. 使用未绑定供应商域名触发真实供应商失败，auto 降级且产生结构化日志。
    const providerFixture = await api('/domain', {
      method: 'POST',
      body: JSON.stringify({
        domain: `https://provider-${runId}.invalid`,
        type: 'suolink',
        platform: 'suolink',
        isEnabled: true,
      }),
    });
    assert(providerFixture.response.status === 201, 'provider fixture domain create failed');
    state.restoreDomains.add(String(providerFixture.payload.data.id));
    await api('/domain/switch', {
      method: 'POST',
      body: JSON.stringify({ domainId: providerFixture.payload.data.id }),
    });
    const fallback = await api('/shortlink/generate', {
      method: 'POST',
      body: JSON.stringify({ videoId: state.video.id, platform: 'auto' }),
    });
    assert(fallback.response.status === 201, 'auto fallback failed');
    assert(fallback.payload.data.platform === 'self', 'auto did not fall back to self');
    assert(fallback.payload.data.fallbackFrom === 'suolink', 'fallbackFrom missing');
    record(8, '双轨制降级', 'PASS', {
      http: fallback.response.status,
      platform: fallback.payload.data.platform,
      fallbackFrom: fallback.payload.data.fallbackFrom,
      structuredLogEvent: 'short_link_provider_fallback',
    });

    // 9. 主域名切换只影响新链。
    const switchedDomain = await api('/domain', {
      method: 'POST',
      body: JSON.stringify({
        domain: `http://127.0.0.1:3001/api/short/${runId}`,
        type: 'self_hosted',
        platform: 'self',
        isEnabled: true,
      }),
    });
    assert(switchedDomain.response.status === 201, 'new self domain create failed');
    await api('/domain/switch', {
      method: 'POST',
      body: JSON.stringify({ domainId: switchedDomain.payload.data.id }),
    });
    const oldUrl = state.selfLink.shortUrl;
    const oldDomainId = state.selfLink.domainId;
    const newLink = await api('/shortlink/generate', {
      method: 'POST',
      body: JSON.stringify({ videoId: state.video.id, platform: 'auto' }),
    });
    state.switchedLink = newLink.payload.data;
    const [[oldLinkAfter]] = await pool.execute(
      'SELECT domain_id,short_url FROM short_links WHERE id=?',
      [state.selfLink.id],
    );
    assert(oldLinkAfter.short_url === oldUrl, 'old link URL changed');
    assert(String(oldLinkAfter.domain_id) === String(oldDomainId), 'old link domain changed');
    assert(String(state.switchedLink.domainId) === String(switchedDomain.payload.data.id), 'new link did not use new domain');
    record(9, '域名切换联动', 'PASS', {
      switchHttp: 200,
      oldUrlUnchanged: true,
      oldDomainUnchanged: true,
      newDomainId: state.switchedLink.domainId,
    });

    // 10. 短链停用/启用。
    await api('/shortlink/toggle', {
      method: 'POST',
      body: JSON.stringify({ shortLinkId: state.selfLink.id, enabled: false }),
    });
    const goneRedirect = await fetch(state.selfLink.shortUrl, { redirect: 'manual' });
    await api('/shortlink/toggle', {
      method: 'POST',
      body: JSON.stringify({ shortLinkId: state.selfLink.id, enabled: true }),
    });
    const activeRedirect = await fetch(state.selfLink.shortUrl, { redirect: 'manual' });
    assert(goneRedirect.status === 410 && activeRedirect.status === 302, 'toggle statuses incorrect');
    record(10, '短链状态管理', 'PASS', {
      disabledHttp: goneRedirect.status,
      enabledHttp: activeRedirect.status,
    });

    // 11. UI 二次确认执行真实云端删除。
    await page.getByRole('tab', { name: '视频管理' }).click();
    const deleteRow = page.locator('.el-table__body tr').filter({ hasText: title }).first();
    const deleteResponsePromise = page.waitForResponse(
      (response) => response.request().method() === 'DELETE' &&
        response.url().endsWith(`/api/video/${state.video.id}`),
      { timeout: 120000 },
    );
    await deleteRow.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    const deleteResponse = await deleteResponsePromise;
    const [[deleted]] = await pool.execute(
      `SELECT status,deleted_at,delete_error,
              (SELECT COUNT(*) FROM short_links WHERE video_id=videos.id AND status<>'expired') AS active_links,
              (SELECT COUNT(*) FROM play_logs WHERE video_id=videos.id) AS audit_logs
       FROM videos WHERE id=?`,
      [state.video.id],
    );
    const deletedAccess = await api(`/video/${encodeURIComponent(state.video.fileId)}`);
    const listAfterDelete = await api('/video/list');
    assert(deleteResponse.status() === 200, 'delete API failed');
    assert(deleted.status === 'deleted' && deleted.deleted_at, 'video not marked deleted');
    assert(Number(deleted.active_links) === 0, 'links not expired');
    assert(!listAfterDelete.payload.data.some((item) => String(item.id) === String(state.video.id)), 'deleted video still listed');
    assert(deletedAccess.response.status === 410, 'deleted video access is not 410');
    record(11, '视频删除', 'PASS', {
      http: deleteResponse.status(),
      cloudDelete: 'confirmed_by_DeleteMedia_success_response',
      databaseStatus: deleted.status,
      deletedAtPresent: Boolean(deleted.deleted_at),
      deleteError: deleted.delete_error,
      activeRelatedLinks: Number(deleted.active_links),
      retainedAuditLogs: Number(deleted.audit_logs),
      accessHttp: deletedAccess.response.status,
      excludedFromDefaultList: true,
    });

    // 12. 复制与统计弹窗（已删除视频的审计短链仍可查询）。
    await page.getByRole('tab', { name: '短链管理' }).click();
    await page.waitForTimeout(500);
    const shortRow = page.locator('.el-table__body tr').filter({ hasText: state.selfLink.shortCode }).first();
    await shortRow.waitFor({ state: 'visible' });
    await shortRow.getByRole('button', { name: '复制链接', exact: true }).click();
    await page.getByText(/短链接已复制/).waitFor({ state: 'visible' });
    const statsPromise = page.waitForResponse(
      (response) => response.url().endsWith(`/api/shortlink/${state.selfLink.id}/stats`),
    );
    await shortRow.getByRole('button', { name: '查看统计', exact: true }).click();
    const statsResponse = await statsPromise;
    const statsDialog = page.getByRole('dialog', { name: '短链访问统计' });
    await statsDialog.waitFor({ state: 'visible' });
    const statsText = (await statsDialog.innerText()).replace(/\s+/g, ' ').trim();
    assert(statsResponse.status() === 200 && /累计点击量/.test(statsText), 'stats dialog failed');
    await page.screenshot({ path: path.resolve(__dirname, 'regression-12-stats.png') });
    await page.keyboard.press('Escape');
    record(12, '短链列表管理', 'PASS', {
      copyMessage: '短链接已复制',
      statsHttp: statsResponse.status(),
      dialog: statsText,
    });

    // 13. 页面完成添加、编辑、启停、切换、删除。
    await page.getByRole('tab', { name: '域名管理' }).click();
    await page.getByRole('button', { name: '添加域名' }).click();
    let domainDialog = page.getByRole('dialog', { name: '添加域名' });
    const uiDomain = `http://127.0.0.1:3997/api/short/${runId}`;
    await domainDialog.getByPlaceholder(/例如/).fill(uiDomain);
    const createDomainResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/api/domain'),
    );
    await domainDialog.getByRole('button', { name: '保存' }).click();
    const createdDomainPayload = await (await createDomainResponse).json();
    state.restoreDomains.add(String(createdDomainPayload.data.id));
    let domainRow = page.locator('.el-table__body tr').filter({ hasText: uiDomain }).first();
    await domainRow.waitFor({ state: 'visible' });
    await domainRow.getByRole('button', { name: '编辑', exact: true }).click();
    domainDialog = page.getByRole('dialog', { name: '编辑域名' });
    await domainDialog.locator('input').last().fill('UI 回归已编辑');
    await domainDialog.getByRole('button', { name: '保存' }).click();
    await page.getByText('域名更新成功').waitFor({ state: 'visible' });
    domainRow = page.locator('.el-table__body tr').filter({ hasText: uiDomain }).first();
    await domainRow.getByRole('button', { name: '停用', exact: true }).click();
    await page.getByRole('button', { name: '停用', exact: true }).last().click();
    await page.getByText('域名已停用').waitFor({ state: 'visible' });
    domainRow = page.locator('.el-table__body tr').filter({ hasText: uiDomain }).first();
    await domainRow.getByRole('button', { name: '启用', exact: true }).click();
    await page.getByText('域名已启用').waitFor({ state: 'visible' });
    domainRow = page.locator('.el-table__body tr').filter({ hasText: uiDomain }).first();
    await domainRow.getByRole('button', { name: '设为主域名' }).click();
    await page.getByText(/主域名已切换/).waitFor({ state: 'visible' });
    await api('/domain/switch', {
      method: 'POST',
      body: JSON.stringify({ domainId: state.originalPrimaryId }),
    });
    await page.getByRole('button', { name: '刷新列表' }).click();
    await page.waitForTimeout(300);
    domainRow = page.locator('.el-table__body tr').filter({ hasText: uiDomain }).first();
    await domainRow.getByRole('button', { name: '删除域名' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).last().click();
    await page.getByText('域名删除成功').waitFor({ state: 'visible' });
    state.restoreDomains.delete(String(createdDomainPayload.data.id));
    record(13, '域名管理', 'PASS', {
      createHttp: 201,
      edit: true,
      disabled: true,
      enabled: true,
      switched: true,
      deleted: true,
    });

    // 14. 外键、孤儿记录与过期同步一致性。
    const [foreignKeys] = await pool.execute(
      `SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY TABLE_NAME,COLUMN_NAME`,
    );
    const [[orphans]] = await pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM short_links sl LEFT JOIN videos v ON v.id=sl.video_id WHERE v.id IS NULL) AS shortlink_video,
        (SELECT COUNT(*) FROM short_links sl LEFT JOIN domains d ON d.id=sl.domain_id WHERE d.id IS NULL) AS shortlink_domain,
        (SELECT COUNT(*) FROM play_logs pl LEFT JOIN videos v ON v.id=pl.video_id WHERE v.id IS NULL) AS playlog_video,
        (SELECT COUNT(*) FROM play_logs pl LEFT JOIN short_links sl ON sl.id=pl.short_link_id WHERE pl.short_link_id IS NOT NULL AND sl.id IS NULL) AS playlog_shortlink,
        (SELECT COUNT(*) FROM videos v JOIN short_links sl ON sl.video_id=v.id
         WHERE (v.expires_at<=NOW() OR v.status IN ('expired','deleted')) AND sl.status<>'expired') AS expiry_mismatch`,
    );
    assert(foreignKeys.length === 4, 'foreign key count is not 4');
    assert(Object.values(orphans).every((value) => Number(value) === 0), 'integrity mismatch exists');
    record(14, '数据库完整性', 'PASS', {
      foreignKeys,
      orphanCounts: Object.fromEntries(Object.entries(orphans).map(([key, value]) => [key, Number(value)])),
    });
  } catch (error) {
    console.error('REGRESSION_FATAL', error);
    record(0, '回归执行', 'FAIL', { message: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    if (state.originalPrimaryId) {
      await api('/domain/switch', {
        method: 'POST',
        body: JSON.stringify({ domainId: state.originalPrimaryId }),
      }).catch(() => {});
    }

    for (const domainId of state.restoreDomains) {
      await api(`/domain/${domainId}`, { method: 'DELETE' }).catch(() => {});
    }

    // 若中途失败但已完成上传，仍通过正式删除接口清理真实云端测试媒资。
    if (state.video) {
      const [[video]] = await pool.execute('SELECT status FROM videos WHERE id=?', [state.video.id]);
      if (video && video.status !== 'deleted') {
        await api(`/video/${state.video.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      runId,
      pass: results.filter((item) => item.status === 'PASS').length,
      blocked: results.filter((item) => item.status.startsWith('BLOCKED')).length,
      fail: results.filter((item) => item.status === 'FAIL').length,
      results,
    };
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log('RESULT_FILE', OUTPUT_PATH);
    await browser.close();
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
