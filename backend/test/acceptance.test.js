const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = require('../src/config/db');
const vodService = require('../src/services/vodService');
const suolinkService = require('../src/services/suolinkService');
const cloudflareShortLinkService = require('../src/services/cloudflareShortLinkService');
const unifiedShortLinkService = require('../src/services/unifiedShortLinkService');
const shortLinkService = require('../src/services/shortLinkService');
const { removeCardCover } = require('../src/services/cardCoverService');
const { createCardToken, buildCardUrl } = require('../src/services/cardPageService');
const { decryptSecret } = require('../src/services/secretConfigService');
const app = require('../src/app');

const runId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
let server;
let baseUrl;
let videoId;
let selfDomainId;
let originalPrimaryId;
let authToken;
const cleanupDomainIds = new Set();
const cleanupVideoIds = new Set();
const cleanupUserIds = new Set();
const cleanupBusinessGroupIds = new Set();

async function request(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  return { response, payload };
}

test.before(async () => {
  const [primaryRows] = await pool.execute(
    'SELECT id FROM domains WHERE is_primary = 1 ORDER BY id LIMIT 1',
  );
  originalPrimaryId = primaryRows[0]?.id;

  const [domainResult] = await pool.execute(
    `INSERT INTO domains
       (domain, type, platform, is_primary, is_enabled, remark)
     VALUES (?, 'self_hosted', 'self', 0, 1, 'automated acceptance fixture')`,
    [`http://127.0.0.1:3001/api/short/test-${runId}`],
  );
  selfDomainId = domainResult.insertId;
  cleanupDomainIds.add(String(selfDomainId));

  const [videoResult] = await pool.execute(
    `INSERT INTO videos
       (file_id, title, status, expires_at)
     VALUES (?, ?, 'ready', DATE_ADD(NOW(), INTERVAL 1 DAY))`,
    [`test-${runId}`, `自动化验收 ${runId}`],
  );
  videoId = videoResult.insertId;
  cleanupVideoIds.add(String(videoId));

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request('/api/management/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000001', password: 'Demo123!' }),
  });
  authToken = login.payload.data?.token;
  assert.ok(authToken, 'demo super admin login failed');
});

test.after(async () => {
  try {
    if (originalPrimaryId) {
      await pool.execute('UPDATE domains SET is_primary = (id = ?)', [originalPrimaryId]);
      await pool.execute(
        `INSERT INTO system_configs (config_key, config_value)
         VALUES ('primary_domain_id', ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [originalPrimaryId],
      );
    }

    if (cleanupVideoIds.size) {
      const videoIds = [...cleanupVideoIds];
      const placeholders = videoIds.map(() => '?').join(',');
      await pool.execute(`DELETE FROM play_logs WHERE video_id IN (${placeholders})`, videoIds);
      await pool.execute(`DELETE FROM short_links WHERE video_id IN (${placeholders})`, videoIds);
      await pool.execute(`DELETE FROM videos WHERE id IN (${placeholders})`, videoIds);
    }

    if (cleanupDomainIds.size) {
      const domainIds = [...cleanupDomainIds];
      const placeholders = domainIds.map(() => '?').join(',');
      await pool.execute(`DELETE FROM domains WHERE id IN (${placeholders})`, domainIds);
    }

    if (cleanupUserIds.size) {
      const userIds = [...cleanupUserIds];
      const placeholders = userIds.map(() => '?').join(',');
      await pool.execute(`DELETE FROM users WHERE id IN (${placeholders})`, userIds);
    }

    if (cleanupBusinessGroupIds.size) {
      const groupIds = [...cleanupBusinessGroupIds];
      const placeholders = groupIds.map(() => '?').join(',');
      await pool.execute(`DELETE FROM business_groups WHERE id IN (${placeholders})`, groupIds);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});

test('all JSON APIs use the unified response envelope', async () => {
  const { response, payload } = await request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'data', 'message', 'success']);
  assert.equal(payload.success, true);
});

test('management authentication and role permissions are enforced', async () => {
  const generalLogin = await request('/api/management/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000004', password: 'Demo123!' }),
  });
  assert.equal(generalLogin.response.status, 200);
  assert.equal(generalLogin.payload.data.user.role, 'general_user');

  const generalToken = generalLogin.payload.data.token;
  const dashboard = await request('/api/management/dashboard', {
    headers: { Authorization: `Bearer ${generalToken}` },
  });
  assert.equal(dashboard.response.status, 200);
  assert.equal(Object.hasOwn(dashboard.payload.data.people, 'businessGroups'), false);
  assert.equal(Object.hasOwn(dashboard.payload.data.people, 'effectiveGroups'), false);

  const denied = await request(`/api/management/materials/${videoId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${generalToken}` },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.code, 'PERMISSION_DENIED');

  const publicPlayback = await request(`/api/video/access?fileId=test-${runId}`);
  assert.equal(publicPlayback.response.status, 200);

  const customerLink = await request('/api/management/customer-link');
  assert.equal(customerLink.response.status, 200);
  assert.ok(customerLink.payload.data.url);

  const deniedCustomerLink = await request('/api/management/customer-link', {
    headers: { Authorization: `Bearer ${generalToken}` },
  });
  assert.equal(deniedCustomerLink.response.status, 403);

  const invalidCustomerLink = await request('/api/management/customer-link', {
    method: 'PUT',
    body: JSON.stringify({ url: 'https://customer.example.com/play?fileId=1' }),
  });
  assert.equal(invalidCustomerLink.response.status, 400);
});

test('business managers have group-scoped read-only promoter access', async () => {
  const managerLogin = await request('/api/management/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000003', password: 'Demo123!' }),
  });
  assert.equal(managerLogin.response.status, 200);
  assert.equal(managerLogin.payload.data.user.role, 'business_manager');
  const managerToken = managerLogin.payload.data.token;
  const managerGroupId = String(managerLogin.payload.data.user.businessGroupId);

  const dashboard = await request('/api/management/dashboard', {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  assert.equal(dashboard.response.status, 200);
  assert.equal(Object.hasOwn(dashboard.payload.data.people, 'businessGroups'), false);
  assert.equal(Object.hasOwn(dashboard.payload.data.people, 'effectiveGroups'), false);

  const users = await request('/api/management/users', {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  assert.equal(users.response.status, 200);
  assert.equal(
    users.payload.data.every((item) =>
      item.role === 'general_user' && String(item.business_group_id) === managerGroupId),
    true,
  );

  for (const [method, url, body] of [
    ['POST', '/api/management/users', {
      name: '无权限新增', phone: `195${Date.now().toString().slice(-8)}`,
      password: 'Denied123!', role: 'general_user', businessGroupId: managerGroupId,
    }],
    ['PUT', '/api/management/users/999999999', { name: '无权限编辑' }],
    ['DELETE', '/api/management/users/999999999', undefined],
  ]) {
    const denied = await request(url, {
      method,
      headers: { Authorization: `Bearer ${managerToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.code, 'PERMISSION_DENIED');
  }
});

test('only super administrators can access domain configuration', async () => {
  const systemAdminLogin = await request('/api/management/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000002', password: 'Demo123!' }),
  });
  assert.equal(systemAdminLogin.response.status, 200);
  assert.equal(systemAdminLogin.payload.data.user.role, 'system_admin');
  const systemAdminToken = systemAdminLogin.payload.data.token;

  for (const [method, url, body] of [
    ['GET', '/api/domain/list'],
    ['GET', '/api/domain/wechat-config'],
    ['GET', '/api/management/customer-link'],
    ['PUT', '/api/management/customer-link', { url: 'https://customer.example.net' }],
  ]) {
    const denied = await request(url, {
      method,
      headers: { Authorization: `Bearer ${systemAdminToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.code, 'PERMISSION_DENIED');
  }

  const superAdminDomainList = await request('/api/domain/list');
  assert.equal(superAdminDomainList.response.status, 200);
  assert.ok(Array.isArray(superAdminDomainList.payload.data));
});

test('legacy WeChat official-account APIs and frontend JS-SDK code are disabled', async () => {
  const config = await request('/api/domain/wechat-config');
  assert.equal(config.response.status, 404);

  const signature = await request(
    `/api/video/wechat-share-signature?url=${encodeURIComponent('https://vod.zzqixiangkeji.cn/play')}`,
  );
  assert.notEqual(signature.response.status, 200);

  const playSource = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/src/views/Play.vue'),
    'utf8',
  );
  assert.equal(/jweixin|wx\.config|wechat-share-signature/i.test(playSource), false);
});

test('play page exposes material metadata for WeChat sharing', async () => {
  const title = `分享标题 & <安全> ${runId}`;
  const description = `分享简介 “测试” ${runId}`;
  const coverUrl = 'https://example.net/share-cover.jpg';
  await pool.execute(
    'UPDATE videos SET title = ?, description = ?, cover_url = ? WHERE id = ?',
    [title, description, coverUrl, videoId],
  );
  const response = await fetch(`${baseUrl}/play?fileId=test-${runId}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`<title>分享标题 &amp; &lt;安全&gt; ${runId}</title>`));
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, /property="og:image" content="https:\/\/example\.net\/share-cover\.jpg"/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /itemprop="name"/);
  assert.match(html, /itemprop="description"/);
  assert.match(html, /itemprop="image" content="https:\/\/example\.net\/share-cover\.jpg"/);
  assert.equal(html.includes('<安全>'), false);

  await pool.execute('UPDATE videos SET cover_url = NULL WHERE id = ?', [videoId]);
  const fallbackResponse = await fetch(`${baseUrl}/play?fileId=test-${runId}`);
  const fallbackHtml = await fallbackResponse.text();
  assert.equal(fallbackResponse.status, 200);
  assert.match(
    fallbackHtml,
    new RegExp(
      `property="og:image" content="${baseUrl.replaceAll('.', '\\.')}/wechat-share-default\\.png"`,
    ),
  );
  assert.match(fallbackHtml, /property="og:image:width" content="600"/);
});

test('material title and description can be edited', async () => {
  const title = `已编辑素材 ${runId}`;
  const description = `已编辑素材简介 ${runId}`;
  const updated = await request(`/api/management/materials/${videoId}`, {
    method: 'PUT',
    body: JSON.stringify({ title, description }),
  });
  assert.equal(updated.response.status, 200);

  const [[material]] = await pool.execute(
    'SELECT title, description FROM videos WHERE id = ?',
    [videoId],
  );
  assert.deepEqual(material, { title, description });
});

test('card cover images can be replaced and publicly loaded', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const formData = new FormData();
  formData.append('cover', new Blob([png], { type: 'image/png' }), 'card-cover.png');
  const uploaded = await request(`/api/management/materials/${videoId}/card-cover`, {
    method: 'POST', body: formData,
  });
  assert.equal(uploaded.response.status, 200);
  assert.match(uploaded.payload.data.coverUrl, /^\/card-covers\/[0-9a-f]{64}\.jpg$/);

  const imageResponse = await fetch(`${baseUrl}${uploaded.payload.data.coverUrl}`);
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('content-type') || '', /^image\/jpeg/);
  const normalizedImage = Buffer.from(await imageResponse.arrayBuffer());
  assert.equal(normalizedImage[0], 0xff);
  assert.equal(normalizedImage[1], 0xd8);
  assert.notDeepEqual(normalizedImage, png);

  const [[material]] = await pool.execute('SELECT cover_url FROM videos WHERE id = ?', [videoId]);
  assert.equal(material.cover_url, uploaded.payload.data.coverUrl);

  await pool.execute('UPDATE videos SET cover_url = NULL WHERE id = ?', [videoId]);
  await removeCardCover(uploaded.payload.data.coverUrl);
});

test('public card route returns server HTML for one short link token', async () => {
  const cardToken = createCardToken();
  const cardUrl = buildCardUrl({ protocol: 'http', get: () => `127.0.0.1:${server.address().port}` }, cardToken);
  const generated = await unifiedShortLinkService.createShortLink(
    cardUrl,
    'self',
    { videoId, cardToken, cardTitle: '独立卡片 & <安全>', cardDescription: '每条短链独立保存', cardCoverUrl: null },
  );
  const response = await fetch(`${baseUrl}/card/${cardToken}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.50' },
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8$/i);
  assert.match(html, /<title>独立卡片 &amp; &lt;安全&gt;<\/title>/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, new RegExp(
    'property="og:image" content="https://vod\\.zzqixiangkeji\\.cn/wechat-share-default\\.png"',
  ));
  assert.match(html, /name="twitter:title"/);
  assert.match(html, /name="twitter:description"/);
  assert.match(html, /name="twitter:image"/);
  assert.match(html, /window\.location\.assign\(/);
  assert.doesNotMatch(html, /\/play|window\.location\.replace|继续打开|继续播放|<div id="app">/);
  const playToken = html.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(playToken);
  assert.equal(
    Buffer.from(playToken, 'base64url').toString('utf8'),
    `/play?fileId=test-${runId}&shortLinkId=${generated.id}`,
  );
  assert.equal(html.includes('<安全>'), false);
  assert.equal(generated.cardToken, cardToken);

  const browserCard = await fetch(`${baseUrl}/card/${cardToken}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/139.0 Safari/537.36' },
  });
  assert.equal(browserCard.status, 200);
  assert.equal(await browserCard.text(), html);

  const saved = await request(`/api/management/short-links/${generated.id}/card`, {
    method: 'PUT',
    body: JSON.stringify({ title: '已保存卡片', description: '已保存描述' }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.data.cardStatus, 'ready');
  const refreshed = await fetch(`${baseUrl}/card/${cardToken}`);
  const refreshedHtml = await refreshed.text();
  assert.match(refreshedHtml, /<title>已保存卡片<\/title>/);

  await pool.execute(
    `UPDATE short_links
     SET platform = 'suolink', short_url = ?
     WHERE id = ?`,
    [`https://w1.hotwharf.com/${crypto.randomBytes(5).toString('hex')}`, generated.id],
  );
  const suolinkCardHtml = await (await fetch(`${baseUrl}/card/${cardToken}`)).text();
  const suolinkPlayToken = suolinkCardHtml.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  const suolinkPlayPath = Buffer.from(suolinkPlayToken, 'base64url').toString('utf8');
  const suolinkPlayResponse = await fetch(`${baseUrl}${suolinkPlayPath}`);
  assert.equal(suolinkPlayResponse.status, 200);
  assert.match(
    await suolinkPlayResponse.text(),
    new RegExp(`name="demo18-share-path" content="/card/${cardToken}"`),
  );

  await pool.execute("UPDATE short_links SET status = 'disabled' WHERE id = ?", [generated.id]);
  assert.equal((await fetch(`${baseUrl}/card/${cardToken}`)).status, 404);
  await pool.execute(
    "UPDATE short_links SET status = 'active', expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?",
    [generated.id],
  );
  assert.equal((await fetch(`${baseUrl}/card/${cardToken}`)).status, 410);
});

test('short-link operations cannot cross business-group boundaries', async () => {
  const cardToken = createCardToken();
  const generated = await unifiedShortLinkService.createShortLink(
    buildCardUrl({ protocol: 'http', get: () => `127.0.0.1:${server.address().port}` }, cardToken),
    'self',
    { videoId, cardToken, cardTitle: '权限测试', cardDescription: '仅所属业务组可修改' },
  );
  const generalLogin = await request('/api/management/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000004', password: 'Demo123!' }),
  });
  const generalToken = generalLogin.payload.data.token;

  const cardUpdate = await request(`/api/management/short-links/${generated.id}/card`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${generalToken}` },
    body: JSON.stringify({ title: '越权修改', description: '不允许' }),
  });
  assert.equal(cardUpdate.response.status, 403);
  assert.equal(cardUpdate.payload.code, 'PERMISSION_DENIED');

  const toggle = await request('/api/shortlink/toggle', {
    method: 'POST',
    headers: { Authorization: `Bearer ${generalToken}` },
    body: JSON.stringify({ shortLinkId: generated.id, enabled: false }),
  });
  assert.equal(toggle.response.status, 404);

  const stats = await request(`/api/shortlink/${generated.id}/stats`, {
    headers: { Authorization: `Bearer ${generalToken}` },
  });
  assert.equal(stats.response.status, 404);

  const list = await request('/api/shortlink/list', {
    headers: { Authorization: `Bearer ${generalToken}` },
  });
  assert.equal(list.response.status, 200);
  assert.equal(list.payload.data.some((link) => String(link.id) === String(generated.id)), false);
});

test('Worker click sync is authenticated and idempotent after migration 005', async (t) => {
  const [columns] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'play_logs'
       AND COLUMN_NAME = 'external_event_id' LIMIT 1`,
  );
  if (!columns.length) {
    t.skip('migration 005_external_shortlink_sync.sql has not been applied');
    return;
  }

  const generated = await unifiedShortLinkService.createShortLink(
    buildCardUrl(
      { protocol: 'http', get: () => `127.0.0.1:${server.address().port}` },
      createCardToken(),
    ),
    'self',
    { videoId },
  );
  const previousKey = process.env.WORKER_SYNC_API_KEY;
  process.env.WORKER_SYNC_API_KEY = 'acceptance-worker-sync-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.WORKER_SYNC_API_KEY;
    else process.env.WORKER_SYNC_API_KEY = previousKey;
  });

  const body = JSON.stringify({
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    userAgent: 'MicroMessenger',
    referer: 'https://s.hotwharf.com/',
    ipAddress: '203.0.113.9',
  });
  const unauthorized = await request(
    `/api/internal/short-links/${generated.shortCode}/click`,
    { method: 'POST', headers: { Authorization: 'Bearer wrong-key' }, body },
  );
  assert.equal(unauthorized.response.status, 401);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const synced = await request(
      `/api/internal/short-links/${generated.shortCode}/click`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer acceptance-worker-sync-key' },
        body,
      },
    );
    assert.equal(synced.response.status, 200);
    assert.equal(synced.payload.data.recorded, attempt === 0);
  }

  const [[link]] = await pool.execute('SELECT clicks FROM short_links WHERE id = ?', [generated.id]);
  assert.equal(Number(link.clicks), 1);
});

test('promoters, system admins, and business groups can be edited', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const createdGroup = await request('/api/management/business-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `验收业务组-${suffix}`,
      managerName: `组管理员-${suffix}`,
      managerPhone: `199${Date.now().toString().slice(-8)}`,
      password: 'EditTest123!',
      expiresAt: null,
    }),
  });
  assert.equal(createdGroup.response.status, 201);
  const groupId = String(createdGroup.payload.data.id);
  cleanupBusinessGroupIds.add(groupId);
  const [[manager]] = await pool.execute(
    'SELECT manager_user_id FROM business_groups WHERE id = ?',
    [groupId],
  );
  cleanupUserIds.add(String(manager.manager_user_id));

  const updatedGroup = await request(`/api/management/business-groups/${groupId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: `已编辑业务组-${suffix}`,
      managerName: `已编辑管理员-${suffix}`,
      status: 'active',
      expiresAt: '2030-12-31 23:59:59',
    }),
  });
  assert.equal(updatedGroup.response.status, 200);

  const createdPromoter = await request('/api/management/users', {
    method: 'POST',
    body: JSON.stringify({
      name: `推广员-${suffix}`,
      phone: `198${Date.now().toString().slice(-8)}`,
      password: 'EditTest123!',
      role: 'general_user',
      businessGroupId: groupId,
    }),
  });
  assert.equal(createdPromoter.response.status, 201);
  const promoterId = String(createdPromoter.payload.data.id);
  cleanupUserIds.add(promoterId);
  const newPhone = `197${Date.now().toString().slice(-8)}`;
  const updatedPromoter = await request(`/api/management/users/${promoterId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: `已编辑推广员-${suffix}`,
      phone: newPhone,
      businessGroupId: groupId,
      status: 'active',
      expiresAt: '2030-12-31 23:59:59',
    }),
  });
  assert.equal(updatedPromoter.response.status, 200);

  const createdAdmin = await request('/api/management/users', {
    method: 'POST',
    body: JSON.stringify({
      name: `系统管理员-${suffix}`,
      phone: `196${Date.now().toString().slice(-8)}`,
      password: 'EditTest123!',
      role: 'system_admin',
    }),
  });
  assert.equal(createdAdmin.response.status, 201);
  const adminId = String(createdAdmin.payload.data.id);
  cleanupUserIds.add(adminId);
  const updatedAdmin = await request(`/api/management/users/${adminId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: `已编辑系统管理员-${suffix}`, status: 'active' }),
  });
  assert.equal(updatedAdmin.response.status, 200);

  const groups = await request('/api/management/business-groups');
  const users = await request('/api/management/users');
  const editedGroup = groups.payload.data.find((item) => String(item.id) === groupId);
  const editedPromoter = users.payload.data.find((item) => String(item.id) === promoterId);
  assert.equal(editedGroup.name, `已编辑业务组-${suffix}`);
  assert.equal(editedPromoter.phone, newPhone);
  assert.equal(new Date(editedGroup.expires_at).toISOString(), '2030-12-31T15:59:59.000Z');
  assert.equal(new Date(editedPromoter.expires_at).toISOString(), '2030-12-31T15:59:59.000Z');
  assert.equal(users.payload.data.find((item) => String(item.id) === adminId).name, `已编辑系统管理员-${suffix}`);
});

test('playback start is idempotent and progress is throttled', async () => {
  const sessionId = crypto.randomUUID();
  const event = (eventType, playedSeconds) => request(`/api/video/${videoId}/events`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, eventType, playedSeconds }),
  });
  const firstStart = await event('start', 0);
  const duplicateStart = await event('start', 0.1);
  const firstProgress = await event('progress', 4);
  const throttledProgress = await event('progress', 5);

  assert.equal(firstStart.response.status, 201);
  assert.equal(duplicateStart.response.status, 200);
  assert.equal(duplicateStart.payload.data.duplicate, true);
  assert.equal(firstProgress.response.status, 201);
  assert.equal(throttledProgress.payload.data.throttled, true);

  const [rows] = await pool.execute(
    `SELECT event_type, COUNT(*) AS count
     FROM play_logs WHERE video_id = ? AND session_id = ?
     GROUP BY event_type`,
    [videoId, sessionId],
  );
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.event_type, Number(row.count)])),
    { start: 1, progress: 1 },
  );
});

test('domain CRUD, toggle, primary guards, and validation work', async () => {
  const port = 30000 + Number.parseInt(crypto.randomBytes(2).toString('hex'), 16) % 20000;
  const domain = `http://127.0.0.1:${port}`;
  const created = await request('/api/domain', {
    method: 'POST',
    body: JSON.stringify({
      domain,
      type: 'self_hosted',
      platform: 'self',
      remark: 'created by automated test',
      isEnabled: true,
    }),
  });
  assert.equal(created.response.status, 201);
  const domainId = created.payload.data.id;
  cleanupDomainIds.add(String(domainId));

  const updated = await request(`/api/domain/${domainId}`, {
    method: 'PUT',
    body: JSON.stringify({
      domain,
      type: 'self_hosted',
      platform: 'self',
      remark: 'updated',
      isEnabled: true,
    }),
  });
  assert.equal(updated.response.status, 200);

  const disabled = await request(`/api/domain/${domainId}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.response.status, 200);

  const switchDisabled = await request('/api/domain/switch', {
    method: 'POST',
    body: JSON.stringify({ domainId }),
  });
  assert.equal(switchDisabled.response.status, 409);

  await request(`/api/domain/${domainId}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  const deleted = await request(`/api/domain/${domainId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  cleanupDomainIds.delete(String(domainId));

  const mismatch = await request('/api/domain', {
    method: 'POST',
    body: JSON.stringify({
      domain: `https://mismatch-${runId}.invalid`,
      type: 'suolink',
      platform: 'self',
    }),
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.payload.code, 'DOMAIN_PLATFORM_MISMATCH');

  const deletePrimary = await request(`/api/domain/${originalPrimaryId}`, {
    method: 'DELETE',
  });
  assert.equal(deletePrimary.response.status, 409);
  assert.equal(deletePrimary.payload.code, 'PRIMARY_DOMAIN_CONFLICT');

  const pathDomain = await request('/api/domain', {
    method: 'POST',
    body: JSON.stringify({
      domain: `${domain}/play`,
      type: 'self_hosted',
      platform: 'self',
    }),
  });
  assert.equal(pathDomain.response.status, 400);
});

test('Suolink settings are optional and API keys are encrypted and masked', async () => {
  const configKeys = ['suolink_api_key', 'suolink_domain', 'suolink_enabled', 'shortlink_platform', 'primary_domain_id'];
  const placeholders = configKeys.map(() => '?').join(',');
  const [originalConfigRows] = await pool.execute(
    `SELECT config_key, config_value FROM system_configs WHERE config_key IN (${placeholders})`,
    configKeys,
  );
  const [originalDomainRows] = await pool.execute(
    'SELECT id, is_primary, is_enabled FROM domains',
  );
  const domain = `s-${crypto.randomBytes(4).toString('hex')}.example.net`;
  const apiKey = `real-key-${crypto.randomBytes(12).toString('hex')}`;
  let createdDomainId;

  try {
    const incomplete = await request('/api/domain/suolink-config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, apiKey: '', domain: '' }),
    });
    assert.equal(incomplete.response.status, 400);
    assert.equal(incomplete.payload.code, 'SUOLINK_CONFIG_INCOMPLETE');

    const saved = await request('/api/domain/suolink-config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, apiKey, domain }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.data.enabled, true);
    assert.equal(saved.payload.data.apiKeyConfigured, true);
    assert.equal(saved.payload.data.apiKeyMasked.endsWith(apiKey.slice(-4)), true);
    assert.equal(JSON.stringify(saved.payload).includes(apiKey), false);

    const [[storedKey]] = await pool.execute(
      "SELECT config_value FROM system_configs WHERE config_key = 'suolink_api_key'",
    );
    assert.notEqual(storedKey.config_value, apiKey);
    assert.equal(decryptSecret(storedKey.config_value), apiKey);

    const config = await request('/api/domain/suolink-config');
    assert.equal(config.response.status, 200);
    assert.equal(config.payload.data.domain, domain);
    assert.equal(Object.hasOwn(config.payload.data, 'apiKey'), false);
    assert.equal(JSON.stringify(config.payload).includes(apiKey), false);

    const [[createdDomain]] = await pool.execute(
      "SELECT id FROM domains WHERE domain = ? AND platform = 'suolink'",
      [`https://${domain}`],
    );
    createdDomainId = createdDomain.id;
  } finally {
    if (createdDomainId) await pool.execute('DELETE FROM domains WHERE id = ?', [createdDomainId]);
    await pool.execute(
      `DELETE FROM system_configs WHERE config_key IN (${placeholders})`,
      configKeys,
    );
    for (const row of originalConfigRows) {
      await pool.execute(
        'INSERT INTO system_configs (config_key, config_value) VALUES (?, ?)',
        [row.config_key, row.config_value],
      );
    }
    for (const domainState of originalDomainRows) {
      await pool.execute(
        'UPDATE domains SET is_primary = ?, is_enabled = ? WHERE id = ?',
        [domainState.is_primary, domainState.is_enabled, domainState.id],
      );
    }
  }
});

test('domain pool balances toward the least-used enabled domain', () => {
  const candidates = unifiedShortLinkService.selectCandidates([
    { id: 1, platform: 'self', is_primary: 1, link_count: 4 },
    { id: 2, platform: 'self', is_primary: 0, link_count: 1 },
    { id: 3, platform: 'self', is_primary: 0, link_count: 1 },
    { id: 4, platform: 'self', is_primary: 0, link_count: 7 },
  ], 'self');
  assert.deepEqual(candidates.map((item) => item.id), [2, 3, 1, 4]);

  const primaryTie = unifiedShortLinkService.selectCandidates([
    { id: 5, platform: 'self', is_primary: 0, link_count: 2 },
    { id: 6, platform: 'self', is_primary: 1, link_count: 2 },
  ], 'auto');
  assert.deepEqual(primaryTie.map((item) => item.id), [6, 5]);
});

test('enabled Suolink domain pool preserves every provider domain and balances by usage', () => {
  const domains = [
    {
      id: 1,
      domain: 'https://w1.hotwharf.com',
      type: 'suolink',
      platform: 'suolink',
      link_count: 4,
    },
    {
      id: 2,
      domain: 'https://i6q.cn',
      type: 'suolink',
      platform: 'suolink',
      link_count: 1,
    },
    {
      id: 3,
      domain: 'https://iq1k.cn',
      type: 'suolink',
      platform: 'suolink',
      link_count: 1,
    },
    {
      id: 4,
      domain: 'https://m6z.cn',
      type: 'suolink',
      platform: 'suolink',
      link_count: 6,
    },
    {
      id: 5,
    domain: 'https://vod.zzqixiangkeji.cn',
      type: 'self_hosted',
      platform: 'self',
      link_count: 0,
    },
  ];

  const enabled = unifiedShortLinkService.reconcileConfiguredSuolinkDomain(domains, {
    enabled: true,
    domain: 'w1.hotwharf.com',
  });
  assert.deepEqual(enabled.map((item) => item.id), [1, 2, 3, 4, 5]);
  assert.equal(enabled.find((item) => item.id === 1).is_preferred, 1);
  assert.equal(enabled.find((item) => item.id === 2).is_preferred, 0);
  assert.deepEqual(
    unifiedShortLinkService.selectCandidates(enabled, 'suolink').map((item) => item.id),
    [2, 3, 1, 4],
  );
  assert.deepEqual(
    unifiedShortLinkService.selectCandidates(enabled, 'auto').map((item) => item.id),
    [2, 3, 1, 4, 5],
  );

  const disabled = unifiedShortLinkService.reconcileConfiguredSuolinkDomain(domains, {
    enabled: false,
    domain: 'w1.hotwharf.com',
  });
  assert.deepEqual(disabled.map((item) => item.id), [5]);

  const noPreferredDomain = unifiedShortLinkService.reconcileConfiguredSuolinkDomain(
    domains,
    { enabled: true, domain: 'not-in-pool.example' },
  );
  assert.deepEqual(
    noPreferredDomain
      .filter((item) => item.platform === 'suolink')
      .map((item) => item.is_preferred),
    [0, 0, 0, 0],
  );
});

test('self short links use 6-8 alphanumeric characters', async () => {
  const [[databaseClock]] = await pool.execute(
    'SELECT NOW() AS database_now, @@session.time_zone AS session_time_zone',
  );
  assert.equal(databaseClock.session_time_zone, '+00:00');
  assert.ok(
    Math.abs(new Date(databaseClock.database_now).getTime() - Date.now()) < 5000,
    'database clock should represent the current UTC instant',
  );

  const result = await unifiedShortLinkService.createShortLink(
    `http://localhost:5173/play?fileId=test-${runId}`,
    'self',
    { videoId },
  );
  assert.match(result.shortCode, /^[A-Za-z0-9]{6,8}$/);
  assert.equal(result.platform, 'self');
  const [[createdLink]] = await pool.execute(
    'SELECT created_at FROM short_links WHERE id = ?',
    [result.id],
  );
  assert.ok(
    Math.abs(new Date(createdLink.created_at).getTime() - Date.now()) < 5000,
    'short-link creation time should represent the current UTC instant',
  );

  const cardTitle = `短链卡片 & <安全> ${runId}`;
  const cardDescription = `微信直接抓取短链元数据 ${runId}`;
  await pool.execute(
    'UPDATE videos SET title = ?, description = ?, cover_url = NULL WHERE id = ?',
    [cardTitle, cardDescription, videoId],
  );
  const [[clicksBeforeCardFetch]] = await pool.execute(
    'SELECT clicks FROM short_links WHERE id = ?',
    [result.id],
  );
  const cardResponse = await fetch(`${baseUrl}/api/short/${result.shortCode}`, {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });
  const cardHtml = await cardResponse.text();
  assert.equal(cardResponse.status, 200);
  assert.match(cardResponse.headers.get('content-type') || '', /^text\/html/);
  assert.match(cardHtml, new RegExp(`<title>短链卡片 &amp; &lt;安全&gt; ${runId}</title>`));
  assert.match(cardHtml, /property="og:title"/);
  assert.match(cardHtml, /property="og:description"/);
  assert.match(
    cardHtml,
    /property="og:image" content="http:\/\/localhost:5173\/wechat-share-default\.png"/,
  );
  const legacyPlayToken = cardHtml.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(legacyPlayToken);
  assert.match(Buffer.from(legacyPlayToken, 'base64url').toString('utf8'), new RegExp(`shortLinkId=${result.id}`));
  assert.match(cardHtml, /window\.location\.assign\(/);
  assert.doesNotMatch(cardHtml, /\/play|window\.location\.replace|继续打开|继续播放/);
  assert.equal(cardHtml.includes('<安全>'), false);
  const [[clicksAfterCardFetch]] = await pool.execute(
    'SELECT clicks FROM short_links WHERE id = ?',
    [result.id],
  );
  assert.equal(
    Number(clicksAfterCardFetch.clicks),
    Number(clicksBeforeCardFetch.clicks) + 1,
  );

  await shortLinkService.createShortLink(
    videoId,
    selfDomainId,
    `http://localhost:5173/play?fileId=test-${runId}`,
  );

  const deleteInUse = await request(`/api/domain/${selfDomainId}`, {
    method: 'DELETE',
  });
  assert.equal(deleteInUse.response.status, 409);
  assert.equal(deleteInUse.payload.code, 'DOMAIN_IN_USE');
});

test('suolink failures are classified and auto mode safely falls back', async () => {
  const configKeys = ['suolink_enabled', 'suolink_domain'];
  const placeholders = configKeys.map(() => '?').join(',');
  const [originalConfigRows] = await pool.execute(
    `SELECT config_key, config_value FROM system_configs WHERE config_key IN (${placeholders})`,
    configKeys,
  );
  const providerDomain = `provider-${runId}.invalid`;
  const [domainResult] = await pool.execute(
    `INSERT INTO domains
       (domain, type, platform, is_primary, is_enabled, remark)
     VALUES (?, 'suolink', 'suolink', 1, 1, 'automated provider fixture')`,
    [`https://${providerDomain}`],
  );
  const suolinkDomainId = domainResult.insertId;
  cleanupDomainIds.add(String(suolinkDomainId));
  const secondaryProviderDomain = `provider-fallback-${runId}.invalid`;
  const [secondaryDomainResult] = await pool.execute(
    `INSERT INTO domains
       (domain, type, platform, is_primary, is_enabled, remark)
     VALUES (?, 'suolink', 'suolink', 0, 1, 'automated provider retry fixture')`,
    [`https://${secondaryProviderDomain}`],
  );
  cleanupDomainIds.add(String(secondaryDomainResult.insertId));
  await pool.execute('UPDATE domains SET is_primary = (id = ?)', [suolinkDomainId]);
  await pool.execute(
    `INSERT INTO system_configs (config_key, config_value) VALUES
       ('suolink_enabled', '1'), ('suolink_domain', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [providerDomain],
  );

  const originalCreate = suolinkService.createShortLink;
  const providerError = new Error('provider unavailable');
  providerError.code = 'SUOLINK_PROVIDER_ERROR';
  providerError.status = 502;
  const cardRequest = (extra = {}) => {
    const cardToken = createCardToken();
    return [
      buildCardUrl(
        { protocol: 'http', get: () => `127.0.0.1:${server.address().port}` },
        cardToken,
      ),
      { videoId, cardToken, ...extra },
    ];
  };

  try {
    const attemptedDomains = [];
    const observedExpireDates = [];
    suolinkService.createShortLink = async (longUrl, options) => {
      attemptedDomains.push(options.domain);
      observedExpireDates.push(options.expireDate);
      if (options.domain === providerDomain) throw providerError;
      return {
        shortCode: `retry-${runId}`,
        shortUrl: `https://${options.domain}/retry-${runId}`,
      };
    };
    const retryRequest = cardRequest();
    const retried = await unifiedShortLinkService.createShortLink(
      retryRequest[0], 'suolink', retryRequest[1],
    );
    assert.equal(retried.domain, `https://${secondaryProviderDomain}`);
    assert.deepEqual(attemptedDomains, [providerDomain, secondaryProviderDomain]);
    assert.deepEqual(retried.providerRejectedDomains, [`https://${providerDomain}`]);

    // Suolink 供应商按北京时间（UTC+8）解释 expireDate；视频过期时间按该
    // 时区取日期，避免 UTC 与北京时间交替的边界把过期日算成前一天。
    const [[expiryVideo]] = await pool.execute(
      'SELECT expires_at FROM videos WHERE id = ?',
      [videoId],
    );
    const expectedExpireDate = new Date(
      new Date(expiryVideo.expires_at).getTime() + 8 * 60 * 60 * 1000,
    ).toISOString().slice(0, 10);
    assert.ok(observedExpireDates.length > 0);
    assert.ok(
      observedExpireDates.every((value) => value === expectedExpireDate),
      `expireDate should use the Beijing date, got ${observedExpireDates.join(',')}`,
    );

    suolinkService.createShortLink = async () => {
      throw providerError;
    };
    const explicitProviderFailure = await request('/api/shortlink/generate', {
      method: 'POST',
      body: JSON.stringify({ videoId, platform: 'suolink', allowFallback: false }),
    });
    assert.equal(explicitProviderFailure.response.status, 502);
    assert.equal(explicitProviderFailure.payload.code, 'SUOLINK_PROVIDER_ERROR');

    const fallbackRequest = cardRequest();
    const fallback = await unifiedShortLinkService.createShortLink(
      fallbackRequest[0], 'auto', fallbackRequest[1],
    );
    assert.equal(fallback.platform, 'self');
    assert.equal(fallback.fallbackFrom, 'suolink');

    await assert.rejects(
      () => {
        const values = cardRequest({ allowFallback: false });
        return unifiedShortLinkService.createShortLink(values[0], 'auto', values[1]);
      },
      (error) => error.code === 'SUOLINK_PROVIDER_ERROR' && error.status === 502,
    );

    await assert.rejects(
      () => {
        const values = cardRequest();
        return unifiedShortLinkService.createShortLink(values[0], 'suolink', values[1]);
      },
      (error) => error.code === 'SUOLINK_PROVIDER_ERROR' && error.status === 502,
    );
  } finally {
    suolinkService.createShortLink = originalCreate;
    await pool.execute('UPDATE domains SET is_primary = (id = ?)', [originalPrimaryId]);
    await pool.execute(
      `DELETE FROM system_configs WHERE config_key IN (${placeholders})`,
      configKeys,
    );
    for (const row of originalConfigRows) {
      await pool.execute(
        'INSERT INTO system_configs (config_key, config_value) VALUES (?, ?)',
        [row.config_key, row.config_value],
      );
    }
  }

  assert.throws(
    () => suolinkService.getDomain('your_short_domain.com'),
    (error) => error.code === 'SUOLINK_CONFIG_ERROR' && error.status === 503,
  );
});

test('Cloudflare outage falls back to another self-hosted domain', async () => {
  const workerDomain = `https://worker-${crypto.randomBytes(6).toString('hex')}.invalid`;
  const [domainResult] = await pool.execute(
    `INSERT INTO domains
       (domain, type, platform, is_primary, is_enabled, remark)
     VALUES (?, 'self_hosted', 'self', 1, 1, 'Cloudflare outage fixture')`,
    [workerDomain],
  );
  const workerDomainId = domainResult.insertId;
  cleanupDomainIds.add(String(workerDomainId));
  await pool.execute('UPDATE domains SET is_primary = (id = ?)', [workerDomainId]);

  const originalIsManagedDomain = cloudflareShortLinkService.isManagedDomain;
  const originalIsConfigured = cloudflareShortLinkService.isConfigured;
  const originalCreateMapping = cloudflareShortLinkService.createMapping;
  const originalDeleteMapping = cloudflareShortLinkService.deleteMapping;
  cloudflareShortLinkService.isManagedDomain = (domain) => domain === workerDomain;
  cloudflareShortLinkService.isConfigured = () => true;
  cloudflareShortLinkService.createMapping = async () => {
    const error = new Error('worker unavailable');
    error.code = 'CLOUDFLARE_SYNC_FAILED';
    throw error;
  };
  cloudflareShortLinkService.deleteMapping = async () => ({ status: 'deleted' });

  try {
    const cardToken = createCardToken();
    const cardUrl = buildCardUrl(
      { protocol: 'http', get: () => `127.0.0.1:${server.address().port}` },
      cardToken,
    );
    const fallback = await unifiedShortLinkService.createShortLink(cardUrl, 'auto', {
      videoId,
      cardToken,
    });
    assert.equal(fallback.platform, 'self');
    assert.equal(fallback.fallbackFrom, 'cloudflare');
    assert.notEqual(fallback.domain, workerDomain);
  } finally {
    cloudflareShortLinkService.isManagedDomain = originalIsManagedDomain;
    cloudflareShortLinkService.isConfigured = originalIsConfigured;
    cloudflareShortLinkService.createMapping = originalCreateMapping;
    cloudflareShortLinkService.deleteMapping = originalDeleteMapping;
    await pool.execute('UPDATE domains SET is_primary = (id = ?)', [originalPrimaryId]);
  }
});

test('self-created /s cards are authenticated, scoped, server-rendered, and lifecycle-safe', async (t) => {
  const unauthorized = await request('/api/shortlink/self-create', {
    method: 'POST',
    headers: { Authorization: '' },
    body: JSON.stringify({ videoId }),
  });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.payload.code, 'AUTH_REQUIRED');

  const [foreignGroupResult] = await pool.execute(
    `INSERT INTO business_groups (name, status, expires_at)
     VALUES (?, 'active', DATE_ADD(NOW(), INTERVAL 1 DAY))`,
    [`自建短链越权测试-${runId}`],
  );
  const foreignGroupId = foreignGroupResult.insertId;
  cleanupBusinessGroupIds.add(String(foreignGroupId));
  const [foreignVideoResult] = await pool.execute(
    `INSERT INTO videos
       (file_id, title, status, expires_at, business_group_id)
     VALUES (?, ?, 'ready', DATE_ADD(NOW(), INTERVAL 1 DAY), ?)`,
    [`foreign-self-${runId}`, `越权自建短链 ${runId}`, foreignGroupId],
  );
  const foreignVideoId = foreignVideoResult.insertId;
  cleanupVideoIds.add(String(foreignVideoId));

  const generalLogin = await request('/api/management/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone: '13800000004', password: 'Demo123!' }),
  });
  const forbidden = await request('/api/shortlink/self-create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${generalLogin.payload.data.token}` },
    body: JSON.stringify({ videoId: foreignVideoId }),
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.payload.code, 'PERMISSION_DENIED');

  const created = await request('/api/shortlink/self-create', {
    method: 'POST',
    body: JSON.stringify({
      videoId,
      title: `自建卡片 & <安全> ${runId}`,
      description: `用户点击按钮后才进入播放页 ${runId}`,
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.data.platform, 'self');
  assert.match(created.payload.data.shortCode, /^[A-Za-z0-9]{6,8}$/);
  assert.match(created.payload.data.shortUrl, /\/s\/[A-Za-z0-9]{6,8}$/);
  assert.equal(new URL(created.payload.data.shortUrl).origin, 'https://vod.zzqixiangkeji.cn');
  const selfLinkId = created.payload.data.id;
  const selfCode = created.payload.data.shortCode;

  const [[savedLink]] = await pool.execute(
    'SELECT platform, clicks FROM short_links WHERE id = ?',
    [selfLinkId],
  );
  assert.equal(savedLink.platform, 'self');
  assert.equal(Number(savedLink.clicks), 0);

  const crawlerResponse = await fetch(`${baseUrl}/s/${selfCode}`, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0' },
  });
  const cardHtml = await crawlerResponse.text();
  assert.equal(crawlerResponse.status, 200);
  assert.match(crawlerResponse.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8$/i);
  assert.match(cardHtml, /<meta name="description"/);
  assert.match(cardHtml, /property="og:title"/);
  assert.match(cardHtml, /property="og:description"/);
  assert.match(cardHtml, /property="og:image"/);
  assert.match(cardHtml, /property="og:image:secure_url"/);
  assert.match(cardHtml, /property="og:image:width" content="600"/);
  assert.match(cardHtml, /property="og:image:height" content="600"/);
  assert.match(cardHtml, new RegExp(
    `property="og:url" content="${baseUrl.replaceAll('.', '\\.')}/s/${selfCode}"`,
  ));
  assert.match(cardHtml, new RegExp(
    `rel="canonical" href="${baseUrl.replaceAll('.', '\\.')}/s/${selfCode}"`,
  ));
  assert.match(cardHtml, /name="twitter:card"/);
  assert.match(cardHtml, /name="twitter:title"/);
  assert.match(cardHtml, /name="twitter:description"/);
  assert.match(cardHtml, /name="twitter:image"/);
  assert.match(cardHtml, /<img class="cover"/);
  assert.match(cardHtml, /正在打开视频/);
  assert.doesNotMatch(cardHtml, /继续播放|<button/);
  assert.match(cardHtml, /window\.location\.assign\(destination\.pathname/);
  assert.doesNotMatch(cardHtml, /\/play|301|302|window\.location\.replace|<div id="app">/);
  assert.equal(cardHtml.includes('<安全>'), false);

  const browserResponse = await fetch(`${baseUrl}/s/${selfCode}`, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/139.0 Safari/537.36' },
  });
  const browserHtml = await browserResponse.text();
  assert.equal(browserResponse.status, 200);
  assert.match(browserResponse.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8$/i);
  assert.equal(browserHtml, cardHtml);

  const expectedPlayHref = `/play?fileId=test-${runId}&amp;shortLinkId=${selfLinkId}`;
  const playToken = cardHtml.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(playToken);
  assert.equal(Buffer.from(playToken, 'base64url').toString('utf8'), expectedPlayHref.replaceAll('&amp;', '&'));
  const playResponse = await fetch(
    `${baseUrl}${expectedPlayHref.replaceAll('&amp;', '&')}`,
    { redirect: 'manual' },
  );
  assert.equal(playResponse.status, 200);
  const playHtml = await playResponse.text();
  assert.match(
    playHtml,
    new RegExp(`name="demo18-share-path" content="/s/${selfCode}"`),
  );
  assert.doesNotMatch(playHtml, /demo18-share-path[^>]+https?:|demo18-share-path[^>]+\/\//);

  const ordinaryPlay = await fetch(
    `${baseUrl}/play?fileId=test-${runId}&sharePath=${encodeURIComponent('https://evil.example/card/token')}`,
  );
  assert.equal(ordinaryPlay.status, 200);
  assert.doesNotMatch(await ordinaryPlay.text(), /name="demo18-share-path"/);

  const [[afterClick]] = await pool.execute(
    `SELECT sl.clicks,
            (SELECT COUNT(*) FROM play_logs
             WHERE short_link_id = sl.id AND event_type = 'redirect') AS redirect_logs
     FROM short_links sl WHERE sl.id = ?`,
    [selfLinkId],
  );
  assert.equal(Number(afterClick.clicks), 2);
  assert.equal(Number(afterClick.redirect_logs), 2);

  const cardCover = new FormData();
  cardCover.append('cover', new Blob([Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )], { type: 'image/png' }), 'self-card-cover.png');
  const uploadedCover = await request(
    `/api/management/short-links/${selfLinkId}/card-cover`,
    { method: 'POST', body: cardCover },
  );
  assert.equal(uploadedCover.response.status, 200);
  t.after(() => removeCardCover(uploadedCover.payload.data.coverUrl));

  const updatedCard = await request(`/api/management/short-links/${selfLinkId}/card`, {
    method: 'PUT',
    body: JSON.stringify({
      title: `更新后的自建卡片 ${runId}`,
      description: `更新后的自建卡片描述 ${runId}`,
    }),
  });
  assert.equal(updatedCard.response.status, 200);
  const updatedResponse = await fetch(`${baseUrl}/s/${selfCode}`);
  const updatedHtml = await updatedResponse.text();
  assert.match(updatedHtml, new RegExp(`更新后的自建卡片 ${runId}`));
  assert.match(updatedHtml, /property="og:image" content="https:\/\/vod\.zzqixiangkeji\.cn\/card-covers\//);

  const disabled = await request('/api/shortlink/toggle', {
    method: 'POST',
    body: JSON.stringify({ shortLinkId: selfLinkId, enabled: false }),
  });
  assert.equal(disabled.response.status, 200);
  assert.equal((await fetch(`${baseUrl}/s/${selfCode}`)).status, 404);
  assert.equal(
    (await fetch(`${baseUrl}/play?fileId=test-${runId}&shortLinkId=${selfLinkId}`)).status,
    404,
  );

  const enabled = await request('/api/shortlink/toggle', {
    method: 'POST',
    body: JSON.stringify({ shortLinkId: selfLinkId, enabled: true }),
  });
  assert.equal(enabled.response.status, 200);
  await pool.execute(
    `UPDATE short_links
     SET status = 'active', expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)
     WHERE id = ?`,
    [selfLinkId],
  );
  assert.equal((await fetch(`${baseUrl}/s/${selfCode}`)).status, 410);
  assert.equal(
    (await fetch(`${baseUrl}/play?fileId=test-${runId}&shortLinkId=${selfLinkId}`)).status,
    410,
  );
  assert.equal(
    (await fetch(`${baseUrl}/play?fileId=test-${runId}&shortLinkId=not-a-number`)).status,
    404,
  );

  const deletionFixture = await request('/api/shortlink/self-create', {
    method: 'POST',
    body: JSON.stringify({ videoId }),
  });
  assert.equal(deletionFixture.response.status, 201);
  const deleted = await request(`/api/shortlink/${deletionFixture.payload.data.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(
    (await fetch(`${baseUrl}/s/${deletionFixture.payload.data.shortCode}`)).status,
    404,
  );
});

test('A/B creation returns fresh standard and text_description links with safe identical copy', async () => {
  const title = `A/B 素材标题 </title><script>alert(1)</script> ${runId}`;
  const description = `第一行\n\t第二行 </script><img src=x onerror=alert(1)> & ${runId}`;
  const created = await request('/api/shortlink/self-create-ab', {
    method: 'POST',
    body: JSON.stringify({ videoId, title, description }),
  });
  assert.equal(created.response.status, 201);
  const standard = created.payload.data.standard;
  const experiment = created.payload.data.textDescription;
  assert.equal(standard.wechatCardMode, 'standard');
  assert.equal(experiment.wechatCardMode, 'text_description');
  assert.notEqual(String(standard.id), String(experiment.id));
  assert.notEqual(standard.shortCode, experiment.shortCode);
  assert.match(standard.shortUrl, /\/s\/[A-Za-z0-9]{6,8}$/);
  assert.match(experiment.shortUrl, /\/s\/[A-Za-z0-9]{6,8}$/);

  const [savedRows] = await pool.execute(
    `SELECT id, card_token, card_title, card_description, card_cover_url,
            wechat_card_mode
     FROM short_links WHERE id IN (?, ?) ORDER BY id`,
    [standard.id, experiment.id],
  );
  assert.equal(savedRows.length, 2);
  const savedStandard = savedRows.find((row) => row.wechat_card_mode === 'standard');
  const savedExperiment = savedRows.find(
    (row) => row.wechat_card_mode === 'text_description',
  );
  assert.ok(savedStandard);
  assert.ok(savedExperiment);
  assert.equal(savedStandard.card_title, savedExperiment.card_title);
  assert.equal(savedStandard.card_description, savedExperiment.card_description);
  assert.equal(savedExperiment.card_cover_url, null);

  const standardResponse = await fetch(`${baseUrl}/s/${standard.shortCode}`);
  const standardHtml = await standardResponse.text();
  assert.equal(standardResponse.status, 200);
  assert.match(standardHtml, /property="og:image"/);
  assert.match(standardHtml, /name="twitter:image"/);
  assert.match(standardHtml, /<img class="cover"/);

  const wechatResponse = await fetch(`${baseUrl}/s/${experiment.shortCode}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.50' },
  });
  const textHtml = await wechatResponse.text();
  assert.equal(wechatResponse.status, 200);
  const browserResponse = await fetch(`${baseUrl}/s/${experiment.shortCode}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/139.0 Safari/537.36' },
  });
  assert.equal(browserResponse.status, 200);
  assert.equal(await browserResponse.text(), textHtml);

  for (const expected of [
    /<meta name="description"/,
    /<meta property="og:description"/,
    /<meta name="twitter:description"/,
    /<meta itemprop="description"/,
    /<script type="application\/ld\+json">/,
  ]) {
    assert.match(textHtml, expected);
  }
  assert.match(textHtml, /<meta itemprop="name"/);
  assert.match(textHtml, new RegExp(
    `rel="canonical" href="${baseUrl.replaceAll('.', '\\.')}/s/${experiment.shortCode}"`,
  ));
  assert.match(textHtml, new RegExp(
    `property="og:url" content="${baseUrl.replaceAll('.', '\\.')}/s/${experiment.shortCode}"`,
  ));
  assert.doesNotMatch(textHtml, /og:image|twitter:image|itemprop="image"|<img\b|wechat-share-default|rel="preload"/i);
  assert.doesNotMatch(textHtml, /display\s*:\s*none|opacity\s*:\s*0|position\s*:\s*(?:absolute|fixed)/i);
  assert.doesNotMatch(textHtml, /\/play|301|302|window\.location\.replace|继续打开|继续播放|<div id="app">/);
  assert.doesNotMatch(textHtml, /property="og:title"[^>]+第一行/);
  assert.equal(textHtml.includes('<script>alert(1)</script>'), false);
  assert.equal(textHtml.includes('<img src=x onerror=alert(1)>'), false);

  const playToken = textHtml.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  assert.equal(
    Buffer.from(playToken, 'base64url').toString('utf8'),
    `/play?fileId=test-${runId}&shortLinkId=${experiment.id}`,
  );
  const jsonText = textHtml.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  const jsonLd = JSON.parse(jsonText);
  assert.equal(jsonLd.name, title);
  assert.equal(jsonLd.description, description.replace(/\s+/gu, ' ').trim());
  assert.equal(jsonLd.url, `${baseUrl}/s/${experiment.shortCode}`);

  const cardResponse = await fetch(`${baseUrl}/card/${savedExperiment.card_token}`);
  const cardHtml = await cardResponse.text();
  assert.equal(cardResponse.status, 200);
  assert.doesNotMatch(cardHtml, /og:image|twitter:image|itemprop="image"|<img\b/i);
  assert.match(cardHtml, new RegExp(
    `rel="canonical" href="${baseUrl.replaceAll('.', '\\.')}/card/${savedExperiment.card_token}"`,
  ));

  const updateAttempt = await request(
    `/api/management/short-links/${experiment.id}/card`,
    {
      method: 'PUT',
      body: JSON.stringify({
        title,
        description: description.replace(/\s+/gu, ' ').trim(),
        wechatCardMode: 'standard',
      }),
    },
  );
  assert.equal(updateAttempt.response.status, 200);
  const [[modeAfterUpdate]] = await pool.execute(
    'SELECT wechat_card_mode FROM short_links WHERE id = ?',
    [experiment.id],
  );
  assert.equal(modeAfterUpdate.wechat_card_mode, 'text_description');

  const materials = await request('/api/management/materials');
  const listedMaterial = materials.payload.data.find(
    (item) => String(item.id) === String(videoId),
  );
  assert.equal(
    listedMaterial.short_links.find(
      (link) => String(link.id) === String(experiment.id),
    ).wechat_card_mode,
    'text_description',
  );

  const disabled = await request('/api/shortlink/toggle', {
    method: 'POST',
    body: JSON.stringify({ shortLinkId: experiment.id, enabled: false }),
  });
  assert.equal(disabled.response.status, 200);
  assert.equal((await fetch(`${baseUrl}/s/${experiment.shortCode}`)).status, 404);
  await pool.execute(
    `UPDATE short_links
     SET status = 'active', expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)
     WHERE id = ?`,
    [experiment.id],
  );
  assert.equal((await fetch(`${baseUrl}/s/${experiment.shortCode}`)).status, 410);
});

test('cloud deletion failure is retryable and repeated deletion is idempotent', async () => {
  const [result] = await pool.execute(
    `INSERT INTO videos (file_id, title, status, expires_at)
     VALUES (?, ?, 'ready', DATE_ADD(NOW(), INTERVAL 1 DAY))`,
    [`delete-${runId}`, `删除验收 ${runId}`],
  );
  const deleteVideoId = result.insertId;
  cleanupVideoIds.add(String(deleteVideoId));
  await pool.execute(
    `INSERT INTO play_logs
       (video_id, session_id, event_type, played_seconds)
     VALUES (?, ?, 'start', 0)`,
    [deleteVideoId, crypto.randomUUID()],
  );

  const originalDelete = vodService.deleteVideo;
  const timeoutError = new Error('cloud timeout');
  timeoutError.code = 'VOD_TIMEOUT';
  timeoutError.status = 503;
  vodService.deleteVideo = async () => {
    throw timeoutError;
  };

  try {
    const failed = await request(`/api/video/${deleteVideoId}`, { method: 'DELETE' });
    assert.equal(failed.response.status, 503);
    const [[afterFailure]] = await pool.execute(
      'SELECT status, delete_error IS NOT NULL AS has_error FROM videos WHERE id = ?',
      [deleteVideoId],
    );
    assert.equal(afterFailure.status, 'ready');
    assert.equal(Number(afterFailure.has_error), 1);

    vodService.deleteVideo = async () => ({ RequestId: 'mocked' });
    const deleted = await request(`/api/video/${deleteVideoId}`, { method: 'DELETE' });
    const repeated = await request(`/api/video/${deleteVideoId}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.payload.data.alreadyDeleted, true);

    const [[afterDelete]] = await pool.execute(
      `SELECT v.status, v.deleted_at IS NOT NULL AS has_deleted_at,
              v.delete_error IS NULL AS error_cleared,
              (SELECT COUNT(*) FROM play_logs WHERE video_id = v.id) AS audit_logs
       FROM videos v WHERE v.id = ?`,
      [deleteVideoId],
    );
    assert.equal(afterDelete.status, 'deleted');
    assert.equal(Number(afterDelete.has_deleted_at), 1);
    assert.equal(Number(afterDelete.error_cleared), 1);
    assert.equal(Number(afterDelete.audit_logs), 1);
  } finally {
    vodService.deleteVideo = originalDelete;
  }
});

test('expired video access returns HTTP 410 and expires related links', async () => {
  const [[beforeLogs]] = await pool.execute(
    'SELECT COUNT(*) AS count FROM play_logs WHERE video_id = ?',
    [videoId],
  );
  await pool.execute(
    `UPDATE videos SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE), status = 'ready'
     WHERE id = ?`,
    [videoId],
  );
  const gone = await request(`/api/video/access?fileId=test-${runId}`);
  assert.equal(gone.response.status, 410);
  assert.equal(gone.payload.code, 'VIDEO_EXPIRED');

  const [[mismatch]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM short_links
     WHERE video_id = ? AND status <> 'expired'`,
    [videoId],
  );
  assert.equal(Number(mismatch.count), 0);
  const [[afterLogs]] = await pool.execute(
    'SELECT COUNT(*) AS count FROM play_logs WHERE video_id = ?',
    [videoId],
  );
  assert.equal(Number(afterLogs.count), Number(beforeLogs.count));
});

test('generate short link rejects an expired video before calling the provider', async () => {
  const [result] = await pool.execute(
    `INSERT INTO videos (file_id, title, status, expires_at)
     VALUES (?, ?, 'ready', DATE_SUB(NOW(), INTERVAL 1 MINUTE))`,
    [`expired-generate-${runId}`, `过期生成拦截 ${runId}`],
  );
  const expiredVideoId = result.insertId;
  cleanupVideoIds.add(String(expiredVideoId));

  const originalCreate = suolinkService.createShortLink;
  let providerCalled = false;
  suolinkService.createShortLink = async () => {
    providerCalled = true;
    throw new Error('provider should not be reached for an expired video');
  };
  try {
    const gone = await request('/api/shortlink/generate', {
      method: 'POST',
      body: JSON.stringify({ videoId: expiredVideoId, platform: 'suolink' }),
    });
    assert.equal(gone.response.status, 410);
    assert.equal(gone.payload.code, 'VIDEO_NOT_AVAILABLE');
    assert.equal(providerCalled, false);
  } finally {
    suolinkService.createShortLink = originalCreate;
  }
});

test('player signature expiration never exceeds the video expiration', () => {
  const maximum = Math.floor(Date.now() / 1000) + 120;
  const token = vodService.createPlayerSignature(
    '123456789',
    new Date(maximum * 1000),
    'Abcd1234Efgh5678',
  );
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.appId, Number(process.env.TENCENT_APP_ID));
  assert.ok(payload.expireTimeStamp <= maximum);
});
