const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/config/db');
const controller = require('../src/controllers/managementController');
const visitQuotaService = require('../src/services/visitQuotaService');
const { allowRoles } = require('../src/middleware/auth');

function responseRecorder() {
  return {
    body: null,
    json(body) {
      this.body = body;
      return body;
    },
  };
}

async function invoke(handler, req) {
  const res = responseRecorder();
  let forwarded;
  await handler(req, res, (error) => { forwarded = error; });
  return { res, error: forwarded };
}

test('super administrator can read and modify any business group quota', async () => {
  const originalList = visitQuotaService.listGroupQuotas;
  const originalAdd = visitQuotaService.addExtraQuota;
  const originalBase = visitQuotaService.updateBaseQuota;
  const calls = [];
  try {
    visitQuotaService.listGroupQuotas = async () => ({ period: '2026-08', groups: [] });
    visitQuotaService.addExtraQuota = async (...args) => {
      calls.push(['add', ...args]);
      return { businessGroupId: '9', baseQuota: 200, extraQuota: 50, usedQuota: 40, remainingQuota: 210 };
    };
    visitQuotaService.updateBaseQuota = async (...args) => {
      calls.push(['base', ...args]);
      return { businessGroupId: '9', baseQuota: 300, extraQuota: 50, usedQuota: 40, remainingQuota: 310 };
    };

    const listed = await invoke(controller.getVisitQuotas, {
      auth: { role: 'super_admin' }, body: {},
    });
    assert.equal(listed.error, undefined);
    assert.equal(listed.res.body.data.period, '2026-08');

    const added = await invoke(controller.addVisitQuota, {
      auth: { role: 'super_admin' },
      body: { businessGroupId: 9, additionalQuota: 50 },
    });
    const updated = await invoke(controller.updateVisitQuotaBase, {
      auth: { role: 'super_admin' },
      body: { businessGroupId: 9, baseQuota: 300 },
    });
    assert.equal(added.error, undefined);
    assert.equal(updated.error, undefined);
    assert.deepEqual(calls, [['add', 9, 50], ['base', 9, 300]]);
    assert.equal(updated.res.body.data.remainingQuota, 310);
  } finally {
    visitQuotaService.listGroupQuotas = originalList;
    visitQuotaService.addExtraQuota = originalAdd;
    visitQuotaService.updateBaseQuota = originalBase;
  }
});

test('system administrator cannot read or modify visit quota management', async () => {
  const auth = { role: 'system_admin' };
  const listed = await invoke(controller.getVisitQuotas, { auth, body: {} });
  const added = await invoke(controller.addVisitQuota, {
    auth, body: { businessGroupId: 9, additionalQuota: 50 },
  });
  const updated = await invoke(controller.updateVisitQuotaBase, {
    auth, body: { businessGroupId: 9, baseQuota: 300 },
  });
  for (const result of [listed, added, updated]) {
    assert.equal(result.error?.status, 403);
    assert.equal(result.error?.code, 'PERMISSION_DENIED');
  }
});

test('business manager can read quota but cannot modify it', async () => {
  const originalGet = visitQuotaService.getGroupQuota;
  const calls = [];
  try {
    visitQuotaService.getGroupQuota = async (groupId) => {
      calls.push(['get', groupId]);
      return { businessGroupId: String(groupId), baseQuota: 100, extraQuota: 20, usedQuota: 30, remainingQuota: 90 };
    };
    const auth = { role: 'business_manager', business_group_id: 7 };

    const read = await invoke(controller.getMyVisitQuota, { auth, body: {} });
    const add = await invoke(controller.addVisitQuota, {
      auth, body: { additionalQuota: 20 },
    });
    const base = await invoke(controller.updateVisitQuotaBase, {
      auth, body: { baseQuota: 160 },
    });
    assert.equal(read.error, undefined);
    assert.equal(add.error?.status, 403);
    assert.equal(add.error?.code, 'PERMISSION_DENIED');
    assert.equal(base.error?.status, 403);
    assert.equal(base.error?.code, 'PERMISSION_DENIED');
    assert.deepEqual(calls, [['get', 7]]);
  } finally {
    visitQuotaService.getGroupQuota = originalGet;
  }
});

test('business manager request for another business group is rejected with 403', async () => {
  const result = await invoke(controller.addVisitQuota, {
    auth: { role: 'business_manager', business_group_id: 7 },
    body: { businessGroupId: 8, additionalQuota: 10 },
  });
  assert.equal(result.error?.status, 403);
  assert.equal(result.error?.code, 'PERMISSION_DENIED');
});

test('non-super administrators are rejected by quota write role middleware', () => {
  let forwarded;
  allowRoles('super_admin')(
    { auth: { role: 'system_admin', business_group_id: 7 } },
    {},
    (error) => { forwarded = error; },
  );
  assert.equal(forwarded?.status, 403);
  assert.equal(forwarded?.code, 'PERMISSION_DENIED');
});

test('quota writers reject invalid, zero, negative, fractional, and oversized values', async () => {
  const invalid = [undefined, '', 'abc', '1abc', 0, -1, 1.5, 100000001];
  for (const value of invalid) {
    await assert.rejects(
      () => visitQuotaService.addExtraQuota(7, value),
      (error) => error.status === 400 && error.code === 'VISIT_QUOTA_VALIDATION_ERROR',
    );
    await assert.rejects(
      () => visitQuotaService.updateBaseQuota(7, value),
      (error) => error.status === 400 && error.code === 'VISIT_QUOTA_VALIDATION_ERROR',
    );
  }
});

test('transactional quota writes return consistent used, base, extra, and remaining values', async () => {
  const originalGetConnection = pool.getConnection;
  const originalExecute = pool.execute;
  const state = { base: 200, extra: 25, used: 70 };
  const calls = [];

  async function execute(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes("config_key = 'visit_quota_per_employee'")) return [[{ config_value: '100' }]];
    if (sql.startsWith('SELECT id FROM business_groups')) return [[{ id: 7 }]];
    if (sql.startsWith('INSERT INTO business_group_visit_quotas')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT extra_quota') && sql.includes('FOR UPDATE')) return [[{ extra_quota: state.extra }]];
    if (sql.includes('SET extra_quota = extra_quota + ?')) {
      state.extra += Number(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SET base_quota = ?')) {
      state.base = Number(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM business_group_visit_quotas q')) {
      return [[{
        business_group_id: 7,
        business_group_name: 'Group 7',
        period: '2026-08',
        base_quota: state.base,
        extra_quota: state.extra,
        used_quota: state.used,
        effective_employees: 2,
      }]];
    }
    if (sql.includes('FROM users')) return [[{ total: 2 }]];
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  const connection = {
    execute,
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
    async commit() { calls.push({ sql: 'COMMIT' }); },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  pool.getConnection = async () => connection;
  pool.execute = execute;
  try {
    const afterAdd = await visitQuotaService.addExtraQuota(7, 30);
    assert.deepEqual(
      (({ usedQuota, baseQuota, extraQuota, remainingQuota }) => ({ usedQuota, baseQuota, extraQuota, remainingQuota }))(afterAdd),
      { usedQuota: 70, baseQuota: 200, extraQuota: 55, remainingQuota: 185 },
    );
    const afterBase = await visitQuotaService.updateBaseQuota(7, 300);
    assert.deepEqual(
      (({ usedQuota, baseQuota, extraQuota, remainingQuota }) => ({ usedQuota, baseQuota, extraQuota, remainingQuota }))(afterBase),
      { usedQuota: 70, baseQuota: 300, extraQuota: 55, remainingQuota: 285 },
    );
    assert.equal(calls.filter((call) => call.sql === 'COMMIT').length, 2);
    assert.equal(calls.some((call) => String(call.sql).includes('FOR UPDATE')), true);
  } finally {
    pool.getConnection = originalGetConnection;
    pool.execute = originalExecute;
  }
});
