const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Nginx proxies card and play routes to Express before the Vue fallback', () => {
  const config = fs.readFileSync(
    path.resolve(__dirname, '../../nginx/demo18.conf.template'),
    'utf8',
  );
  const routes = [
    'location ~ "^/s/[A-Za-z0-9]{6,8}$"',
    'location ~ "^/card/[A-Za-z0-9_-]{20,128}$"',
    'location = /play',
  ];
  const spaStart = config.indexOf('location / {');

  assert.notEqual(spaStart, -1, 'missing Vue SPA fallback');
  for (const route of routes) {
    const routeStart = config.indexOf(route);
    assert.notEqual(routeStart, -1, `missing Express proxy route: ${route}`);
    assert.ok(routeStart < spaStart, `${route} must be declared before the Vue fallback`);

    const routeBlock = config.slice(routeStart, config.indexOf('\n    }', routeStart));
    assert.match(routeBlock, /proxy_pass http:\/\/127\.0\.0\.1:__BACKEND_PORT__/);
    assert.doesNotMatch(routeBlock, /try_files|index\.html|rewrite/);
  }
});

test('Nginx serves card covers directly from the managed upload directory', () => {
  const config = fs.readFileSync(
    path.resolve(__dirname, '../../nginx/demo18.conf.template'),
    'utf8',
  );
  const coverStart = config.indexOf('location ^~ /card-covers/');
  const apiStart = config.indexOf('location /api/');

  assert.notEqual(coverStart, -1, 'missing direct card-cover route');
  assert.ok(coverStart < apiStart, 'card covers must bypass the API proxy');
  const coverBlock = config.slice(coverStart, config.indexOf('\n    }', coverStart));
  assert.match(coverBlock, /alias __APP_DIR__\/backend\/uploads\/share-cards\//);
  assert.doesNotMatch(coverBlock, /proxy_pass|try_files/);
});
