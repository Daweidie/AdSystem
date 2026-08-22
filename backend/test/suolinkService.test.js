const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const suolinkService = require('../src/services/suolinkService');

async function startServer() {
  let eventualRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/good') {
      res.writeHead(302, { Location: 'https://vod.hotwharf.com/play?fileId=test' });
      res.end();
      return;
    }

    if (req.url === '/expected-card') {
      res.writeHead(302, {
        Location: 'https://vod.hotwharf.com/card/abcdefghijklmnopqrstuvwxyz123456',
      });
      res.end();
      return;
    }

    if (req.url === '/eventual') {
      eventualRequests += 1;
      if (eventualRequests === 1) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<title>404 - 页面不存在</title><link href="e_404.css">');
        return;
      }
      res.writeHead(302, { Location: 'https://vod.hotwharf.com/play?fileId=test' });
      res.end();
      return;
    }

    if (req.url === '/card') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<title>正常的短链卡片</title>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<title>404 - 页面不存在</title>若您长时间无法正常访问建议您扫码联系官方客服');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

test('Suolink provider URL must use the selected provider domain', () => {
  const longUrl = 'https://vod.hotwharf.com/play?fileId=test';

  for (const domain of ['w1.hotwharf.com', 'i6q.cn', 'iq1k.cn', 'm6z.cn']) {
    const shortUrl = suolinkService.normalizeProviderShortUrl(
      `http://${domain}/j458S`,
      domain,
      longUrl,
      { forceHttps: false },
    );
    assert.equal(shortUrl, `http://${domain}/j458S`);
  }

  for (const domain of ['i6q.cn', 'm6z.cn']) {
    const canonicalShortUrl = suolinkService.normalizeProviderShortUrl(
      `https://b.${domain}/j458S`,
      domain,
      longUrl,
    );
    assert.equal(canonicalShortUrl, `https://b.${domain}/j458S`);
  }

  assert.throws(
    () => suolinkService.normalizeProviderShortUrl(
      'https://vod.hotwharf.com/AhtYo5zh',
      'i6q.cn',
      longUrl,
    ),
    (error) => error.code === 'SUOLINK_INVALID_RESPONSE',
  );

  assert.throws(
    () => suolinkService.normalizeProviderShortUrl(
      'https://other.i6q.cn/AhtYo5zh',
      'i6q.cn',
      longUrl,
    ),
    (error) => error.code === 'SUOLINK_INVALID_RESPONSE',
  );
});

test('Suolink creation forwards the selected domain and never substitutes a fixed domain', async (t) => {
  const originalRequest = axios.request;
  const originalGetApiKey = suolinkService._internals.getApiKey;
  const originalVerifyShortLink = suolinkService._internals.verifyShortLink;
  let requestConfig;
  const selectedDomain = 'iq1k.cn';
  const longUrl = 'https://vod.hotwharf.com/card/abcdefghijklmnopqrstuvwxyz123456';

  t.after(() => {
    axios.request = originalRequest;
    suolinkService._internals.getApiKey = originalGetApiKey;
    suolinkService._internals.verifyShortLink = originalVerifyShortLink;
  });

  axios.request = async (config) => {
    requestConfig = config;
    return {
      status: 200,
      data: { url: `https://${selectedDomain}/j458S`, err: '' },
    };
  };
  suolinkService._internals.getApiKey = async () => 'test-api-key';
  suolinkService._internals.verifyShortLink = async (shortUrl, options) => {
    assert.equal(shortUrl, `https://${selectedDomain}/j458S`);
    assert.equal(options.expectedLocation, longUrl);
    return { status: 302, location: longUrl };
  };

  const result = await suolinkService.createShortLink(longUrl, {
    domain: selectedDomain,
    expireDate: '2030-01-01',
  });

  assert.equal(requestConfig.params.domain, selectedDomain);
  assert.equal(result.shortUrl, `https://${selectedDomain}/j458S`);
  assert.equal(result.shortCode, 'j458S');
});

test('Suolink verification accepts redirects and card pages, and retries propagation', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const redirect = await suolinkService.verifyShortLink(`${origin}/good`, {
    attempts: 1,
    timeout: 1000,
  });
  assert.equal(redirect.status, 302);

  const card = await suolinkService.verifyShortLink(`${origin}/card`, {
    attempts: 1,
    timeout: 1000,
  });
  assert.equal(card.status, 200);

  const eventual = await suolinkService.verifyShortLink(`${origin}/eventual`, {
    attempts: 2,
    retryDelayMs: 1,
    timeout: 1000,
  });
  assert.equal(eventual.status, 302);
});

test('Suolink verification requires the exact /card/{cardToken} redirect target', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const expected = 'https://vod.hotwharf.com/card/abcdefghijklmnopqrstuvwxyz123456';

  const verified = await suolinkService.verifyShortLink(`${origin}/expected-card`, {
    expectedLocation: expected,
    attempts: 1,
    timeout: 1000,
  });
  assert.equal(verified.status, 302);
  assert.equal(verified.location, expected);

  await assert.rejects(
    suolinkService.verifyShortLink(`${origin}/good`, {
      expectedLocation: expected,
      attempts: 1,
      timeout: 1000,
    }),
    (error) => error.code === 'SUOLINK_PROVIDER_LINK_INVALID'
      && error.details.reason === 'unexpected_redirect_target',
  );
});

test('Suolink verification rejects the provider fake-404 page', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  await assert.rejects(
    suolinkService.verifyShortLink(`http://127.0.0.1:${port}/missing`, {
      attempts: 1,
      timeout: 1000,
    }),
    (error) => error.code === 'SUOLINK_PROVIDER_LINK_INVALID'
      && error.details.reason === 'provider_not_found_page',
  );
});
