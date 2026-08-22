const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const cloudflareShortLinkService = require('../src/services/cloudflareShortLinkService');
const { safeEqual } = require('../src/middleware/serviceAuth');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Cloudflare mapping sync retries transient failures without exposing the API key', async (t) => {
  let requests = 0;
  let authorization = '';
  const server = await listen((req, res) => {
    requests += 1;
    authorization = req.headers.authorization || '';
    if (requests < 3) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"temporary"}');
      return;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      shortCode: 'Abc123',
      shortUrl: `http://127.0.0.1:${server.address().port}/Abc123`,
    }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.NODE_ENV = 'test';
  process.env.CLOUDFLARE_SHORTLINK_ENABLED = 'true';
  process.env.CLOUDFLARE_SHORTLINK_BASE_URL = origin;
  process.env.CLOUDFLARE_SHORTLINK_API_URL = origin;
  process.env.CLOUDFLARE_SHORTLINK_API_KEY = 'unit-test-secret-key';
  process.env.CLOUDFLARE_SHORTLINK_MAX_RETRIES = '2';

  const result = await cloudflareShortLinkService.createMapping({
    shortCode: 'Abc123',
    targetUrl: 'https://vod.hotwharf.com/card/abcdefghijklmnopqrstuvwxyz123456',
    ogTitle: '标题',
    ogDescription: '描述',
    ogImage: 'https://vod.hotwharf.com/cover.jpg',
    ogUrl: `${origin}/Abc123`,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  assert.equal(result.shortCode, 'Abc123');
  assert.equal(requests, 3);
  assert.equal(authorization, 'Bearer unit-test-secret-key');
  assert.equal(cloudflareShortLinkService.isManagedDomain(origin), true);
});

test('service API keys use constant-length digest comparison', () => {
  assert.equal(safeEqual('same-secret', 'same-secret'), true);
  assert.equal(safeEqual('same-secret', 'different-secret'), false);
  assert.equal(safeEqual('a', 'a-much-longer-value'), false);
});
