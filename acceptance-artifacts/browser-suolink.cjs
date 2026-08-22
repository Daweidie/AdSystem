const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const consoleMessages = [];
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) consoleMessages.push(`${m.type()}: ${m.text()}`);
    });
    await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle', timeout: 60_000 });

    await page.locator('.domain-select').click();
    const domainResponsePromise = page.waitForResponse((r) => r.url().endsWith('/api/domain/switch') && r.request().method() === 'POST');
    await page.locator('.el-select-dropdown__item').filter({ hasText: 'your_short_domain.com' }).click();
    const domainResponse = await domainResponsePromise;
    const domainPayload = await domainResponse.json();
    await page.getByText(/主域名已切换/).waitFor({ state: 'visible', timeout: 15_000 });

    const videoRow = page.locator('.el-table__body tr').filter({ hasText: 'AT_E2E_20260811.mp4' }).first();
    const generateResponsePromise = page.waitForResponse((r) => r.url().endsWith('/api/shortlink/generate') && r.request().method() === 'POST', { timeout: 60_000 });
    await videoRow.getByRole('button', { name: '生成短链', exact: true }).click();
    const generateResponse = await generateResponsePromise;
    const generatePayload = await generateResponse.json();
    await page.waitForTimeout(1_000);
    const messages = await page.locator('.el-message').allInnerTexts();
    await page.screenshot({
      path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-05-suolink.png',
      fullPage: true,
    });

    console.log('DOMAIN_SWITCH_HTTP', domainResponse.status());
    console.log('DOMAIN_SWITCH', JSON.stringify(domainPayload));
    console.log('GENERATE_HTTP', generateResponse.status());
    console.log('GENERATE_PAYLOAD', JSON.stringify(generatePayload));
    console.log('MESSAGES', JSON.stringify(messages));
    console.log('SELECTED_DOMAIN_TEXT', await page.locator('.domain-select').innerText());
    console.log('VIDEO_ROW', (await videoRow.innerText()).replace(/\s+/g, ' ').trim());
    console.log('CONSOLE', JSON.stringify(consoleMessages));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
