const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { chromium } = require('playwright-core');

const edgePath = process.env.PLAYWRIGHT_EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:5173';
const apiBaseUrl = (process.env.E2E_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const backendRoot = path.resolve(__dirname, '../../backend');
let fixturePool;

function getFixturePool() {
  if (!fixturePool) {
    require(path.join(backendRoot, 'node_modules/dotenv')).config({
      path: path.join(backendRoot, '.env'),
    });
    fixturePool = require(path.join(backendRoot, 'src/config/db'));
  }
  return fixturePool;
}

async function installTcPlayerStub(page) {
  await page.route('https://web.sdk.qcloud.com/player/tcplayer/release/v4.5.4/tcplayer.v4.5.4.min.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `window.TCPlayer=function(id,options){
      window.__demo18TestPlayerInitCount=(window.__demo18TestPlayerInitCount||0)+1;
      const instance={
        on(name,handler){
          if(name==='playing') setTimeout(()=>handler({type:'playing'}),20);
          if(name==='timeupdate') setTimeout(()=>handler({type:'timeupdate'}),40);
        },
        currentTime(){return 12;},
        dispose(){}
      };
      window.__demo18TestPlayer={id,options};
      return instance;
    };`,
  }));
  await page.route('https://web.sdk.qcloud.com/player/tcplayer/release/v4.5.4/tcplayer.min.css', (route) => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '.tcplayer-video{display:block}',
  }));
}

function isPlaybackEvent(request, eventType) {
  if (request.method() !== 'POST' || !/\/api\/video\/\d+\/events$/.test(new URL(request.url()).pathname)) {
    return false;
  }
  try {
    return request.postDataJSON()?.eventType === eventType;
  } catch {
    return false;
  }
}

async function login(page, phone) {
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByPlaceholder('请输入登录手机号').fill(phone);
  await page.getByPlaceholder('请输入登录密码').fill('Demo123!');
  await page.getByRole('button', { name: '登录系统' }).click();
  await page.waitForURL('**/admin', { timeout: 30000 });
  await page.getByText('今日工作台').waitFor({ state: 'visible' });
}

(async () => {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(await page.title(), '视频广告资源管理系统');
    assert.equal(await page.getByText('TENCENT CLOUD VOD', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/演示账号/).count(), 0);
    assert.equal(await page.getByPlaceholder('请输入登录手机号').inputValue(), '');
    assert.equal(await page.getByPlaceholder('请输入登录密码').inputValue(), '');
    await login(page, '13800000001');

    for (const label of ['素材资源管理', '推广员管理', '系统管理员']) {
      assert.equal(await page.getByRole('heading', { name: new RegExp(label) }).count(), 1);
    }
    for (const label of ['我的素材列表', '素材组管理', '上传素材', '推广员列表', '业务组列表', '管理员列表']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 1, `missing menu: ${label}`);
    }

    await page.getByRole('button', { name: '我的素材列表', exact: true }).click();
    await page.locator('.material-card').first().waitFor({ state: 'visible' });
    const firstMaterialTitle = await page.locator('.material-card h3').first().innerText();
    await page.locator('.material-card').first().getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: '编辑素材' }).count(), 1);
    assert.equal(await page.getByRole('dialog', { name: '编辑素材' }).getByPlaceholder('请输入素材名称').inputValue(), firstMaterialTitle);
    await page.getByRole('dialog', { name: '编辑素材' }).getByRole('button', { name: '取消' }).click();
    await page.locator('.material-card').first().getByRole('button', { name: '推广链接' }).click();
    assert.ok(await page.locator('.link-panel').first().isVisible());
    assert.equal(await page.locator('.link-panel').first().getByRole('button', { name: '＋ 生成自建 /s/ 链接', exact: true }).count(), 1);
    assert.equal(await page.locator('.link-panel').first().getByRole('button', { name: '＋ 生成 Suolink 链接', exact: true }).count(), 1);
    const experimentMaterialCard = page.locator('.material-card').filter({
      has: page.locator('.status-pill.ready'),
    }).first();
    const experimentMaterialTitle = await experimentMaterialCard.getByRole('heading').innerText();
    if (!(await experimentMaterialCard.locator('.link-panel').isVisible())) {
      await experimentMaterialCard.getByRole('button', { name: '推广链接', exact: true }).click();
    }
    const firstLinkPanel = experimentMaterialCard.locator('.link-panel');
    const modeSelector = firstLinkPanel.getByRole('radiogroup', { name: '微信卡片模式' });
    assert.equal(await modeSelector.getByLabel('标准图文卡片').isChecked(), true);
    await modeSelector.getByLabel('纯文字简介实验').check();
    assert.equal(await modeSelector.getByLabel('纯文字简介实验').isChecked(), true);
    assert.equal(
      await firstLinkPanel.getByText(/系统不能保证一定显示简介.*必须生成全新短码测试/).count(),
      1,
    );
    const experimentResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/api/shortlink/self-create'));
    await firstLinkPanel.getByRole('button', { name: '生成全新实验短链', exact: true }).click();
    const experimentCreateResponse = await experimentResponsePromise;
    assert.equal(experimentCreateResponse.status(), 201);
    const experimentCreatePayload = await experimentCreateResponse.json();
    const experimentalLink = {
      ...experimentCreatePayload.data,
      materialTitle: experimentMaterialTitle,
    };
    assert.equal(experimentalLink.wechatCardMode, 'text_description');
    assert.match(experimentalLink.shortUrl, /\/s\/[A-Za-z0-9]{6,8}$/);
    await page.getByText(/全新纯文字实验短链已生成/).waitFor({ state: 'visible' });
    assert.ok(await page.getByRole('button', { name: '复制链接' }).count() >= 1);

    const directLink = await page.evaluate(async (base) => {
      const token = localStorage.getItem('demo18_token') || '';
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      const materialsResponse = await fetch(`${base}/management/materials`, { headers });
      const materialsPayload = await materialsResponse.json();
      const material = materialsPayload.data.find((item) => item.status === 'ready');
      if (!material) throw new Error('No ready material for direct-link test');
      const createResponse = await fetch(`${base}/shortlink/self-create`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: material.id }),
      });
      const createPayload = await createResponse.json();
      if (!createResponse.ok) throw new Error(createPayload.message || 'Could not create direct link');
      return { ...createPayload.data, materialId: material.id, materialTitle: material.title };
    }, apiBaseUrl);
    const backendOrigin = 'http://localhost:3001';
    const cardToken = crypto.randomBytes(32).toString('base64url');
    const suolinkShortCode = crypto.randomBytes(4).toString('hex');
    const suolinkShortUrl = `https://w1.hotwharf.com/${crypto.randomBytes(5).toString('hex')}`;
    const pool = getFixturePool();
    const [suolinkInsert] = await pool.execute(
      `INSERT INTO short_links
         (video_id, domain_id, platform, short_code, long_url, short_url,
          card_token, card_title, card_description, card_cover_url, card_status,
          status, expires_at, clicks, created_at)
       SELECT video_id, domain_id, 'suolink', ?, ?, ?, ?, ?, ?, card_cover_url,
              'ready', 'active', expires_at, 0, UTC_TIMESTAMP()
       FROM short_links
       WHERE id = ?`,
      [
        suolinkShortCode,
        `${backendOrigin}/card/${cardToken}`,
        suolinkShortUrl,
        cardToken,
        directLink.materialTitle,
        'Suolink E2E 卡片',
        directLink.id,
      ],
    );
    const suolinkLinkId = suolinkInsert.insertId;
    const directLinkPage = await browser.newPage();
    const experimentalLinkPage = await browser.newPage();
    const cardLinkPage = await browser.newPage();
    const ordinaryPlayPage = await browser.newPage();
    try {
      await installTcPlayerStub(experimentalLinkPage);
      const experimentPlaybackEvents = [];
      experimentalLinkPage.on('request', (request) => {
        if (isPlaybackEvent(request, 'start')) {
          experimentPlaybackEvents.push(request.postDataJSON());
        }
      });
      const experimentPlayRequest = experimentalLinkPage.waitForRequest(
        (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/play',
        { timeout: 30000 },
      );
      await experimentalLinkPage.goto(
        `${backendOrigin}/s/${experimentalLink.shortCode}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 },
      );
      assert.equal(
        new URL((await experimentPlayRequest).url()).searchParams.get('shortLinkId'),
        String(experimentalLink.id),
      );
      await experimentalLinkPage.waitForFunction(
        () => document.documentElement.dataset.demo18PlayerInitialized === 'true',
        null,
        { timeout: 30000 },
      );
      assert.equal(new URL(experimentalLinkPage.url()).pathname, `/s/${experimentalLink.shortCode}`);
      assert.equal(new URL(experimentalLinkPage.url()).search, '');
      assert.equal(
        await experimentalLinkPage.evaluate(() => window.__demo18TestPlayerInitCount),
        1,
      );
      await experimentalLinkPage.waitForFunction(
        () => performance.getEntriesByType('resource').some((entry) => /\/events$/.test(new URL(entry.name).pathname)),
        null,
        { timeout: 30000 },
      );
      await experimentalLinkPage.waitForTimeout(100);
      assert.equal(experimentPlaybackEvents[0]?.shortLinkId, String(experimentalLink.id));

      await installTcPlayerStub(directLinkPage);
      let selfPlayRequestCount = 0;
      const selfPlaybackEvents = [];
      const directDiagnostics = [];
      directLinkPage.on('console', (message) => directDiagnostics.push(`console:${message.type()}:${message.text()}`));
      directLinkPage.on('pageerror', (error) => directDiagnostics.push(`pageerror:${error.message}`));
      directLinkPage.on('requestfailed', (request) => directDiagnostics.push(
        `requestfailed:${request.url()}:${request.failure()?.errorText || ''}`,
      ));
      directLinkPage.on('request', (request) => {
        if (request.method() === 'GET' && new URL(request.url()).pathname === '/play') {
          selfPlayRequestCount += 1;
        }
        if (isPlaybackEvent(request, 'start') || isPlaybackEvent(request, 'progress')) {
          selfPlaybackEvents.push(request.postDataJSON());
        }
      });
      const selfPlayRequest = directLinkPage.waitForRequest(
        (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/play',
        { timeout: 30000 },
      );
      await directLinkPage.goto(
        `${backendOrigin}/s/${directLink.shortCode}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 },
      );
      const observedPlayRequest = new URL((await selfPlayRequest).url());
      assert.ok(observedPlayRequest.searchParams.get('fileId'));
      assert.equal(observedPlayRequest.searchParams.get('shortLinkId'), String(directLink.id));
      try {
        await directLinkPage.waitForFunction(
          () => document.documentElement.dataset.demo18PlayerInitialized === 'true',
          null,
          { timeout: 30000 },
        );
      } catch (error) {
        throw new Error(JSON.stringify({
          message: error.message,
          url: directLinkPage.url(),
          body: (await directLinkPage.locator('body').innerText()).slice(0, 1000),
          diagnostics: directDiagnostics.slice(-20),
        }));
      }
      assert.equal(new URL(directLinkPage.url()).pathname, `/s/${directLink.shortCode}`);
      assert.equal(new URL(directLinkPage.url()).search, '');
      assert.equal(await directLinkPage.getByText(/继续播放|继续打开/).count(), 0);
      const playerOptions = await directLinkPage.evaluate(() => window.__demo18TestPlayer?.options);
      assert.equal(playerOptions.autoplay, true);
      assert.equal(playerOptions.controls, true);
      await directLinkPage.waitForFunction(
        () => performance.getEntriesByType('resource').some((entry) => /\/events$/.test(new URL(entry.name).pathname)),
        null,
        { timeout: 30000 },
      );
      await directLinkPage.waitForTimeout(100);
      assert.equal(
        selfPlaybackEvents.find((event) => event.eventType === 'start')?.shortLinkId,
        String(directLink.id),
      );
      assert.equal(
        selfPlaybackEvents.find((event) => event.eventType === 'progress')?.shortLinkId,
        String(directLink.id),
      );

      const refreshedPlayRequest = directLinkPage.waitForRequest(
        (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/play',
        { timeout: 30000 },
      );
      await directLinkPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await refreshedPlayRequest;
      await directLinkPage.waitForFunction(
        () => document.documentElement.dataset.demo18PlayerInitialized === 'true',
        null,
        { timeout: 30000 },
      );
      await directLinkPage.waitForTimeout(500);
      assert.equal(new URL(directLinkPage.url()).pathname, `/s/${directLink.shortCode}`);
      assert.equal(selfPlayRequestCount, 2, 'refresh must cause exactly one new card-to-play navigation');

      const fileId = new URL(directLink.longUrl).searchParams.get('fileId');
      assert.ok(fileId);
      await installTcPlayerStub(ordinaryPlayPage);
      await ordinaryPlayPage.goto(
        `${backendOrigin}/play?fileId=${encodeURIComponent(fileId)}&sharePath=${encodeURIComponent('https://evil.example/card/attack')}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 },
      );
      await ordinaryPlayPage.waitForFunction(
        () => document.documentElement.dataset.demo18PlayerInitialized === 'true',
        null,
        { timeout: 30000 },
      );
      assert.equal(new URL(ordinaryPlayPage.url()).pathname, '/play');
      assert.equal(await ordinaryPlayPage.locator('meta[name="demo18-share-path"]').count(), 0);

      await installTcPlayerStub(cardLinkPage);
      const cardPlaybackEvents = [];
      cardLinkPage.on('request', (request) => {
        if (isPlaybackEvent(request, 'start')) cardPlaybackEvents.push(request.postDataJSON());
      });
      const cardPlayRequest = cardLinkPage.waitForRequest(
        (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/play',
        { timeout: 30000 },
      );
      await cardLinkPage.goto(
        `${backendOrigin}/card/${cardToken}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 },
      );
      assert.equal(
        new URL((await cardPlayRequest).url()).searchParams.get('shortLinkId'),
        String(suolinkLinkId),
      );
      await cardLinkPage.waitForFunction(
        () => document.documentElement.dataset.demo18PlayerInitialized === 'true',
        null,
        { timeout: 30000 },
      );
      assert.equal(new URL(cardLinkPage.url()).pathname, `/card/${cardToken}`);
      await cardLinkPage.waitForFunction(
        () => performance.getEntriesByType('resource').some((entry) => /\/events$/.test(new URL(entry.name).pathname)),
        null,
        { timeout: 30000 },
      );
      assert.equal(cardPlaybackEvents[0]?.shortLinkId, String(suolinkLinkId));

      await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.getByRole('button', { name: '我的素材列表', exact: true }).click();
      const fixtureMaterial = page.locator('.material-card').filter({ hasText: directLink.materialTitle }).first();
      await fixtureMaterial.waitFor({ state: 'visible' });
      await fixtureMaterial.getByRole('button', { name: '推广链接', exact: true }).click();

      const selfLinkRow = fixtureMaterial.locator('.link-row').filter({ hasText: directLink.shortUrl });
      await selfLinkRow.getByRole('button', { name: '微信分享', exact: true }).click();
      const selfShareDialog = page.getByRole('dialog', { name: '微信分享' });
      const selfQr = selfShareDialog.getByRole('img', { name: '微信分享二维码' });
      assert.match(await selfQr.getAttribute('src'), /^data:image\/png;base64,/);
      assert.equal(await selfQr.getAttribute('data-qr-value'), directLink.shortUrl);
      assert.doesNotMatch(await selfQr.getAttribute('data-qr-value'), /\/play|fileId|shortLinkId/);
      await selfShareDialog.locator('.el-dialog__headerbtn').click();

      const experimentalMaterial = page.locator('.material-card').filter({ hasText: experimentalLink.materialTitle }).first();
      await experimentalMaterial.waitFor({ state: 'visible' });
      if (!(await experimentalMaterial.locator('.link-panel').isVisible())) {
        await experimentalMaterial.getByRole('button', { name: '推广链接', exact: true }).click();
      }
      const experimentLinkRow = experimentalMaterial.locator('.link-row').filter({ hasText: experimentalLink.shortUrl });
      assert.equal(await experimentLinkRow.getByText('纯文字实验', { exact: true }).count(), 1);
      await experimentLinkRow.getByRole('button', { name: '微信分享', exact: true }).click();
      const experimentShareDialog = page.getByRole('dialog', { name: '微信分享' });
      const experimentQr = experimentShareDialog.getByRole('img', { name: '微信分享二维码' });
      assert.equal(await experimentQr.getAttribute('data-qr-value'), experimentalLink.shortUrl);
      assert.doesNotMatch(await experimentQr.getAttribute('data-qr-value'), /\/play|fileId|shortLinkId/);
      assert.equal(await experimentShareDialog.getByText(/纯文字简介实验不会输出封面/).count(), 1);
      await experimentShareDialog.locator('.el-dialog__headerbtn').click();

      await experimentLinkRow.getByRole('button', { name: '设置卡片', exact: true }).click();
      const experimentCardDialog = page.getByRole('dialog', { name: '微信卡片设置' });
      assert.equal(await experimentCardDialog.getByText('纯文字简介实验', { exact: true }).count(), 1);
      assert.equal(await experimentCardDialog.locator('input[type="file"]').count(), 0);
      await experimentCardDialog.getByRole('button', { name: '取消' }).click();

      const suolinkRow = fixtureMaterial.locator('.link-row').filter({ hasText: suolinkShortUrl });
      await suolinkRow.getByRole('button', { name: '微信分享', exact: true }).click();
      const suolinkShareDialog = page.getByRole('dialog', { name: '微信分享' });
      const suolinkQr = suolinkShareDialog.getByRole('img', { name: '微信分享二维码' });
      assert.equal(await suolinkQr.getAttribute('data-qr-value'), suolinkShortUrl);
      assert.equal(await suolinkShareDialog.getByText(/播放页只能恢复同源 \/card 地址/).count(), 1);
      await suolinkShareDialog.locator('.el-dialog__headerbtn').click();

      await selfLinkRow.getByRole('button', { name: '设置卡片', exact: true }).click();
      const shareCardDialog = page.getByRole('dialog', { name: '微信卡片设置' });
      assert.equal(await shareCardDialog.count(), 1);
      assert.equal(await shareCardDialog.getByText('效果预览', { exact: true }).count(), 1);
      assert.equal(await shareCardDialog.getByRole('button', { name: '保存并复制卡片链接' }).count(), 1);
      await shareCardDialog.locator('input[type="file"]').setInputFiles({
        name: 'card-cover.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      });
      assert.equal(await shareCardDialog.getByText('重新选择', { exact: true }).count(), 1);
      assert.match(await shareCardDialog.locator('.share-cover-preview img').getAttribute('src'), /^blob:/);
      await shareCardDialog.getByRole('button', { name: '取消' }).click();
    } finally {
      await directLinkPage.close();
      await experimentalLinkPage.close();
      await cardLinkPage.close();
      await ordinaryPlayPage.close();
      await pool.execute('DELETE FROM play_logs WHERE short_link_id = ?', [suolinkLinkId]);
      await pool.execute('DELETE FROM short_links WHERE id = ?', [suolinkLinkId]);
      await page.evaluate(async ({ base, linkId }) => {
        await fetch(`${base}/shortlink/${linkId}`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${localStorage.getItem('demo18_token') || ''}`,
          },
        });
      }, { base: apiBaseUrl, linkId: directLink.id });
      await page.evaluate(async ({ base, linkId }) => {
        await fetch(`${base}/shortlink/${linkId}`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${localStorage.getItem('demo18_token') || ''}`,
          },
        });
      }, { base: apiBaseUrl, linkId: experimentalLink.id });
    }

    await page.getByRole('button', { name: '域名池管理', exact: true }).click();
    assert.equal(await page.getByText('Suolink 第三方缩链', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '保存缩链设置', exact: true }).count(), 1);
    for (const domain of ['iq1k.cn', 'm6z.cn', 'i6q.cn']) {
      assert.equal(await page.getByRole('button', { name: domain, exact: true }).count(), 1);
    }
    assert.equal(await page.getByText('微信链接卡片（Open Graph）', { exact: true }).count(), 1);
    assert.equal(await page.getByText('工作方式', { exact: true }).count(), 1);
    assert.equal(await page.getByText(/无需再次点击“继续播放”/).count(), 1);
    assert.equal(await page.getByText(/JS接口安全域名/).count(), 0);
    assert.equal(await page.getByText(/公众号 IP 白名单/).count(), 0);
    assert.equal(await page.getByRole('button', { name: '保存微信设置', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '一键检测', exact: true }).count(), 1);

    await page.getByRole('button', { name: '上传素材', exact: true }).first().click();
    assert.equal(await page.getByText('归属与授权', { exact: true }).count(), 1);
    assert.equal(await page.getByText('选择视频文件', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '保存素材', exact: true }).count(), 1);

    await page.getByRole('button', { name: '退出', exact: true }).click();
    await login(page, '13800000002');
    assert.equal(await page.getByRole('button', { name: '域名池管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: /系统设置/ }).count(), 0);

    await page.getByRole('button', { name: '退出', exact: true }).click();
    await login(page, '13800000003');
    assert.equal(await page.locator('.metric-card').filter({ hasText: /^业务组/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '添加推广员', exact: true }).count(), 0);
    assert.equal(await page.locator('.permission-note').count(), 0);
    await page.getByRole('button', { name: '推广员列表', exact: true }).click();
    assert.equal(await page.locator('.data-table th').filter({ hasText: /^操作$/ }).count(), 0);
    assert.equal(await page.locator('.data-table .table-actions').count(), 0);

    await page.getByRole('button', { name: '退出', exact: true }).click();
    await login(page, '13800000004');
    assert.equal(await page.getByRole('button', { name: '素材组管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '上传素材', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: /系统管理员/ }).count(), 0);
    assert.equal(await page.getByText('一般用户').count() > 0, true);

    const apiVideo = await (await fetch(`${apiBaseUrl}/video/5001834815472845728`)).json();
    assert.equal(apiVideo.success, true);
    const playPage = await browser.newPage();
    await installTcPlayerStub(playPage);
    const navigation = await playPage.goto(
      `${baseUrl}/play?fileId=5001834815472845728`,
      { waitUntil: 'domcontentloaded', timeout: 60000 },
    );
    assert.equal(navigation.status(), 200);
    await playPage.waitForFunction(() => {
      return document.documentElement.dataset.demo18PlayerInitialized === 'true';
    }, null, { timeout: 30000 });

    console.log(JSON.stringify({
      success: true,
      superAdminMenusVerified: true,
      systemAdminDomainRestrictionVerified: true,
      businessManagerReadOnlyVerified: true,
      generalUserRestrictionsVerified: true,
      serverOpenGraphModeVerified: true,
      directShortLinkVerified: true,
      textDescriptionSelectionVerified: true,
      textDescriptionFreshLinkVerified: true,
      textDescriptionAddressRestoreVerified: true,
      textDescriptionSinglePlayerVerified: true,
      selfAddressRestoreVerified: true,
      suolinkCardAddressRestoreVerified: true,
      playbackEventShortLinkVerified: true,
      wechatQrShortUrlVerified: true,
      materialTitle: firstMaterialTitle,
      publicPlaybackVerified: true,
    }));
  } finally {
    await browser.close();
    if (fixturePool) await fixturePool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
