const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle', timeout: 60_000 });
    const videoDeleteButtons = await page.getByRole('button', { name: /删除/ }).count();
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-11-delete-unavailable.png', fullPage: true });

    await page.getByRole('tab', { name: '短链管理' }).click();
    const row = page.locator('.el-table__body tr').filter({ hasText: 'ZZ9S80' }).last();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    const shortHeaders = await page.locator('.el-tab-pane').last().locator('.el-table__header-wrapper th').allInnerTexts();
    await row.getByRole('button', { name: '复制链接', exact: true }).click();
    await page.getByText(/短链接已复制/).waitFor({ state: 'visible', timeout: 15_000 });
    const statsPromise = page.waitForResponse((r) => /\/api\/shortlink\/\d+\/stats$/.test(r.url()));
    await row.getByRole('button', { name: '查看统计', exact: true }).click();
    const statsResponse = await statsPromise;
    const statsPayload = await statsResponse.json();
    await page.getByRole('dialog', { name: '短链访问统计' }).waitFor({ state: 'visible' });
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-12-shortlink-list.png', fullPage: true });
    const dialogText = (await page.getByRole('dialog', { name: '短链访问统计' }).innerText()).replace(/\s+/g, ' ').trim();
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: '视频管理' }).click();
    const addButtons = await page.getByRole('button', { name: /添加域名|新增域名/ }).count();
    const domainDeleteButtons = await page.getByRole('button', { name: /删除域名/ }).count();
    await page.locator('.domain-select').click();
    const domainOptions = await page.locator('.el-select-dropdown__item').allInnerTexts();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-13-domain-management.png', fullPage: true });

    console.log('VIDEO_DELETE_BUTTONS', videoDeleteButtons);
    console.log('SHORTLINK_HEADERS', JSON.stringify(shortHeaders.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)));
    console.log('SHORTLINK_ROW', (await row.innerText()).replace(/\s+/g, ' ').trim());
    console.log('COPY_SUPPORTED', true);
    console.log('STATS_HTTP', statsResponse.status());
    console.log('STATS_PAYLOAD', JSON.stringify(statsPayload));
    console.log('STATS_DIALOG', dialogText);
    console.log('DOMAIN_OPTIONS', JSON.stringify(domainOptions));
    console.log('DOMAIN_ADD_BUTTONS', addButtons);
    console.log('DOMAIN_DELETE_BUTTONS', domainDeleteButtons);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
