const pool = require('../config/db');
const {
  createToken,
  hashPassword,
  verifyPassword,
  TOKEN_TTL_SECONDS,
} = require('../services/authService');
const { getCustomerBaseUrl } = require('../services/runtimeConfigService');
const cloudflareShortLinkService = require('../services/cloudflareShortLinkService');
const logger = require('../utils/logger');
const { isPrivateHostname, toPublicHttpsUrl } = require('../services/cardPageService');
const {
  processCardCover,
  removeCardCover,
} = require('../services/cardCoverService');
const visitQuotaService = require('../services/visitQuotaService');

const ROLES = ['super_admin', 'system_admin', 'business_manager', 'general_user'];
const USER_ROLES = ['business_manager', 'general_user'];

function httpError(status, message, code = 'VALIDATION_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function positiveId(value, field = 'id', optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw httpError(400, `${field} 必须是正整数`);
  }
  return String(value);
}

function text(value, field, maximum = 255, optional = false) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized && !optional) throw httpError(400, `${field}不能为空`);
  if (normalized.length > maximum) throw httpError(400, `${field}不能超过 ${maximum} 个字符`);
  return normalized || null;
}

function clientDateTime(value, field = '日期时间') {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  const chinaLocalPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const date = new Date(
    chinaLocalPattern.test(normalized)
      ? `${normalized.replace(' ', 'T')}+08:00`
      : normalized,
  );
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `${field}格式不正确`);
  }
  return date;
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    businessGroupId: row.business_group_id,
    businessGroupName: row.business_group_name || null,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function login(req, res, next) {
  try {
    const phone = text(req.body?.phone, '登录手机号', 32);
    const password = text(req.body?.password, '登录密码', 128);
    const [rows] = await pool.execute(
      `SELECT u.*, bg.name AS business_group_name
       FROM users u LEFT JOIN business_groups bg ON bg.id = u.business_group_id
       WHERE u.phone = ? LIMIT 1`,
      [phone],
    );
    const user = rows[0];

    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw httpError(401, '手机号或密码不正确', 'LOGIN_FAILED');
    }
    if (user.status !== 'active') throw httpError(403, '账号已停用', 'ACCOUNT_DISABLED');
    if (user.expires_at && new Date(user.expires_at).getTime() <= Date.now()) {
      throw httpError(403, '账号已到期', 'ACCOUNT_EXPIRED');
    }

    res.json({
      success: true,
      data: {
        token: createToken(user),
        expiresIn: TOKEN_TTL_SECONDS,
        user: publicUser(user),
      },
      message: '登录成功',
    });
  } catch (error) {
    next(error);
  }
}

function me(req, res) {
  res.json({ success: true, data: publicUser(req.auth) });
}

function scopeSql(user, alias = 'v') {
  if (['super_admin', 'system_admin'].includes(user.role)) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.business_group_id = ?`, params: [user.business_group_id || 0] };
}

function promoterLinkScope(user, alias = 'sl') {
  return user?.role === 'general_user'
    ? { sql: ` AND ${alias}.created_by = ?`, params: [user.id] }
    : { sql: '', params: [] };
}

async function requireScopedRecord(user, table, id, groupColumn = 'business_group_id') {
  const platformAdmin = ['super_admin', 'system_admin'].includes(user.role);
  const [rows] = await pool.execute(
    `SELECT id, ${groupColumn} FROM ${table} WHERE id = ?${platformAdmin ? '' : ` AND ${groupColumn} = ?`} LIMIT 1`,
    platformAdmin ? [id] : [id, user.business_group_id || 0],
  );
  if (!rows[0]) throw httpError(403, '只能管理本业务组的数据', 'PERMISSION_DENIED');
  return rows[0];
}

async function dashboard(req, res, next) {
  try {
    const platformAdmin = ['super_admin', 'system_admin'].includes(req.auth.role);
    const scope = scopeSql(req.auth);
    const ownLinkScope = promoterLinkScope(req.auth);
    const playSource = ownLinkScope.sql
      ? `FROM play_logs pl
         INNER JOIN videos v ON v.id = pl.video_id
         INNER JOIN short_links sl ON sl.id = pl.short_link_id`
      : 'FROM play_logs pl INNER JOIN videos v ON v.id = pl.video_id';
    const videoWhere = `WHERE v.status <> 'deleted'${scope.sql}`;
    const [materialRows] = await pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(v.status = 'ready' AND v.expires_at > NOW()) AS effective,
              SUM(v.created_at >= CURRENT_DATE) AS today_uploads,
              SUM(v.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS week_uploads,
              SUM(v.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS month_uploads,
              SUM(v.expires_at <= DATE_ADD(NOW(), INTERVAL 15 DAY) AND v.expires_at > NOW()) AS expiring
       FROM videos v ${videoWhere}`,
      scope.params,
    );
    const [linkRows] = await pool.execute(
      `SELECT COUNT(*) AS total_links, COALESCE(SUM(sl.clicks), 0) AS visits
       FROM short_links sl INNER JOIN videos v ON v.id = sl.video_id
       WHERE 1=1${scope.sql}${ownLinkScope.sql}`,
      [...scope.params, ...ownLinkScope.params],
    );
    const [playRows] = await pool.execute(
      `SELECT SUM(pl.event_type = 'start') AS starts,
              SUM(pl.event_type = 'complete') AS completes,
              SUM(pl.event_type = 'start' AND pl.played_at >= CURRENT_DATE) AS today_starts,
              SUM(pl.event_type = 'complete' AND pl.played_at >= CURRENT_DATE) AS today_completes
       ${playSource}
       WHERE 1=1${scope.sql}${ownLinkScope.sql}`,
      [...scope.params, ...ownLinkScope.params],
    );
    const [peopleRows] = await pool.execute(
      `SELECT COUNT(*) AS promoters,
              SUM(u.status = 'active' AND (u.expires_at IS NULL OR u.expires_at > NOW())) AS effective_promoters
       FROM users u WHERE u.role = 'general_user'${
         platformAdmin ? '' : ' AND u.business_group_id = ?'
       }`,
      platformAdmin ? [] : [req.auth.business_group_id || 0],
    );
    let groupRow = null;
    if (platformAdmin) {
      [[groupRow]] = await pool.execute(
        `SELECT COUNT(*) AS business_groups,
                SUM(status = 'active' AND (expires_at IS NULL OR expires_at > NOW())) AS effective_groups
         FROM business_groups`,
      );
    }
    const materials = materialRows[0] || {};
    const links = linkRows[0] || {};
    const plays = playRows[0] || {};
    const people = peopleRows[0] || {};
    const completionRate = Number(plays.starts) > 0
      ? Math.round((Number(plays.completes || 0) / Number(plays.starts)) * 100)
      : 0;

    res.json({
      success: true,
      data: {
        materials: {
          total: Number(materials.total || 0), effective: Number(materials.effective || 0),
          todayUploads: Number(materials.today_uploads || 0), weekUploads: Number(materials.week_uploads || 0),
          monthUploads: Number(materials.month_uploads || 0), expiring: Number(materials.expiring || 0),
        },
        people: {
          ...(platformAdmin ? {
            businessGroups: Number(groupRow?.business_groups || 0),
            effectiveGroups: Number(groupRow?.effective_groups || 0),
          } : {}),
          promoters: Number(people.promoters || 0), effectivePromoters: Number(people.effective_promoters || 0),
        },
        delivery: {
          totalLinks: Number(links.total_links || 0), visits: Number(links.visits || 0),
          starts: Number(plays.starts || 0), completes: Number(plays.completes || 0), completionRate,
          todayStarts: Number(plays.today_starts || 0), todayCompletes: Number(plays.today_completes || 0),
        },
      },
    });
  } catch (error) { next(error); }
}

async function listBusinessGroups(req, res, next) {
  try {
    const platformAdmin = ['super_admin', 'system_admin'].includes(req.auth.role);
    const params = [];
    let where = '';
    if (!platformAdmin) {
      where = 'WHERE bg.id = ?';
      params.push(req.auth.business_group_id || 0);
    }
    const [rows] = await pool.execute(
      `SELECT bg.*, u.name AS manager_name, u.phone AS manager_phone,
              (SELECT COUNT(*) FROM users m WHERE m.business_group_id = bg.id AND m.role IN ('business_manager','general_user')) AS member_count
       FROM business_groups bg
       LEFT JOIN users u ON u.id = bg.manager_user_id
       ${where} ORDER BY bg.created_at DESC`, params,
    );
    const quotaByGroup = new Map();
    if (platformAdmin) {
      const quotaData = await visitQuotaService.listGroupQuotas();
      for (const quota of quotaData.groups || []) quotaByGroup.set(String(quota.businessGroupId), quota);
    }
    res.json({
      success: true,
      data: rows.map((row) => {
        const quota = quotaByGroup.get(String(row.id));
        return {
          ...row,
          used_quota: quota?.usedQuota ?? 0,
          remaining_quota: quota?.remainingQuota ?? 0,
          quota_period: quota?.period || null,
        };
      }),
    });
  } catch (error) { next(error); }
}

async function saveBusinessGroup(req, res, next) {
  try {
    const name = text(req.body?.name, '业务组名称', 128);
    const expiresAt = clientDateTime(req.body?.expiresAt, '账号到期时间');
    const managerName = text(req.body?.managerName, '管理员用户名', 128);
    const managerPhone = text(req.body?.managerPhone, '管理员登录手机', 32);
    const password = text(req.body?.password, '管理员密码', 128);
    const credentials = hashPassword(password);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [groupResult] = await connection.execute(
        `INSERT INTO business_groups (name, status, expires_at) VALUES (?, 'active', ?)`,
        [name, expiresAt],
      );
      const [userResult] = await connection.execute(
        `INSERT INTO users
           (name, phone, password_salt, password_hash, role, business_group_id, status, expires_at)
         VALUES (?, ?, ?, ?, 'business_manager', ?, 'active', ?)`,
        [managerName, managerPhone, credentials.salt, credentials.hash, groupResult.insertId, expiresAt],
      );
      await connection.execute('UPDATE business_groups SET manager_user_id = ? WHERE id = ?', [userResult.insertId, groupResult.insertId]);
      await connection.commit();
      res.status(201).json({ success: true, data: { id: groupResult.insertId }, message: '业务组添加成功' });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') throw httpError(409, '业务组名称或管理员手机号已存在', 'DUPLICATE_RECORD');
      throw error;
    } finally { connection.release(); }
  } catch (error) { next(error); }
}

async function updateBusinessGroup(req, res, next) {
  let connection;
  try {
    const id = positiveId(req.params.id, '业务组');
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [[group]] = await connection.execute(
      'SELECT id, manager_user_id FROM business_groups WHERE id = ? LIMIT 1 FOR UPDATE',
      [id],
    );
    if (!group) throw httpError(404, '业务组不存在', 'BUSINESS_GROUP_NOT_FOUND');

    const groupFields = [];
    const groupParams = [];
    const managerFields = [];
    const managerParams = [];
    if (req.body?.name !== undefined) {
      groupFields.push('name = ?');
      groupParams.push(text(req.body.name, '业务组名称', 128));
    }
    if (req.body?.status !== undefined) {
      if (!['active', 'disabled'].includes(req.body.status)) throw httpError(400, '业务组状态不正确');
      groupFields.push('status = ?');
      groupParams.push(req.body.status);
      managerFields.push('status = ?');
      managerParams.push(req.body.status);
    }
    if (req.body?.expiresAt !== undefined) {
      groupFields.push('expires_at = ?');
      groupParams.push(clientDateTime(req.body.expiresAt, '业务组到期时间'));
    }

    if (req.body?.managerName !== undefined) {
      managerFields.push('name = ?');
      managerParams.push(text(req.body.managerName, '管理员用户名', 128));
    }
    if (req.body?.managerPhone !== undefined) {
      managerFields.push('phone = ?');
      managerParams.push(text(req.body.managerPhone, '管理员登录手机', 32));
    }
    if (req.body?.expiresAt !== undefined) {
      managerFields.push('expires_at = ?');
      managerParams.push(clientDateTime(req.body.expiresAt, '管理员到期时间'));
    }
    if (req.body?.password) {
      const credentials = hashPassword(text(req.body.password, '管理员密码', 128));
      managerFields.push('password_salt = ?', 'password_hash = ?');
      managerParams.push(credentials.salt, credentials.hash);
    }

    if (!groupFields.length && !managerFields.length) throw httpError(400, '没有可更新的内容');
    if (managerFields.length && !group.manager_user_id) {
      throw httpError(409, '该业务组尚未指定管理员', 'BUSINESS_GROUP_MANAGER_MISSING');
    }

    if (groupFields.length) {
      await connection.execute(
        `UPDATE business_groups SET ${groupFields.join(', ')} WHERE id = ?`,
        [...groupParams, id],
      );
    }
    if (managerFields.length) {
      await connection.execute(
        `UPDATE users SET ${managerFields.join(', ')} WHERE id = ? AND role = 'business_manager'`,
        [...managerParams, group.manager_user_id],
      );
    }

    await connection.commit();
    res.json({ success: true, data: { id }, message: '业务组资料已更新' });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') {
      return next(httpError(409, '业务组名称或管理员手机号已存在', 'DUPLICATE_RECORD'));
    }
    next(error);
  } finally {
    connection?.release();
  }
}

async function listUsers(req, res, next) {
  try {
    const role = req.query.role;
    const params = [];
    const conditions = [];
    if (role && ROLES.includes(role)) { conditions.push('u.role = ?'); params.push(role); }
    if (req.auth.role === 'business_manager') {
      conditions.push('u.business_group_id = ?'); params.push(req.auth.business_group_id || 0);
      conditions.push("u.role = 'general_user'");
    } else if (req.auth.role === 'system_admin') {
      conditions.push("u.role IN ('business_manager','general_user')");
    } else if (req.auth.role !== 'super_admin') {
      conditions.push('u.business_group_id = ?'); params.push(req.auth.business_group_id || 0);
      conditions.push("u.role IN ('business_manager','general_user')");
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.phone, u.role, u.business_group_id, u.status,
              u.expires_at, u.created_at, bg.name AS business_group_name
       FROM users u LEFT JOIN business_groups bg ON bg.id = u.business_group_id
       ${where} ORDER BY u.created_at DESC`, params,
    );
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
}

async function saveUser(req, res, next) {
  try {
    const name = text(req.body?.name, '用户名', 128);
    const phone = text(req.body?.phone, '登录账号', 32);
    const password = text(req.body?.password, '登录密码', 128);
    let role = req.body?.role || 'general_user';
    if (!ROLES.includes(role)) throw httpError(400, '账号角色不正确');
    if (req.auth.role === 'business_manager') role = 'general_user';
    if (req.auth.role !== 'super_admin' && !USER_ROLES.includes(role)) {
      throw httpError(403, '只有超级管理员可以创建系统管理员', 'PERMISSION_DENIED');
    }
    const businessGroupId = role === 'general_user' || role === 'business_manager'
      ? positiveId(req.auth.role === 'business_manager' ? req.auth.business_group_id : req.body?.businessGroupId, '业务组')
      : null;
    const credentials = hashPassword(password);
    const expiresAt = clientDateTime(req.body?.expiresAt, '账号到期时间');
    const [result] = await pool.execute(
      `INSERT INTO users
         (name, phone, password_salt, password_hash, role, business_group_id, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [name, phone, credentials.salt, credentials.hash, role, businessGroupId, expiresAt],
    );
    res.status(201).json({ success: true, data: { id: result.insertId }, message: '账号添加成功' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return next(httpError(409, '登录手机号已存在', 'DUPLICATE_RECORD'));
    next(error);
  }
}

async function updateUser(req, res, next) {
  try {
    const id = positiveId(req.params.id);
    await requireScopedRecord(req.auth, 'users', id);
    const [[target]] = await pool.execute(
      'SELECT role, business_group_id FROM users WHERE id = ? LIMIT 1',
      [id],
    );
    if (!target) throw httpError(404, '账号不存在', 'USER_NOT_FOUND');
    if (target && ['super_admin', 'system_admin'].includes(target.role) && req.auth.role !== 'super_admin') {
      throw httpError(403, '只有超级管理员可以管理系统管理员', 'PERMISSION_DENIED');
    }
    if (req.auth.role === 'business_manager' && target?.role !== 'general_user') {
      throw httpError(403, '业务组管理员只能管理一般用户', 'PERMISSION_DENIED');
    }
    const fields = [];
    const params = [];
    if (req.body?.name !== undefined) { fields.push('name = ?'); params.push(text(req.body.name, '用户名', 128)); }
    if (req.body?.phone !== undefined) { fields.push('phone = ?'); params.push(text(req.body.phone, '登录手机号', 32)); }
    if (req.body?.businessGroupId !== undefined) {
      if (!USER_ROLES.includes(target.role)) {
        throw httpError(400, '平台管理员不能设置所属业务组');
      }
      if (target.role === 'business_manager') {
        throw httpError(400, '业务组管理员请通过业务组编辑调整归属');
      }
      if (req.auth.role === 'business_manager') {
        throw httpError(403, '业务组管理员不能调整账号所属业务组', 'PERMISSION_DENIED');
      }
      const businessGroupId = positiveId(req.body.businessGroupId, '业务组');
      const [[group]] = await pool.execute(
        'SELECT id FROM business_groups WHERE id = ? LIMIT 1',
        [businessGroupId],
      );
      if (!group) throw httpError(404, '业务组不存在', 'BUSINESS_GROUP_NOT_FOUND');
      fields.push('business_group_id = ?'); params.push(businessGroupId);
    }
    if (req.body?.status !== undefined) {
      if (!['active', 'disabled'].includes(req.body.status)) throw httpError(400, '账号状态不正确');
      fields.push('status = ?'); params.push(req.body.status);
    }
    if (req.body?.expiresAt !== undefined) {
      fields.push('expires_at = ?');
      params.push(clientDateTime(req.body.expiresAt, '账号到期时间'));
    }
    if (req.body?.password) {
      const credentials = hashPassword(text(req.body.password, '登录密码', 128));
      fields.push('password_salt = ?', 'password_hash = ?'); params.push(credentials.salt, credentials.hash);
    }
    if (!fields.length) throw httpError(400, '没有可更新的内容');
    params.push(id);
    try {
      await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw httpError(409, '登录手机号已存在', 'DUPLICATE_RECORD');
      throw error;
    }
    res.json({ success: true, data: { id }, message: '账号资料已更新' });
  } catch (error) { next(error); }
}

async function deleteUser(req, res, next) {
  try {
    const id = positiveId(req.params.id);
    await requireScopedRecord(req.auth, 'users', id);
    const [[target]] = await pool.execute('SELECT role FROM users WHERE id = ? LIMIT 1', [id]);
    if (target && ['super_admin', 'system_admin'].includes(target.role) && req.auth.role !== 'super_admin') {
      throw httpError(403, '只有超级管理员可以管理系统管理员', 'PERMISSION_DENIED');
    }
    if (req.auth.role === 'business_manager' && target?.role !== 'general_user') {
      throw httpError(403, '业务组管理员只能管理一般用户', 'PERMISSION_DENIED');
    }
    if (String(req.auth.id) === id) throw httpError(409, '不能删除当前登录账号', 'ACCOUNT_IN_USE');
    await pool.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
    res.json({ success: true, data: { id }, message: '账号已停用' });
  } catch (error) { next(error); }
}

async function listMaterialGroups(req, res, next) {
  try {
    const params = [];
    let where = '';
    if (!['super_admin', 'system_admin'].includes(req.auth.role)) {
      where = 'WHERE mg.business_group_id = ?'; params.push(req.auth.business_group_id || 0);
    } else if (req.query.businessGroupId) {
      where = 'WHERE mg.business_group_id = ?'; params.push(positiveId(req.query.businessGroupId, '业务组'));
    }
    const [rows] = await pool.execute(
      `SELECT mg.*, bg.name AS business_group_name,
              (SELECT COUNT(*) FROM videos v WHERE v.material_group_id = mg.id AND v.status <> 'deleted') AS material_count
       FROM material_groups mg LEFT JOIN business_groups bg ON bg.id = mg.business_group_id
       ${where} ORDER BY mg.created_at DESC`, params,
    );
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
}

async function saveMaterialGroup(req, res, next) {
  try {
    const businessGroupId = positiveId(
      ['super_admin', 'system_admin'].includes(req.auth.role) ? req.body?.businessGroupId : req.auth.business_group_id,
      '业务组',
    );
    const name = text(req.body?.name, '素材组名称', 128);
    const [result] = await pool.execute(
      `INSERT INTO material_groups (business_group_id, name, is_enabled) VALUES (?, ?, 1)`,
      [businessGroupId, name],
    );
    res.status(201).json({ success: true, data: { id: result.insertId }, message: '素材组添加成功' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return next(httpError(409, '该业务组下已存在同名素材组', 'DUPLICATE_RECORD'));
    next(error);
  }
}

async function updateMaterialGroup(req, res, next) {
  try {
    const id = positiveId(req.params.id);
    await requireScopedRecord(req.auth, 'material_groups', id);
    const fields = [];
    const params = [];
    if (req.body?.name !== undefined) { fields.push('name = ?'); params.push(text(req.body.name, '素材组名称', 128)); }
    if (req.body?.isEnabled !== undefined) { fields.push('is_enabled = ?'); params.push(req.body.isEnabled ? 1 : 0); }
    if (!fields.length) throw httpError(400, '没有可更新的内容');
    params.push(id);
    await pool.execute(`UPDATE material_groups SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, data: { id }, message: '素材组已更新' });
  } catch (error) { next(error); }
}

async function deleteMaterialGroup(req, res, next) {
  try {
    const id = positiveId(req.params.id);
    await requireScopedRecord(req.auth, 'material_groups', id);
    const [[usage]] = await pool.execute("SELECT COUNT(*) AS total FROM videos WHERE material_group_id = ? AND status <> 'deleted'", [id]);
    if (Number(usage.total) > 0) throw httpError(409, '素材组内仍有素材，不能删除', 'GROUP_IN_USE');
    await pool.execute('DELETE FROM material_groups WHERE id = ?', [id]);
    res.json({ success: true, data: { id }, message: '素材组已删除' });
  } catch (error) { next(error); }
}

async function listMaterials(req, res, next) {
  try {
    const scope = scopeSql(req.auth);
    const promoterId = req.auth?.role === 'general_user' ? req.auth.id : null;
    const statisticsJoin = promoterId
      ? `LEFT JOIN short_links scoped_links
           ON scoped_links.video_id = v.id AND scoped_links.created_by = ?
         LEFT JOIN play_logs pl ON pl.short_link_id = scoped_links.id`
      : 'LEFT JOIN play_logs pl ON pl.video_id = v.id';
    const params = promoterId ? [promoterId, ...scope.params] : [...scope.params];
    let filters = scope.sql;
    if (req.query.businessGroupId && ['super_admin', 'system_admin'].includes(req.auth.role)) {
      filters += ' AND v.business_group_id = ?'; params.push(positiveId(req.query.businessGroupId, '业务组'));
    }
    if (req.query.materialGroupId) { filters += ' AND v.material_group_id = ?'; params.push(positiveId(req.query.materialGroupId, '素材组')); }
    if (req.query.keyword) { filters += ' AND (v.title LIKE ? OR v.description LIKE ?)'; const keyword = `%${String(req.query.keyword).slice(0, 100)}%`; params.push(keyword, keyword); }
    const [rows] = await pool.execute(
      `SELECT v.id, v.file_id, v.title, v.description, v.cover_url, v.video_url, v.duration,
              v.status, v.expires_at, v.created_at, v.business_group_id, v.material_group_id,
              bg.name AS business_group_name, mg.name AS material_group_name,
              SUM(pl.event_type = 'start') AS play_count,
              SUM(pl.event_type = 'complete') AS complete_count
       FROM videos v
       LEFT JOIN business_groups bg ON bg.id = v.business_group_id
       LEFT JOIN material_groups mg ON mg.id = v.material_group_id
       ${statisticsJoin}
       WHERE v.status <> 'deleted'${filters}
       GROUP BY v.id ORDER BY v.created_at DESC`, params,
    );
    if (!rows.length) return res.json({ success: true, data: [] });
    const ids = rows.map((row) => row.id);
    const [links] = await pool.query(
      `SELECT sl.id, sl.video_id, sl.short_url, sl.long_url, sl.status, sl.clicks, sl.created_at,
              sl.card_token, sl.card_title, sl.card_description, sl.card_cover_url, sl.card_status,
              sl.wechat_card_mode,
              COALESCE(sl.platform, d.platform,
                CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
              ) AS platform
       FROM short_links sl
       INNER JOIN domains d ON d.id = sl.domain_id
       WHERE sl.video_id IN (?)${promoterId ? ' AND sl.created_by = ?' : ''}
       ORDER BY sl.created_at DESC`,
      promoterId ? [ids, promoterId] : [ids],
    );
    const byVideo = new Map();
    for (const link of links) {
      const key = String(link.video_id);
      if (!byVideo.has(key)) byVideo.set(key, []);
      byVideo.get(key).push(link);
    }
    res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        play_count: Number(row.play_count || 0),
        complete_count: Number(row.complete_count || 0),
        completion_rate: Number(row.play_count) ? Math.round((Number(row.complete_count) / Number(row.play_count)) * 100) : 0,
        short_links: (byVideo.get(String(row.id)) || []).map((link) => ({
          ...link,
          card_status: link.card_status || 'draft',
          wechat_card_mode: link.wechat_card_mode || 'standard',
          needs_regeneration: link.platform === 'suolink'
            && (!link.card_token || !new RegExp(`/card/${String(link.card_token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\?)`).test(String(link.long_url || ''))),
        })),
      })),
    });
  } catch (error) { next(error); }
}

async function updateMaterial(req, res, next) {
  try {
    const id = positiveId(req.params.id);
    const current = await requireScopedRecord(req.auth, 'videos', id);
    const platformAdmin = ['super_admin', 'system_admin'].includes(req.auth.role);
    if (req.body?.businessGroupId !== undefined && !platformAdmin) {
      throw httpError(403, '只有平台管理员可以调整素材所属业务组', 'PERMISSION_DENIED');
    }
    const fields = [];
    const params = [];
    if (req.body?.title !== undefined) { fields.push('title = ?'); params.push(text(req.body.title, '素材名称', 255)); }
    if (req.body?.description !== undefined) { fields.push('description = ?'); params.push(text(req.body.description, '素材简介', 2000, true)); }
    const businessGroupId = req.body?.businessGroupId !== undefined
      ? positiveId(req.body.businessGroupId, '业务组', true)
      : current.business_group_id;
    const materialGroupId = req.body?.materialGroupId !== undefined
      ? positiveId(req.body.materialGroupId, '素材组', true)
      : current.material_group_id;
    if (materialGroupId) {
      const [groups] = await pool.execute(
        'SELECT id FROM material_groups WHERE id = ? AND business_group_id = ? LIMIT 1',
        [materialGroupId, businessGroupId || 0],
      );
      if (!groups.length) throw httpError(400, '所选素材组不属于当前业务组');
    }
    if (req.body?.businessGroupId !== undefined) { fields.push('business_group_id = ?'); params.push(businessGroupId); }
    if (req.body?.materialGroupId !== undefined) { fields.push('material_group_id = ?'); params.push(materialGroupId); }
    if (req.body?.status !== undefined) {
      if (!['ready', 'disabled'].includes(req.body.status)) throw httpError(400, '素材状态不正确');
      fields.push('status = ?'); params.push(req.body.status);
    }
    if (!fields.length) throw httpError(400, '没有可更新的内容');
    params.push(id);
    await pool.execute(`UPDATE videos SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, data: { id }, message: '素材已更新' });
  } catch (error) { next(error); }
}

async function uploadMaterialCardCover(req, res, next) {
  let persisted = false;
  try {
    const id = positiveId(req.params.id);
    await requireScopedRecord(req.auth, 'videos', id);
    const [[material]] = await pool.execute(
      'SELECT cover_url FROM videos WHERE id = ? LIMIT 1',
      [id],
    );
    if (!material) throw httpError(404, '素材不存在', 'MATERIAL_NOT_FOUND');

    const cover = await processCardCover(req.file);
    const coverUrl = cover.publicPath;
    await pool.execute('UPDATE videos SET cover_url = ? WHERE id = ?', [coverUrl, id]);
    persisted = true;
    if (material.cover_url !== coverUrl) await removeCardCover(material.cover_url).catch(() => {});
    await synchronizeVideoCoverToShortLinks(id, material.cover_url, coverUrl, req);

    res.json({
      success: true,
      data: {
        id,
        coverUrl,
        cover_url: coverUrl,
        dimensions: cover.dimensions,
        size: cover.size,
      },
      message: '卡片图片已更新',
    });
  } catch (error) {
    if (req.file && !persisted) await removeCardCover(req.file).catch(() => {});
    next(error);
  }
}

async function getScopedShortLink(user, id) {
  const scope = scopeSql(user);
  const ownLinkScope = promoterLinkScope(user);
  const [rows] = await pool.execute(
    `SELECT sl.id, sl.video_id, sl.short_code, sl.long_url, sl.short_url, sl.card_token,
            sl.card_title, sl.card_description, sl.card_cover_url, sl.card_status,
            sl.wechat_card_mode,
            sl.status, sl.expires_at, d.domain,
            COALESCE(sl.platform, d.platform, CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END) AS platform,
            v.business_group_id, v.title AS video_title,
            v.description AS video_description, v.cover_url AS video_cover_url
     FROM short_links sl
     INNER JOIN videos v ON v.id = sl.video_id
     INNER JOIN domains d ON d.id = sl.domain_id
     WHERE sl.id = ?${scope.sql}${ownLinkScope.sql}
     LIMIT 1`,
    [id, ...scope.params, ...ownLinkScope.params],
  );
  if (!rows[0]) throw httpError(403, '只能编辑本业务组的短链卡片', 'PERMISSION_DENIED');
  return rows[0];
}

async function synchronizeShortLinkCard(link, req, values = {}) {
  if (
    link.status !== 'active'
    || link.wechat_card_mode === 'text_description'
    || !cloudflareShortLinkService.isManagedDomain(link.domain)
  ) return null;
  return cloudflareShortLinkService.upsertMapping(link.short_code, {
    targetUrl: link.long_url,
    ogTitle: values.title ?? link.card_title ?? link.video_title ?? '视频播放',
    ogDescription: values.description
      ?? link.card_description
      ?? link.video_description
      ?? '点击查看视频素材',
    ogImage: toPublicHttpsUrl(
      values.coverUrl ?? link.card_cover_url ?? link.video_cover_url,
      req,
    ),
    ogUrl: link.short_url,
    expiresAt: link.expires_at,
  });
}

async function synchronizeVideoCoverToShortLinks(videoId, previousCoverUrl, coverUrl, req) {
  const [links] = await pool.execute(
    `SELECT sl.id, sl.short_code, sl.short_url, sl.long_url, sl.card_title,
            sl.card_description, sl.card_cover_url, sl.card_status,
            sl.wechat_card_mode, sl.status, sl.expires_at,
            d.domain, v.title AS video_title, v.description AS video_description
     FROM short_links sl
     INNER JOIN domains d ON d.id = sl.domain_id
     INNER JOIN videos v ON v.id = sl.video_id
     WHERE sl.video_id = ?
       AND sl.status = 'active'`,
    [videoId],
  );

  for (const link of links) {
    // A draft link follows the material cover. A ready link may have an
    // intentionally different card cover and must remain untouched.
    const followsVideoCover = !link.card_cover_url
      || link.card_status !== 'ready'
      || link.card_cover_url === previousCoverUrl;
    const effectiveCover = followsVideoCover ? coverUrl : link.card_cover_url;
    if (followsVideoCover) {
      await pool.execute(
        'UPDATE short_links SET card_cover_url = ? WHERE id = ?',
        [coverUrl, link.id],
      );
    }
    if (
      link.wechat_card_mode !== 'text_description'
      && cloudflareShortLinkService.isManagedDomain(link.domain)
    ) {
      try {
        await cloudflareShortLinkService.upsertMapping(link.short_code, {
          targetUrl: link.long_url,
          ogTitle: link.card_title || link.video_title || '视频播放',
          ogDescription: link.card_description || link.video_description || '点击查看视频素材',
          ogImage: toPublicHttpsUrl(effectiveCover, req),
          ogUrl: link.short_url,
          expiresAt: link.expires_at,
        });
      } catch (error) {
        logger.warn('video_cover_short_link_sync_failed', {
          videoId,
          shortLinkId: link.id,
          shortCode: link.short_code,
          code: error.code || 'CLOUDFLARE_SYNC_FAILED',
        });
      }
    }
  }
}

function isCardTarget(longUrl, cardToken, platform) {
  return platform === 'self' || Boolean(cardToken)
    && new RegExp(`/card/${String(cardToken).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\?)`).test(String(longUrl || ''));
}

function normalizeCardCoverValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^\/api\/media\/share-cards\/(?:[0-9a-f-]{36}|[0-9a-f]{64})\.(jpg|png|webp)$/i.test(normalized)) return normalized;
  let url;
  try { url = new URL(normalized); } catch { throw httpError(400, '卡片封面地址必须是 HTTPS 图片地址'); }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || isPrivateHostname(url.hostname)
  ) {
    throw httpError(400, '卡片封面地址必须是 HTTPS 图片地址');
  }
  return url.toString();
}

async function updateShortLinkCard(req, res, next) {
  try {
    const id = positiveId(req.params.id, 'shortLinkId');
    const link = await getScopedShortLink(req.auth, id);
    if (!isCardTarget(link.long_url, link.card_token, link.platform)) {
      throw httpError(409, '此短链仍直接指向 /play，需重新生成', 'SHORT_LINK_REGENERATE_REQUIRED');
    }
    const title = text(req.body?.title, '卡片标题', 255);
    const description = text(req.body?.description, '卡片描述', 2000);
    const coverUrl = link.wechat_card_mode === 'text_description'
      ? link.card_cover_url
      : req.body?.coverUrl === undefined
      ? link.card_cover_url
      : normalizeCardCoverValue(req.body.coverUrl);
    await pool.execute(
      `UPDATE short_links
       SET card_title = ?, card_description = ?, card_cover_url = ?, card_status = 'ready'
       WHERE id = ?`,
      [title, description, coverUrl, id],
    );
    await synchronizeShortLinkCard(link, req, { title, description, coverUrl });
    res.json({
      success: true,
      data: { id, cardToken: link.card_token, cardStatus: 'ready', cardUrl: link.short_url },
      message: '卡片已保存',
    });
  } catch (error) { next(error); }
}

async function uploadShortLinkCardCover(req, res, next) {
  let persisted = false;
  try {
    const id = positiveId(req.params.id, 'shortLinkId');
    const link = await getScopedShortLink(req.auth, id);
    if (link.wechat_card_mode === 'text_description') {
      throw httpError(
        409,
        '纯文字实验短链不接受封面；请生成新的标准图文短链使用图片',
        'TEXT_DESCRIPTION_COVER_FORBIDDEN',
      );
    }
    if (!isCardTarget(link.long_url, link.card_token, link.platform)) {
      throw httpError(409, '此短链仍直接指向 /play，需重新生成', 'SHORT_LINK_REGENERATE_REQUIRED');
    }
    const cover = await processCardCover(req.file);
    const coverUrl = cover.publicPath;
    await pool.execute(
      `UPDATE short_links SET card_cover_url = ?, card_status = 'draft' WHERE id = ?`,
      [coverUrl, id],
    );
    persisted = true;
    await synchronizeShortLinkCard(link, req, { coverUrl });
    if (link.card_cover_url !== coverUrl) await removeCardCover(link.card_cover_url).catch(() => {});
    res.json({
      success: true,
      data: {
        id,
        coverUrl,
        cover_url: coverUrl,
        dimensions: cover.dimensions,
        size: cover.size,
      },
      message: '卡片封面已上传',
    });
  } catch (error) {
    if (req.file && !persisted) await removeCardCover(req.file).catch(() => {});
    next(error);
  }
}

async function expiringUsers(req, res, next) {
  try {
    const params = [];
    let scope = '';
    if (!['super_admin', 'system_admin'].includes(req.auth.role)) { scope = ' AND u.business_group_id = ?'; params.push(req.auth.business_group_id || 0); }
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.phone, u.role, u.status, u.created_at, u.expires_at,
              bg.name AS business_group_name, DATEDIFF(u.expires_at, NOW()) AS remaining_days
       FROM users u LEFT JOIN business_groups bg ON bg.id = u.business_group_id
       WHERE u.role IN ('business_manager','general_user')
         AND u.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 15 DAY)${scope}
       ORDER BY u.expires_at ASC`, params,
    );
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
}

function requireSuperAdmin(req) {
  if (req.auth?.role !== 'super_admin') {
    throw httpError(403, '只有超级管理员可以管理访问量', 'PERMISSION_DENIED');
  }
}

async function getVisitQuotas(req, res, next) {
  try {
    requireSuperAdmin(req);
    const data = await visitQuotaService.listGroupQuotas();
    res.json({ success: true, data });
  } catch (error) { next(error); }
}

async function getMyVisitQuota(req, res, next) {
  try {
    if (!req.auth.business_group_id) {
      throw httpError(403, '当前账号未绑定业务组', 'BUSINESS_GROUP_REQUIRED');
    }
    const data = await visitQuotaService.getGroupQuota(req.auth.business_group_id);
    res.json({ success: true, data });
  } catch (error) { next(error); }
}

function resolveQuotaGroupId(req) {
  const requested = req.body?.businessGroupId ?? req.body?.business_group_id;
  if (['super_admin', 'system_admin'].includes(req.auth?.role)) return requested;
  if (req.auth?.role !== 'business_manager' || !req.auth.business_group_id) {
    throw httpError(403, '当前账号未绑定可管理的业务组', 'BUSINESS_GROUP_REQUIRED');
  }
  if (requested !== undefined && String(requested) !== String(req.auth.business_group_id)) {
    throw httpError(403, '业务组管理员只能管理本业务组额度', 'PERMISSION_DENIED');
  }
  return req.auth.business_group_id;
}

async function addVisitQuota(req, res, next) {
  try {
    requireSuperAdmin(req);
    const data = await visitQuotaService.addExtraQuota(
      resolveQuotaGroupId(req),
      req.body?.additionalQuota ?? req.body?.additional_quota,
    );
    res.json({
      success: true,
      data,
      message: '业务组本月访问量上限已增加',
    });
  } catch (error) { next(error); }
}

async function updateVisitQuotaBase(req, res, next) {
  try {
    requireSuperAdmin(req);
    const data = await visitQuotaService.updateBaseQuota(
      resolveQuotaGroupId(req),
      req.body?.baseQuota ?? req.body?.base_quota,
    );
    res.json({
      success: true,
      data,
      message: '当前自然月基础额度已立即更新',
    });
  } catch (error) { next(error); }
}

async function updateVisitQuotaPerEmployee(req, res, next) {
  try {
    requireSuperAdmin(req);
    const perEmployee = await visitQuotaService.updatePerEmployeeQuota(
      req.body?.perEmployee ?? req.body?.per_employee,
    );
    res.json({
      success: true,
      data: { perEmployee },
      message: '每位有效推广员的月度访问量已更新，将从下个自然月生效',
    });
  } catch (error) { next(error); }
}

function normalizeCustomerBaseUrl(value) {
  const raw = text(value, '客户链接', 255);
  let url;

  try { url = new URL(raw); }
  catch { throw httpError(400, '客户链接必须是完整的 http/https 地址'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw httpError(400, '客户链接仅支持 http 或 https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw httpError(400, '客户链接不能包含账号、参数或锚点');
  }
  if (url.pathname && url.pathname !== '/') {
    throw httpError(400, '请填写域名根地址，例如 https://video.example.com');
  }

  return `${url.protocol}//${url.host}`;
}

async function getCustomerLink(req, res, next) {
  void req;
  try {
    const configuredUrl = await getCustomerBaseUrl();
    const [[stored]] = await pool.execute(
      `SELECT config_value FROM system_configs
       WHERE config_key = 'customer_base_url' LIMIT 1`,
    );
    res.json({
      success: true,
      data: {
        url: configuredUrl,
        isCustom: Boolean(stored?.config_value),
        playExample: configuredUrl ? `${configuredUrl}/play?fileId=腾讯云FileId` : null,
        shortLinkExample: configuredUrl ? `${configuredUrl}/s/Ab12Cd` : null,
      },
    });
  } catch (error) { next(error); }
}

async function saveCustomerLink(req, res, next) {
  let connection;
  try {
    const baseUrl = normalizeCustomerBaseUrl(req.body?.url);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO system_configs (config_key, config_value)
       VALUES ('customer_base_url', ?)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
      [baseUrl],
    );

    const [sameDomainRows] = await connection.execute(
      `SELECT id FROM domains
       WHERE domain = ? AND platform = 'self' LIMIT 1 FOR UPDATE`,
      [baseUrl],
    );
    let domainId = sameDomainRows[0]?.id;

    if (!domainId) {
      const [result] = await connection.execute(
        `INSERT INTO domains
           (domain, type, platform, is_primary, is_enabled, remark)
         VALUES (?, 'self_hosted', 'self', 0, 1, '通过兼容接口加入的客户域名')`,
        [baseUrl],
      );
      domainId = result.insertId;
    }

    await connection.execute('UPDATE domains SET is_enabled = 1 WHERE id = ?', [domainId]);
    const [[primary]] = await connection.execute(
      `SELECT id FROM domains WHERE is_primary = 1 LIMIT 1 FOR UPDATE`,
    );
    if (!primary) {
      await connection.execute('UPDATE domains SET is_primary = (id = ?)', [domainId]);
      await connection.execute(
        `INSERT INTO system_configs (config_key, config_value)
         VALUES ('primary_domain_id', ?), ('shortlink_platform', 'self')
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [domainId],
      );
    }
    await connection.commit();

    res.json({
      success: true,
      data: {
        url: baseUrl,
        domainId,
        playExample: `${baseUrl}/play?fileId=腾讯云FileId`,
        shortLinkExample: `${baseUrl}/s/Ab12Cd`,
      },
      message: '客户域名已加入域名池',
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') {
      return next(httpError(409, '该客户链接已存在，请在域名管理中确认状态', 'DUPLICATE_RECORD'));
    }
    next(error);
  } finally { connection?.release(); }
}

module.exports = {
  login, me, dashboard, listBusinessGroups, saveBusinessGroup, updateBusinessGroup,
  listUsers, saveUser, updateUser, deleteUser,
  listMaterialGroups, saveMaterialGroup, updateMaterialGroup, deleteMaterialGroup,
  listMaterials, updateMaterial, uploadMaterialCardCover,
  updateShortLinkCard, uploadShortLinkCardCover, expiringUsers,
  getVisitQuotas, getMyVisitQuota, addVisitQuota, updateVisitQuotaBase, updateVisitQuotaPerEmployee,
  resolveQuotaGroupId,
  getCustomerLink, saveCustomerLink,
};
