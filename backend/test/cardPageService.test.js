const test = require('node:test');
const assert = require('node:assert/strict');
const cardPageService = require('../src/services/cardPageService');

test('card pages render escaped metadata and an encoded same-origin play target', () => {
  const cardToken = 'card-token-12345678901234567890';
  const request = {
    protocol: 'http',
    originalUrl: `/card/${cardToken}?ignored=1`,
    get: () => '127.0.0.1:3000',
  };
  const html = cardPageService.renderCardHtml({
    card_token: cardToken,
    card_title: '<script>alert(1)</script>',
    card_description: '描述 & "引号"',
    card_cover_url: 'http://unsafe.example/cover.jpg',
  }, request, '/play?fileId=demo&shortLinkId=9');

  assert.match(html, /<title>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  assert.match(html, /property="og:title" content="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, new RegExp(`property="og:url" content="http://127\\.0\\.0\\.1:3000/card/${cardToken}"`));
  assert.match(html, /property="og:image" content="http:\/\/127\.0\.0\.1:3000\/wechat-share-default\.png"/);
  assert.match(html, /name="twitter:title"/);
  assert.match(html, /name="twitter:description"/);
  assert.match(html, /name="twitter:image"/);
  assert.match(html, /window\.location\.assign\(/);
  assert.doesNotMatch(html, /\/play|window\.location\.replace|继续打开|继续播放|<div id="app">/);
  const token = html.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  assert.equal(Buffer.from(token, 'base64url').toString('utf8'), '/play?fileId=demo&shortLinkId=9');
  assert.equal(html.includes('<script>alert(1)</script>'), false);
});

test('card pages keep the final local cover URL in og:image', () => {
  const coverPath = '/card-covers/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
  const html = cardPageService.renderCardHtml({
    card_title: '自定义封面',
    card_description: '封面已转为 JPG',
    card_cover_url: coverPath,
  }, {
    protocol: 'https',
    originalUrl: '/s/Ab12Cd',
    get: () => 'vod.hotwharf.com',
  }, '/play?fileId=custom');

  assert.match(html, new RegExp(`property="og:image" content="https://vod\\.hotwharf\\.com${coverPath.replaceAll('.', '\\.')}"`));
  assert.doesNotMatch(html, /wechat-share-default\.png/);
});

test('card pages use the configured application origin for local covers', () => {
  const previous = process.env.PUBLIC_CARD_BASE_URL;
  process.env.PUBLIC_CARD_BASE_URL = 'https://vod.zzqxkj055.eu.cc';
  try {
    const filename = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
    const html = cardPageService.renderCardHtml({
      card_title: '正式域名封面',
      card_cover_url: `/card-covers/${filename}`,
    }, {
      protocol: 'https',
      originalUrl: '/hwi6Z',
      get: () => 'b.i6q.cn',
    }, '/play?fileId=cover', { baseUrl: 'https://i6q.cn' });

    assert.match(html, new RegExp(
      `property="og:image" content="https://vod\\.zzqxkj055\\.eu\\.cc/card-covers/${filename}"`,
    ));
    assert.doesNotMatch(html, /https:\/\/i6q\.cn\/card-covers/);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_CARD_BASE_URL;
    else process.env.PUBLIC_CARD_BASE_URL = previous;
  }
});

test('card pages migrate legacy API-shaped cover URLs to the top-level static path', () => {
  const filename = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
  const html = cardPageService.renderCardHtml({
    card_title: '旧封面',
    card_cover_url: `/api/media/share-cards/${filename}`,
  }, {
    protocol: 'https',
    originalUrl: '/s/Old123',
    get: () => 'vod.hotwharf.com',
  }, '/play?fileId=legacy');

  assert.match(html, new RegExp(`property="og:image" content="https://vod\.hotwharf\.com/card-covers/${filename}`));
  assert.doesNotMatch(html, /api\/media\/share-cards/);
});

test('card tokens are URL-safe and unique', () => {
  const first = cardPageService.createCardToken();
  const second = cardPageService.createCardToken();
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(first, second);
});

test('text_description renders independent safe descriptions and no image signals', () => {
  const request = {
    protocol: 'https',
    originalUrl: '/s/Ab12Cd?ignored=%3Cscript%3E',
    get: () => 'cards.example.com',
  };
  const maliciousTitle = '正常素材标题 </title><script>alert("title")</script>';
  const maliciousDescription = '第一行\n\t第二行 </script><img src=x onerror=alert(1)> & \u2028 \u2029';
  const html = cardPageService.renderCardHtml({
    wechat_card_mode: 'text_description',
    card_title: maliciousTitle,
    card_description: maliciousDescription,
    card_cover_url: 'https://images.example.com/must-not-appear.jpg',
    video_cover_url: 'https://images.example.com/video-must-not-appear.jpg',
  }, request, '/play?fileId=safe&shortLinkId=18');

  assert.match(html, /<title>正常素材标题 &lt;\/title&gt;&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;<\/title>/);
  assert.match(html, /property="og:title" content="正常素材标题 /);
  assert.doesNotMatch(html, /property="og:title"[^>]+第一行/);
  assert.match(html, /name="description" content="第一行 第二行/);
  assert.match(html, /property="og:description" content="第一行 第二行/);
  assert.match(html, /name="twitter:description" content="第一行 第二行/);
  assert.match(html, /itemprop="description" content="第一行 第二行/);
  assert.match(html, /itemprop="name" content="正常素材标题/);

  for (const imageSignal of [
    /og:image/i,
    /twitter:image/i,
    /itemprop="image"/i,
    /<img\b/i,
    /wechat-share-default/i,
    /rel="preload"/i,
    /must-not-appear/i,
  ]) {
    assert.doesNotMatch(html, imageSignal);
  }
  assert.doesNotMatch(html, /display\s*:\s*none|opacity\s*:\s*0|position\s*:\s*(?:absolute|fixed)/i);
  assert.match(html, /rel="canonical" href="https:\/\/cards\.example\.com\/s\/Ab12Cd"/);
  assert.match(html, /property="og:url" content="https:\/\/cards\.example\.com\/s\/Ab12Cd"/);
  assert.match(html, /正在打开视频/);
  assert.match(html, /<p>第一行 第二行/);
  assert.doesNotMatch(html, /window\.location\.replace|继续打开|继续播放|<div id="app">/);
  assert.doesNotMatch(html, /\/play/);

  const playToken = html.match(/data-play-token="([A-Za-z0-9_-]+)"/)?.[1];
  assert.equal(
    Buffer.from(playToken, 'base64url').toString('utf8'),
    '/play?fileId=safe&shortLinkId=18',
  );

  const jsonText = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(jsonText);
  assert.doesNotMatch(jsonText, /<|>|&|\u2028|\u2029/u);
  assert.match(jsonText, /\\u003c\/script\\u003e/);
  assert.match(jsonText, /\\u0026/);
  const separatorJson = cardPageService.serializeInlineJson({
    separators: 'before\u2028middle\u2029after',
  });
  assert.match(separatorJson, /\\u2028/);
  assert.match(separatorJson, /\\u2029/);
  assert.doesNotMatch(separatorJson, /\u2028|\u2029/u);
  assert.deepEqual(JSON.parse(jsonText), {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: maliciousTitle,
    description: maliciousDescription.replace(/\s+/gu, ' ').trim(),
    url: 'https://cards.example.com/s/Ab12Cd',
  });
  assert.equal(html.includes('<script>alert("title")</script>'), false);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
});

test('text_description falls back from a blank card description to video description', () => {
  const html = cardPageService.renderCardHtml({
    wechat_card_mode: 'text_description',
    card_title: '素材标题',
    card_description: ' \n\t ',
    video_description: '视频\n简介',
  }, {
    protocol: 'https',
    originalUrl: '/card/safe-token-12345678901234567890',
    get: () => 'cards.example.com',
  }, '/play?fileId=safe');

  assert.match(html, /name="description" content="视频 简介"/);
  assert.doesNotMatch(html, /点击查看视频内容/);
});

test('text_description safely serializes a hostile public page URL', () => {
  const pageUrl = 'https://cards.example.com/s/Ab12Cd?next="></script><script>alert(1)</script>&x=1';
  const html = cardPageService.renderCardHtml({
    wechat_card_mode: 'text_description',
    card_title: '素材标题',
    card_description: '素材简介',
  }, {
    protocol: 'https',
    originalUrl: '/s/Ab12Cd',
    get: () => 'cards.example.com',
  }, '/play?fileId=safe', { pageUrl });

  assert.match(html, /rel="canonical" href="https:\/\/cards\.example\.com\/s\/Ab12Cd\?next=&quot;&gt;&lt;\/script&gt;/);
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  const jsonText = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.equal(JSON.parse(jsonText).url, pageUrl);
  assert.doesNotMatch(jsonText, /<|>|&/);
});
