const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const responses = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/video/')) {
        responses.push({ status: response.status(), url: response.url().split('?')[0] });
      }
    });
    const navigation = await page.goto('http://localhost:5173/play?fileId=5001834815472845728', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.getByText(/视频已过期/).waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({
      path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-04-expired.png',
      fullPage: true,
    });
    console.log('NAVIGATION_STATUS', navigation?.status());
    console.log('BODY_TEXT', (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim());
    console.log('API_RESPONSES', JSON.stringify(responses));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
