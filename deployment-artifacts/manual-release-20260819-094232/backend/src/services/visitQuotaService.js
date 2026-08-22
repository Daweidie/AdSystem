const pool = require('../config/db');

const DEFAULT_PER_EMPLOYEE_QUOTA = 2000;
const MIN_PER_EMPLOYEE_QUOTA = 1;
const MAX_PER_EMPLOYEE_QUOTA = 1000000;
const MAX_EXTRA_QUOTA = 100000000;
const MAX_BASE_QUOTA = 100000000;

class GroupVisitLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GroupVisitLimitError';
    this.code = 'GROUP_VISIT_LIMIT_EXCEEDED';
    this.status = 403;
  }
}

class VisitQuotaValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisitQuotaValidationError';
    this.code = 'VISIT_QUOTA_VALIDATION_ERROR';
    this.status = 400;
  }
}

// 以北京时间（UTC+8）划分自然月，格式 YYYY-MM。
// 数据库连接固定为 UTC，这里在应用层换算，避免依赖 MySQL 时区表。
function getCurrentPeriod(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

function normalizeGroupId(value) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw new VisitQuotaValidationError('businessGroupId 必须是正整数');
  }
  return String(value);
}

function normalizePositiveInteger(value, fieldName, max) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  const parsed = Number(normalized);
  if (
    normalized === ''
    || !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > max
  ) {
    throw new VisitQuotaValidationError(`${fieldName} 必须是 1 到 ${max} 之间的整数`);
  }
  return parsed;
}

async function getPerEmployeeQuota(executor = pool) {
  const [rows] = await executor.execute(
    "SELECT config_value FROM system_configs WHERE config_key = 'visit_quota_per_employee' LIMIT 1",
  );
  const parsed = Number.parseInt(rows[0]?.config_value, 10);
  return Number.isInteger(parsed) && parsed >= MIN_PER_EMPLOYEE_QUOTA
    ? parsed
    : DEFAULT_PER_EMPLOYEE_QUOTA;
}

async function countEffectiveEmployees(executor, businessGroupId) {
  const [rows] = await executor.execute(
    `SELECT COUNT(*) AS total
     FROM users
     WHERE business_group_id = ?
       AND role = 'general_user'
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [businessGroupId],
  );
  return Number(rows[0]?.total || 0);
}

// 每月首次使用时按 有效员工数 × 每员工额度 自动创建当月配额行；
// 月底无需清零，新周期使用全新的配额行，天然实现“月底清零”。
async function ensureQuotaRow(executor, businessGroupId, period) {
  const perEmployee = await getPerEmployeeQuota(executor);
  const employees = await countEffectiveEmployees(executor, businessGroupId);
  const baseQuota = employees * perEmployee;
  await executor.execute(
    `INSERT INTO business_group_visit_quotas
       (business_group_id, period, base_quota, extra_quota, used_quota, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE business_group_id = business_group_id`,
    [businessGroupId, period, baseQuota],
  );
  return { baseQuota, employees, perEmployee };
}

// 在访问事务内原子消耗一次访问配额；超出上限时抛出 GroupVisitLimitError。
async function consumeGroupVisitQuota(connection, businessGroupId, options = {}) {
  if (businessGroupId === null || businessGroupId === undefined) {
    return { enforced: false };
  }

  const groupId = normalizeGroupId(businessGroupId);
  const period = options.period || getCurrentPeriod();
  await ensureQuotaRow(connection, groupId, period);

  const [result] = await connection.execute(
    `UPDATE business_group_visit_quotas
     SET used_quota = used_quota + 1, updated_at = UTC_TIMESTAMP()
     WHERE business_group_id = ?
       AND period = ?
       AND used_quota < base_quota + extra_quota`,
    [groupId, period],
  );

  if (result.affectedRows === 0) {
    throw new GroupVisitLimitError('该业务组本月访问量已达上限，请联系管理员增加额度');
  }

  return { enforced: true, period };
}

// 管理端：列出所有业务组当月配额（首次查看时自动为本月创建配额行）。
async function listGroupQuotas() {
  const period = getCurrentPeriod();
  const perEmployee = await getPerEmployeeQuota();
  const [groups] = await pool.execute(
    'SELECT id, name FROM business_groups ORDER BY id ASC',
  );

  for (const group of groups) {
    await ensureQuotaRow(pool, group.id, period);
  }

  const [rows] = await pool.execute(
    `SELECT q.business_group_id,
            g.name AS business_group_name,
            q.period,
            q.base_quota,
            q.extra_quota,
            q.used_quota,
            (SELECT COUNT(*)
             FROM users u
             WHERE u.business_group_id = q.business_group_id
               AND u.role = 'general_user'
               AND u.status = 'active'
               AND (u.expires_at IS NULL OR u.expires_at > NOW())) AS effective_employees
     FROM business_group_visit_quotas q
     INNER JOIN business_groups g ON g.id = q.business_group_id
     WHERE q.period = ?
     ORDER BY q.business_group_id ASC`,
    [period],
  );

  return {
    period,
    perEmployee,
    groups: rows.map((row) => ({
      businessGroupId: String(row.business_group_id),
      businessGroupName: row.business_group_name,
      period: row.period,
      effectiveEmployees: Number(row.effective_employees || 0),
      baseQuota: Number(row.base_quota || 0),
      extraQuota: Number(row.extra_quota || 0),
      usedQuota: Number(row.used_quota || 0),
      remainingQuota: Math.max(
        Number(row.base_quota || 0) + Number(row.extra_quota || 0) - Number(row.used_quota || 0),
        0,
      ),
    })),
  };
}

// 管理端：读取当前业务组当月配额，供业务组管理员查看自己的使用情况。
async function getGroupQuota(businessGroupId) {
  const groupId = normalizeGroupId(businessGroupId);
  const period = getCurrentPeriod();
  const perEmployee = await getPerEmployeeQuota();
  await ensureQuotaRow(pool, groupId, period);

  const [[row]] = await pool.execute(
    `SELECT q.business_group_id,
            g.name AS business_group_name,
            q.period,
            q.base_quota,
            q.extra_quota,
            q.used_quota,
            (SELECT COUNT(*)
             FROM users u
             WHERE u.business_group_id = q.business_group_id
               AND u.role = 'general_user'
               AND u.status = 'active'
               AND (u.expires_at IS NULL OR u.expires_at > NOW())) AS effective_employees
     FROM business_group_visit_quotas q
     INNER JOIN business_groups g ON g.id = q.business_group_id
     WHERE q.business_group_id = ? AND q.period = ?
     LIMIT 1`,
    [groupId, period],
  );

  if (!row) {
    throw new VisitQuotaValidationError('业务组不存在');
  }

  const baseQuota = Number(row.base_quota || 0);
  const extraQuota = Number(row.extra_quota || 0);
  const usedQuota = Number(row.used_quota || 0);

  return {
    businessGroupId: String(row.business_group_id),
    businessGroupName: row.business_group_name,
    period: row.period,
    perEmployee,
    effectiveEmployees: Number(row.effective_employees || 0),
    baseQuota,
    extraQuota,
    usedQuota,
    remainingQuota: Math.max(baseQuota + extraQuota - usedQuota, 0),
  };
}

async function assertGroupExists(executor, groupId) {
  const [groups] = await executor.execute(
    'SELECT id FROM business_groups WHERE id = ? LIMIT 1',
    [groupId],
  );
  if (groups.length === 0) throw new VisitQuotaValidationError('业务组不存在');
}

// 当前月额外额度在事务和行锁内累加，避免并发覆盖或无符号整数溢出。
async function addExtraQuota(businessGroupId, additionalQuota) {
  const groupId = normalizeGroupId(businessGroupId);
  const amount = normalizePositiveInteger(additionalQuota, 'additionalQuota', MAX_EXTRA_QUOTA);
  const period = getCurrentPeriod();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await assertGroupExists(connection, groupId);
    await ensureQuotaRow(connection, groupId, period);
    const [[row]] = await connection.execute(
      `SELECT extra_quota
       FROM business_group_visit_quotas
       WHERE business_group_id = ? AND period = ?
       LIMIT 1 FOR UPDATE`,
      [groupId, period],
    );
    if (!row) throw new VisitQuotaValidationError('业务组额度不存在');
    if (Number(row.extra_quota) + amount > MAX_EXTRA_QUOTA) {
      throw new VisitQuotaValidationError(`extraQuota 不能超过 ${MAX_EXTRA_QUOTA}`);
    }
    await connection.execute(
      `UPDATE business_group_visit_quotas
       SET extra_quota = extra_quota + ?, updated_at = UTC_TIMESTAMP()
       WHERE business_group_id = ? AND period = ?`,
      [amount, groupId, period],
    );
    await connection.commit();
    return getGroupQuota(groupId);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// 当前月基础额度立即生效，不修改用于下月初始化的平台 perEmployee 配置。
async function updateBaseQuota(businessGroupId, baseQuota) {
  const groupId = normalizeGroupId(businessGroupId);
  const quota = normalizePositiveInteger(baseQuota, 'baseQuota', MAX_BASE_QUOTA);
  const period = getCurrentPeriod();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await assertGroupExists(connection, groupId);
    await ensureQuotaRow(connection, groupId, period);
    await connection.execute(
      `UPDATE business_group_visit_quotas
       SET base_quota = ?, updated_at = UTC_TIMESTAMP()
       WHERE business_group_id = ? AND period = ?`,
      [quota, groupId, period],
    );
    await connection.commit();
    return getGroupQuota(groupId);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// 管理端：调整每有效员工的月度访问额度（影响后续月份自动创建的配额）。
async function updatePerEmployeeQuota(value) {
  const quota = normalizePositiveInteger(
    value,
    'perEmployee',
    MAX_PER_EMPLOYEE_QUOTA,
  );
  await pool.execute(
    `INSERT INTO system_configs (config_key, config_value)
     VALUES ('visit_quota_per_employee', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [String(quota)],
  );
  return quota;
}

module.exports = {
  consumeGroupVisitQuota,
  listGroupQuotas,
  getGroupQuota,
  addExtraQuota,
  updateBaseQuota,
  updatePerEmployeeQuota,
  getPerEmployeeQuota,
  getCurrentPeriod,
  DEFAULT_PER_EMPLOYEE_QUOTA,
  GroupVisitLimitError,
  VisitQuotaValidationError,
  MAX_EXTRA_QUOTA,
  MAX_BASE_QUOTA,
};
