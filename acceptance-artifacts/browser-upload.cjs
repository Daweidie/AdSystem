const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ADMIN_URL = 'http://localhost:5173/admin';
const VIDEO_PATH = 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/AT_E2E_20260811.mp4';
const SCREENSHOT_DIR = 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts';

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: false,
  });
  const page = await context.newPage();
  const network = [];
  const consoleMessages = [];

  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    const url = response.url();
    if (
      url.includes('/api/') ||
      url.includes('vod-js-sdk') ||
      url.includes('vod2.qcloud') ||
      url.includes('myqcloud') ||
      url.includes('suolink')
    ) {
      network.push({ method: response.request().method(), status: response.status(), url: safeUrl(url) });
    }
  });

  await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/scenario-02-video-list-before.png`, fullPage: true });
  const beforeText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  console.log('BEFORE_TEXT', beforeText.slice(0, 2500));
  console.log('TITLE_INPUT_COUNT', await page.locator('input:not([type=file])').count());
  console.log('DELETE_BUTTON_COUNT', await page.getByRole('button', { name: /删除/ }).count());

  const fileInput = page.locator('input[type=file]');
  await fileInput.setInputFiles(VIDEO_PATH);

  const outcome = await Promise.race([
    page.locator('.el-message--success').filter({ hasText: /上传成功/ }).first().waitFor({ state: 'visible', timeout: 240_000 }).then(() => 'success'),
    page.locator('.el-message--error').first().waitFor({ state: 'visible', timeout: 240_000 }).then(() => 'error'),
  ]).catch((error) => `timeout: ${error.message}`);

  const messageTexts = await page.locator('.el-message').allInnerTexts().catch(() => []);
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/scenario-01-upload-result.png`, fullPage: true });
  const afterText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  const matchingRows = await page.locator('.el-table__body tr').filter({ hasText: 'AT_E2E_20260811.mp4' }).allInnerTexts();

  console.log('UPLOAD_OUTCOME', outcome);
  console.log('MESSAGE_TEXTS', JSON.stringify(messageTexts));
  console.log('MATCHING_ROWS', JSON.stringify(matchingRows));
  console.log('AFTER_TEXT', afterText.slice(0, 3500));
  console.log('NETWORK', JSON.stringify(network, null, 2));
  console.log('CONSOLE', JSON.stringify(consoleMessages, null, 2));

  await browser.close();
})().catch((error) => {
  console.error('FATAL', error);
  process.exitCode = 1;
});
