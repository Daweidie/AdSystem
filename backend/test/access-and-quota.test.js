const test = require('node:test');
const assert = require('node:assert/strict');

const videoController = require('../src/controllers/videoController');
const shortLinkController = require('../src/controllers/shortLinkController');
const shortLinkService = require('../src/services/shortLinkService');
const visitQuotaService = require('../src/services/visitQuotaService');
const unifiedShortLinkService = require('../src/services/unifiedShortLinkService');
const pool = require('../src/config/db');

test('video retention defaults to three days and accepts a positive override', () => {
  const previous = process.env.VIDEO_RETENTION_DAYS;
  try {
    delete process.env.VIDEO_RETENTION_DAYS;
    assert.equal(videoController.DEFAULT_RETENTION_DAYS, 3);
    assert.equal(videoController.getRetentionDays(), 3);

    process.env.VIDEO_RETENTION_DAYS = '10';
    assert.equal(videoController.getRetentionDays(), 10);

    process.env.VIDEO_RETENTION_DAYS = '0';
    assert.equal(videoController.getRetentionDays(), 3);
  } finally {
    if (previous === undefined) delete process.env.VIDEO_RETENTION_DAYS;
    else process.env.VIDEO_RETENTION_DAYS = previous;
  }
});

test('upload signatures are only issued for videos at or below 800MB', async () => {
  assert.equal(videoController.MAX_VIDEO_UPLOAD_SIZE_BYTES, 800 * 1024 * 1024);

  let oversizeError;
  await videoController.getUploadSignature(
    { body: { fileSize: videoController.MAX_VIDEO_UPLOAD_SIZE_BYTES + 1 } },
    { json() { throw new Error('oversize upload must not receive a signature'); } },
    (error) => { oversizeError = error; },
  );
  assert.equal(oversizeError?.status, 413);
  assert.equal(oversizeError?.code, 'VIDEO_FILE_TOO_LARGE');

  let missingSizeError;
  await videoController.getUploadSignature(
    { body: {} },
    { json() { throw new Error('missing file size must not receive a signature'); } },
    (error) => { missingSizeError = error; },
  );
  assert.equal(missingSizeError?.status, 400);
  assert.equal(missingSizeError?.code, 'VIDEO_FILE_SIZE_INVALID');
});

test('promoter short-link scope is limited to links created by that promoter', () => {
  const own = shortLinkController.getShortLinkScope(
    { role: 'general_user', id: 42, business_group_id: 7 },
  );
  assert.match(own.sql, /v\.business_group_id = \?/);
  assert.match(own.sql, /sl\.created_by = \?/);
  assert.deepEqual(own.params, [7, 42]);

  const manager = shortLinkController.getShortLinkScope(
    { role: 'business_manager', id: 8, business_group_id: 7 },
  );
  assert.match(manager.sql, /v\.business_group_id = \?/);
  assert.doesNotMatch(manager.sql, /created_by/);
  assert.deepEqual(manager.params, [7]);

  const admin = shortLinkController.getShortLinkScope({ role: 'super_admin', id: 1 });
  assert.deepEqual(admin, { sql: '', params: [] });
});

function quotaExecutor(updateAffectedRows) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("config_key = 'visit_quota_per_employee'")) {
        return [[{ config_value: '100' }]];
      }
      if (sql.includes('FROM users')) return [[{ total: 2 }]];
      if (sql.startsWith('INSERT INTO business_group_visit_quotas')) return [{ affectedRows: 1 }];
      if (sql.startsWith('UPDATE business_group_visit_quotas')) {
        return [{ affectedRows: updateAffectedRows }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('monthly quota is atomically consumed and rejects the first over-limit visit', async () => {
  const available = quotaExecutor(1);
  const consumed = await visitQuotaService.consumeGroupVisitQuota(
    available,
    7,
    { period: '2026-08' },
  );
  assert.deepEqual(consumed, { enforced: true, period: '2026-08' });
  const update = available.calls.find((call) => call.sql.startsWith('UPDATE business_group_visit_quotas'));
  assert.deepEqual(update.params, ['7', '2026-08']);

  const exhausted = quotaExecutor(0);
  await assert.rejects(
    () => visitQuotaService.consumeGroupVisitQuota(exhausted, 7, { period: '2026-08' }),
    (error) => error.code === 'GROUP_VISIT_LIMIT_EXCEEDED' && error.status === 403,
  );
});

test('quota periods use the Beijing natural month', () => {
  assert.equal(
    visitQuotaService.getCurrentPeriod(new Date('2026-07-31T15:59:59.000Z')),
    '2026-07',
  );
  assert.equal(
    visitQuotaService.getCurrentPeriod(new Date('2026-07-31T16:00:00.000Z')),
    '2026-08',
  );
});

test('new links rotate through every enabled domain in the selected platform', () => {
  const domains = [
    { id: 7, platform: 'self', is_primary: 0, link_count: 0 },
    { id: 3, platform: 'self', is_primary: 1, link_count: 200 },
    { id: 9, platform: 'suolink', is_primary: 0, is_preferred: 0, link_count: 0 },
    { id: 12, platform: 'suolink', is_primary: 0, is_preferred: 1, link_count: 500 },
  ];

  assert.deepEqual(
    unifiedShortLinkService.selectGenerationCandidates(domains, 'auto').map((item) => item.id),
    [9, 12, 7, 3],
  );
  assert.deepEqual(
    unifiedShortLinkService.selectGenerationCandidates(domains, 'self').map((item) => item.id),
    [7, 3],
  );
  assert.deepEqual(
    unifiedShortLinkService.selectGenerationCandidates(domains, 'suolink').map((item) => item.id),
    [9, 12],
  );

  const recentlyUsed = [
    { id: 1, platform: 'suolink', link_count: 20, last_link_id: 105 },
    { id: 2, platform: 'suolink', link_count: 2, last_link_id: 108 },
    { id: 3, platform: 'suolink', link_count: 50, last_link_id: 101 },
    { id: 4, platform: 'suolink', link_count: 0, last_link_id: 0 },
  ];
  assert.deepEqual(
    unifiedShortLinkService.selectGenerationCandidates(recentlyUsed, 'suolink')
      .map((item) => item.id),
    [4, 3, 1, 2],
  );
});

test('duplicate external click callbacks do not consume monthly quota', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql) {
      calls.push(sql);
      if (sql.includes('SELECT sl.id')) {
        return [[{
          id: 9,
          video_id: 11,
          status: 'active',
          expires_at: null,
          business_group_id: 7,
          video_status: 'ready',
          video_expires_at: null,
        }]];
      }
      if (sql.includes('INSERT INTO play_logs')) {
        const error = new Error('duplicate event');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const previousGetConnection = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    const result = await shortLinkService.recordExternalClick('Abc123', {
      eventId: 'worker-event-1',
    });
    assert.deepEqual(result, { id: 9, recorded: false, duplicate: true });
    assert.equal(calls.some((sql) => sql.includes('business_group_visit_quotas')), false);
  } finally {
    pool.getConnection = previousGetConnection;
  }
});
