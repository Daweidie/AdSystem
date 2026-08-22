const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHORT_URL = 'http://localhost:3001/api/short/mwCrG5';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  try {
    const adminContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const admin = await adminContext.newPage();
    await admin.goto('http://localhost:5173/admin', { waitUntil: 'networkidle', timeout: 60_000 });
    await admin.getByRole('tab', { name: '短链管理' }).click();
    const shortRow = admin.locator('.el-table__body tr').filter({ hasText: 'mwCrG5' }).last();
    await shortRow.waitFor({ state: 'visible', timeout: 15_000 });
    await admin.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-07-before-redirect.png', fullPage: true });
    console.log('BEFORE_ROW', (await shortRow.innerText()).replace(/\s+/g, ' ').trim());

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 AcceptanceE2E/1.0',
    });
    const page = await mobileContext.newPage();
    const hops = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/short/mwCrG5') || response.url().includes('/api/video/5001834815472845728')) {
        hops.push({ status: response.status(), url: response.url(), location: response.headers().location || null });
      }
    });
    const finalResponse = await page.goto(SHORT_URL, {
      referer: 'http://localhost:5173/admin',
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-07-after-redirect.png', fullPage: true });
    console.log('HOPS', JSON.stringify(hops));
    console.log('FINAL_STATUS', finalResponse?.status());
    console.log('FINAL_URL', page.url());
    console.log('FINAL_BODY', (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim());
    await adminContext.close();
    await mobileContext.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
