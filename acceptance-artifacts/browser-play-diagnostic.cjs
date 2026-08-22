const { chromium } = require('C:/Users/popol/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PLAY_URL = 'http://localhost:5173/play?fileId=5001834815472845728';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE_PATH, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const responses = [];
    const messages = [];
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (r.url().includes('/api/') || r.url().includes('tcplayer') || r.request().resourceType() === 'media' || r.status() >= 400) {
        responses.push({ type: r.request().resourceType(), status: r.status(), url: `${u.origin}${u.pathname}` });
      }
    });
    page.on('requestfailed', (r) => messages.push(`requestfailed: ${r.failure()?.errorText} ${r.url().split('?')[0]}`));
    page.on('console', (m) => messages.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));
    const nav = await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(20_000);
    const state1 = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        tcPlayerType: typeof window.TCPlayer,
        bodyText: document.body.innerText.replace(/\s+/g, ' ').trim(),
        video: v && { readyState: v.readyState, networkState: v.networkState, error: v.error && { code: v.error.code, message: v.error.message }, src: v.currentSrc.split('?')[0], duration: v.duration, currentTime: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, width: v.videoWidth, height: v.videoHeight },
        playerNodes: document.querySelectorAll('.tcplayer,.tcp-video,.vjs-tech').length,
      };
    });
    console.log('NAV', nav?.status());
    console.log('STATE1', JSON.stringify(state1));
    console.log('RESPONSES_BEFORE_PLAY', JSON.stringify(responses, null, 2));
    console.log('MESSAGES_BEFORE_PLAY', JSON.stringify(messages, null, 2));
    const playAttempt = await page.evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return 'no-video-element';
      try { await v.play(); return 'resolved'; } catch (e) { return `${e.name}: ${e.message}`; }
    });
    await page.waitForTimeout(5_000);
    const state2 = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v && { readyState: v.readyState, networkState: v.networkState, error: v.error && { code: v.error.code, message: v.error.message }, duration: v.duration, currentTime: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, width: v.videoWidth, height: v.videoHeight };
    });
    await page.screenshot({ path: 'C:/Users/popol/Desktop/Projects/demo18/acceptance-artifacts/scenario-03-play-diagnostic.png', fullPage: true });
    console.log('PLAY_ATTEMPT', playAttempt);
    console.log('STATE2', JSON.stringify(state2));
    console.log('RESPONSES', JSON.stringify(responses, null, 2));
    console.log('MESSAGES', JSON.stringify(messages, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
