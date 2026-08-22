const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/config/db');
const runtimeConfigService = require('../src/services/runtimeConfigService');

test('public card base URL uses the enabled self primary domain when env is unset', async (t) => {
  const previous = process.env.PUBLIC_CARD_BASE_URL;
  delete process.env.PUBLIC_CARD_BASE_URL;
  const originalExecute = pool.execute;
  pool.execute = async (sql) => {
    assert.match(sql, /FROM domains/);
    return [[
      { id: 1, domain: 'https://primary.example.com', is_primary: 1 },
      { id: 2, domain: 'https://pool.example.com', is_primary: 0 },
    ]];
  };

  t.after(() => {
    pool.execute = originalExecute;
    if (previous === undefined) delete process.env.PUBLIC_CARD_BASE_URL;
    else process.env.PUBLIC_CARD_BASE_URL = previous;
  });

  const diagnostics = await runtimeConfigService.getPublicCardDomainDiagnostics();
  assert.equal(diagnostics.status, 'ok');
  assert.equal(diagnostics.source, 'domain_pool');
  assert.equal(diagnostics.matchingDomain, 'https://primary.example.com');
  assert.equal(await runtimeConfigService.getPublicCardBaseUrl(), 'https://primary.example.com');
});

test('configured public card base URL reports expected and actual domains on mismatch', async (t) => {
  const previous = process.env.PUBLIC_CARD_BASE_URL;
  process.env.PUBLIC_CARD_BASE_URL = 'https://expected.example.com';
  const originalExecute = pool.execute;
  pool.execute = async (sql) => {
    assert.match(sql, /FROM domains/);
    return [[{ id: 1, domain: 'https://actual.example.com', is_primary: 1 }]];
  };

  t.after(() => {
    pool.execute = originalExecute;
    if (previous === undefined) delete process.env.PUBLIC_CARD_BASE_URL;
    else process.env.PUBLIC_CARD_BASE_URL = previous;
  });

  const diagnostics = await runtimeConfigService.getPublicCardDomainDiagnostics();
  assert.equal(diagnostics.status, 'mismatch');
  assert.match(diagnostics.message, /https:\/\/expected\.example\.com/);
  assert.match(diagnostics.message, /https:\/\/actual\.example\.com/);
  assert.match(diagnostics.repair, /加入并启用|修改 PUBLIC_CARD_BASE_URL/);
  await assert.rejects(
    () => runtimeConfigService.getPublicCardBaseUrl(),
    (error) => error.code === 'PUBLIC_CARD_DOMAIN_MISMATCH'
      && error.status === 409
      && /期望域名/.test(error.message),
  );
});
