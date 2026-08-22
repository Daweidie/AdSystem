const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

const SHORT_URL = 'http://127.0.0.1:3001/api/short/ZZ9S80';

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.getByRole('tab', { name: '短链管理' }).click();

    let row = page.locator('.el-table__body tr').filter({ hasText: 'ZZ9S80' }).last();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    const disablePromise = page.waitForResponse((r) => r.url().endsWith('/api/shortlink/toggle') && r.request().method() === 'POST');
    await row.getByRole('button', { name: '停用', exact: true }).click();
    await page.locator('.el-message-box').getByRole('button', { name: '停用', exact: true }).click();
    const disableResponse = await disablePromise;
    const disablePayload = await disableResponse.json();
    await page.getByText('短链接已停用', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    row = page.locator('.el-table__body tr').filter({ hasText: 'ZZ9S80' }).last();
    await row.getByText('已停用', { exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-10-disabled.png', fullPage: true });
    const disabledVisit = await fetch(SHORT_URL, { redirect: 'manual' });
    const disabledBody = await disabledVisit.text();

    const enablePromise = page.waitForResponse((r) => r.url().endsWith('/api/shortlink/toggle') && r.request().method() === 'POST');
    await row.getByRole('button', { name: '启用', exact: true }).click();
    const enableResponse = await enablePromise;
    const enablePayload = await enableResponse.json();
    await page.getByText('短链接已启用', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    row = page.locator('.el-table__body tr').filter({ hasText: 'ZZ9S80' }).last();
    await row.getByText('有效', { exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-10-enabled.png', fullPage: true });
    const enabledVisit = await fetch(SHORT_URL, { redirect: 'manual' });

    console.log('DISABLE_HTTP', disableResponse.status());
    console.log('DISABLE_PAYLOAD', JSON.stringify(disablePayload));
    console.log('DISABLED_VISIT_HTTP', disabledVisit.status);
    console.log('DISABLED_VISIT_BODY', disabledBody);
    console.log('ENABLE_HTTP', enableResponse.status());
    console.log('ENABLE_PAYLOAD', JSON.stringify(enablePayload));
    console.log('ENABLED_VISIT_HTTP', enabledVisit.status);
    console.log('ENABLED_VISIT_LOCATION', enabledVisit.headers.get('location'));
    console.log('FINAL_ROW', (await row.innerText()).replace(/\s+/g, ' ').trim());
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
