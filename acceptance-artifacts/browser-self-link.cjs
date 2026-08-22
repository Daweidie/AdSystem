const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.locator('.domain-select').click();
    const switchPromise = page.waitForResponse((r) => r.url().endsWith('/api/domain/switch') && r.request().method() === 'POST');
    await page.locator('.el-select-dropdown__item').filter({ hasText: 'http://localhost:3001/api/short' }).click();
    const switchResponse = await switchPromise;
    await page.getByText(/主域名已切换/).waitFor({ state: 'visible', timeout: 15_000 });

    const videoRow = page.locator('.el-table__body tr').filter({ hasText: 'AT_E2E_20260811.mp4' }).first();
    const generatePromise = page.waitForResponse((r) => r.url().endsWith('/api/shortlink/generate') && r.request().method() === 'POST');
    await videoRow.getByRole('button', { name: '生成短链', exact: true }).click();
    const generateResponse = await generatePromise;
    const payload = await generateResponse.json();
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-06-self-link.png', fullPage: true });

    console.log('SWITCH_HTTP', switchResponse.status());
    console.log('GENERATE_HTTP', generateResponse.status());
    console.log('GENERATE_PAYLOAD', JSON.stringify(payload));
    console.log('SHORT_CODE_LENGTH', payload?.data?.shortCode?.length ?? null);
    console.log('MESSAGES', JSON.stringify(await page.locator('.el-message').allInnerTexts()));
    console.log('SELECTED_DOMAIN', await page.locator('.domain-select').innerText());
    console.log('ROW', (await videoRow.innerText()).replace(/\s+/g, ' ').trim());
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
