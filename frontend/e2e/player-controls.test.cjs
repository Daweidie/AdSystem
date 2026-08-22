const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

const edgePath = process.env.PLAYWRIGHT_EDGE_PATH
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.route('**/api/video/player-controls-test*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 1,
          title: '顺序播放测试',
          playback: { fileId: 'player-controls-test', appId: '123', psign: 'test-signature' },
        },
      }),
    }));
    await page.route('https://web.sdk.qcloud.com/player/tcplayer/release/v4.5.4/tcplayer.min.css', (route) => route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '.tcplayer-video{display:block}',
    }));
    await page.route('https://web.sdk.qcloud.com/player/tcplayer/release/v4.5.4/tcplayer.v4.5.4.min.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.TCPlayer=function(id,options){
        const handlers={}; let time=0; let rate=1;
        const instance={
          on(name,handler){(handlers[name]||(handlers[name]=[])).push(handler)},
          emit(name){(handlers[name]||[]).forEach((handler)=>handler({type:name}))},
          currentTime(value){if(arguments.length) time=value; return time},
          duration(){return 100},
          playbackRate(value){if(arguments.length) rate=value; return rate},
          play(){instance.emit('play'); return Promise.resolve()},
          pause(){instance.emit('pause')},
          dispose(){}
        };
        window.__playerTest={instance,options,setTime(value){time=value},getTime(){return time},setRate(value){rate=value},getRate(){return rate}};
        return instance;
      };`,
    }));

    await page.goto(`${baseUrl}/play?fileId=player-controls-test`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.demo18PlayerInitialized === 'true',
      null,
      { timeout: 30000 },
    );

    const options = await page.evaluate(() => window.__playerTest.options);
    assert.equal(options.controls, false);
    assert.deepEqual(options.playbackRates, [1]);
    assert.equal(options.controlBar.progressControl, false);
    assert.equal(options.controlBar.playbackRateMenuButton, false);
    assert.equal(await page.locator('.vjs-progress-control').count(), 0);
    assert.equal(await page.getByRole('button', { name: '播放', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '静音', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '全屏播放', exact: true }).count(), 1);

    const seekResult = await page.evaluate(() => {
      window.__playerTest.setTime(5);
      window.__playerTest.instance.emit('timeupdate');
      window.__playerTest.setTime(30);
      window.__playerTest.instance.emit('seeking');
      return window.__playerTest.getTime();
    });
    assert.equal(seekResult, 5);

    const rateResult = await page.evaluate(() => {
      window.__playerTest.setRate(2);
      window.__playerTest.instance.emit('ratechange');
      return window.__playerTest.getRate();
    });
    assert.equal(rateResult, 1);

    console.log(JSON.stringify({ success: true, controlsVerified: true, seekLockVerified: true }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
