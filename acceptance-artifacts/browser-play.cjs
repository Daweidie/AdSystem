const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PLAY_URL = 'http://localhost:5173/play?fileId=5001834815472845728';
const SCREENSHOT = 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-03-play.png';

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

let browser;

(async () => {
  browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const network = [];
  const errors = [];

  page.on('response', (response) => {
    const type = response.request().resourceType();
    const url = response.url();
    if (url.includes('/api/') || url.includes('tcplayer') || type === 'media') {
      network.push({ type, status: response.status(), url: safeUrl(url) });
    }
  });
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  const navigation = await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('#tcplayer-video');
    return Boolean(window.TCPlayer && video && video.readyState >= 1 && video.duration > 0);
  }, null, { timeout: 90_000 });

  const before = await page.locator('#tcplayer-video').evaluate((video) => ({
    readyState: video.readyState,
    duration: video.duration,
    currentTime: video.currentTime,
    paused: video.paused,
    muted: video.muted,
    volume: video.volume,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  }));

  const playResult = await page.locator('#tcplayer-video').evaluate(async (video) => {
    try {
      await video.play();
      return 'resolved';
    } catch (error) {
      return `${error.name}: ${error.message}`;
    }
  });
  await page.waitForFunction(() => document.querySelector('#tcplayer-video')?.currentTime > 1, null, { timeout: 45_000 });
  const after = await page.locator('#tcplayer-video').evaluate((video) => ({
    readyState: video.readyState,
    duration: video.duration,
    currentTime: video.currentTime,
    paused: video.paused,
    ended: video.ended,
    muted: video.muted,
    volume: video.volume,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  }));
  await page.screenshot({ path: SCREENSHOT, fullPage: true });

  console.log('NAVIGATION_STATUS', navigation?.status());
  console.log('TITLE', await page.locator('h1').innerText());
  console.log('TCPLAYER_LOADED', await page.evaluate(() => typeof window.TCPlayer));
  console.log('PLAY_RESULT', playResult);
  console.log('BEFORE', JSON.stringify(before));
  console.log('AFTER', JSON.stringify(after));
  console.log('BODY_TEXT', (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim());
  console.log('NETWORK', JSON.stringify(network, null, 2));
  console.log('CONSOLE', JSON.stringify(errors, null, 2));
  await browser.close();
})().catch((error) => {
  console.error('FATAL', error);
  process.exitCode = 1;
  browser?.close().catch(() => {});
});
