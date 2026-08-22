const pool = require('../config/db');
const { verifyToken } = require('../services/authService');

function authError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function authenticate(req, res, next) {
  try {
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);

    if (!payload) {
      throw authError(401, '登录状态已失效，请重新登录', 'AUTH_REQUIRED');
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.phone, u.role, u.business_group_id,
              u.status, u.expires_at, bg.name AS business_group_name
       FROM users u
       LEFT JOIN business_groups bg ON bg.id = u.business_group_id
       WHERE u.id = ? LIMIT 1`,
      [payload.sub],
    );
    const user = rows[0];

    if (!user || user.status !== 'active') {
      throw authError(403, '账号已停用', 'ACCOUNT_DISABLED');
    }

    if (user.expires_at && new Date(user.expires_at).getTime() <= Date.now()) {
      throw authError(403, '账号已到期', 'ACCOUNT_EXPIRED');
    }

    req.auth = user;
    next();
  } catch (error) {
    next(error);
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      next(authError(403, '当前账号没有此操作权限', 'PERMISSION_DENIED'));
      return;
    }
    next();
  };
}

module.exports = { authenticate, allowRoles };
