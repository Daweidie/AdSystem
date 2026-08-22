const pool = require('../config/db');
const axios = require('axios');
const suolinkService = require('../services/suolinkService');
const { decryptSecret, encryptSecret, maskSecret } = require('../services/secretConfigService');

function createHttpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeDomainId(value) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw createHttpError(400, 'domainId 必须是正整数', 'DOMAIN_VALIDATION_ERROR');
  }

  return String(value);
}

function normalizeDomainPayload(body, current = {}) {
  const type = String(body?.type ?? current.type ?? '').trim();
  const platform = String(body?.platform ?? current.platform ?? '').trim();
  const rawDomain = String(body?.domain ?? body?.baseUrl ?? current.domain ?? '').trim();
  const expectedPlatform = type === 'self_hosted'
    ? 'self'
    : type === 'suolink'
      ? 'suolink'
      : null;

  if (!expectedPlatform) {
    throw createHttpError(
      400,
      'type 仅支持 self_hosted 或 suolink',
      'DOMAIN_VALIDATION_ERROR',
    );
  }

  if (platform !== expectedPlatform) {
    throw createHttpError(
      400,
      `type=${type} 时 platform 必须为 ${expectedPlatform}`,
      'DOMAIN_PLATFORM_MISMATCH',
    );
  }

  let parsed;

  try {
    parsed = new URL(rawDomain);
  } catch {
    throw createHttpError(
      400,
      '域名必须是包含 http:// 或 https:// 的合法 base URL',
      'DOMAIN_VALIDATION_ERROR',
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw createHttpError(
      400,
      '域名仅支持不含账号信息的 http/https URL',
      'DOMAIN_VALIDATION_ERROR',
    );
  }

  if (parsed.search || parsed.hash) {
    throw createHttpError(
      400,
      '域名 base URL 不能包含查询参数或片段',
      'DOMAIN_VALIDATION_ERROR',
    );
  }

  if (
    /your[_-]?short[_-]?domain|example\.(com|cn)|replace[_-]?with|changeme/i.test(
      parsed.hostname,
    )
  ) {
    throw createHttpError(400, '域名不能使用示例或占位值', 'DOMAIN_PLACEHOLDER');
  }

  if (parsed.pathname !== '/') {
    throw createHttpError(
      400,
      '域名池地址不能包含路径，请填写域名根地址',
      'DOMAIN_VALIDATION_ERROR',
    );
  }

  const normalizedDomain = parsed.toString().replace(/\/$/, '');
  const remark = body?.remark === undefined
    ? current.remark ?? null
    : String(body.remark || '').trim().slice(0, 500) || null;
  const isEnabled = body?.isEnabled ?? body?.is_enabled ?? current.is_enabled ?? true;

  if (typeof isEnabled !== 'boolean' && ![0, 1].includes(Number(isEnabled))) {
    throw createHttpError(400, 'isEnabled 必须是布尔值', 'DOMAIN_VALIDATION_ERROR');
  }

  return {
    domain: normalizedDomain,
    type,
    platform,
    remark,
    isEnabled: Boolean(Number(isEnabled)) || isEnabled === true,
  };
}

function isDuplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

async function getConfigRows(connection = pool) {
  const [rows] = await connection.execute(
    `SELECT config_key, config_value FROM system_configs
     WHERE config_key IN ('suolink_api_key', 'suolink_domain', 'suolink_enabled')`,
  );
  return Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
}

function validEnvironmentValue(value) {
  const normalized = String(value || '').trim();
  return normalized && !suolinkService.isPlaceholder(normalized) ? normalized : '';
}

function normalizeApiKey(value) {
  const apiKey = String(value || '').trim();
  if (!apiKey) return '';
  if (apiKey.length > 1024) {
    throw createHttpError(400, 'Suolink API Key 不能超过 1024 个字符', 'SUOLINK_CONFIG_INVALID');
  }
  if (suolinkService.isPlaceholder(apiKey)) {
    throw createHttpError(400, 'Suolink API Key 不能使用占位值', 'SUOLINK_CONFIG_INVALID');
  }
  return apiKey;
}

function normalizeSuolinkDomain(value) {
  try {
    return suolinkService.getDomain(value);
  } catch (error) {
    throw createHttpError(400, error.message, 'SUOLINK_CONFIG_INVALID');
  }
}

async function upsertConfig(connection, key, value) {
  await connection.execute(
    `INSERT INTO system_configs (config_key, config_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [key, value],
  );
}

async function getSuolinkConfig(req, res, next) {
  void req;
  try {
    const config = await getConfigRows();
    const storedKey = config.suolink_api_key ? decryptSecret(config.suolink_api_key) : '';
    const apiKey = storedKey || validEnvironmentValue(process.env.SUOLINK_API_KEY);
    const domain = config.suolink_domain || validEnvironmentValue(process.env.SUOLINK_DOMAIN);
    res.json({
      success: true,
      data: {
        enabled: config.suolink_enabled === '1',
        apiKeyConfigured: Boolean(apiKey),
        apiKeyMasked: maskSecret(apiKey),
        domain,
      },
    });
  } catch (error) { next(error); }
}

async function saveSuolinkConfig(req, res, next) {
  let connection;
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      throw createHttpError(400, 'enabled 必须是布尔值', 'SUOLINK_CONFIG_INVALID');
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const current = await getConfigRows(connection);
    const submittedKey = req.body?.apiKey === undefined ? '' : normalizeApiKey(req.body.apiKey);
    const storedKey = current.suolink_api_key ? decryptSecret(current.suolink_api_key) : '';
    const effectiveKey = submittedKey || storedKey || validEnvironmentValue(process.env.SUOLINK_API_KEY);
    const rawDomain = req.body?.domain === undefined
      ? current.suolink_domain || validEnvironmentValue(process.env.SUOLINK_DOMAIN)
      : String(req.body.domain || '').trim();
    const domain = rawDomain ? normalizeSuolinkDomain(rawDomain) : '';

    if (req.body.enabled && (!effectiveKey || !domain)) {
      throw createHttpError(
        400, '启用 Suolink 前必须填写 API Key 和域名', 'SUOLINK_CONFIG_INCOMPLETE',
      );
    }

    if (submittedKey) await upsertConfig(connection, 'suolink_api_key', encryptSecret(submittedKey));
    await upsertConfig(connection, 'suolink_domain', domain);
    await upsertConfig(connection, 'suolink_enabled', req.body.enabled ? '1' : '0');

    if (req.body.enabled) {
      // 配置的域名是后续 Suolink 链接的唯一生成域名；其他已启用域名
      // 继续保留历史记录，但不会参与新链接生成。
      const fullDomain = `https://${domain}`;
      await connection.execute(
        `INSERT INTO domains (domain, type, platform, is_primary, is_enabled, remark)
         VALUES (?, 'suolink', 'suolink', 0, 1, 'Suolink API 配置域名')
         ON DUPLICATE KEY UPDATE type = 'suolink', platform = 'suolink',
           is_enabled = 1, remark = VALUES(remark)`,
        [fullDomain],
      );
      const [[suolinkDomain]] = await connection.execute(
        `SELECT id FROM domains WHERE domain = ? AND platform = 'suolink' LIMIT 1 FOR UPDATE`,
        [fullDomain],
      );
      await setPrimary(connection, suolinkDomain.id, 'suolink');
    } else {
      // 全局停用 Suolink 时不再改写域名池启用状态；候选过滤由
      // suolink_enabled 配置决定，域名池保留以便重新启用时恢复。
      await connection.execute("UPDATE domains SET is_primary = 0 WHERE platform = 'suolink'");
      const [[selfDomain]] = await connection.execute(
        `SELECT id FROM domains WHERE platform = 'self' AND is_enabled = 1
         ORDER BY is_primary DESC, id ASC LIMIT 1 FOR UPDATE`,
      );
      if (!selfDomain) {
        throw createHttpError(409, '停用 Suolink 前至少需要一个启用的自建域名', 'SELF_DOMAIN_REQUIRED');
      }
      await setPrimary(connection, selfDomain.id, 'self');
    }

    await connection.commit();
    res.json({
      success: true,
      data: {
        enabled: req.body.enabled,
        apiKeyConfigured: Boolean(effectiveKey),
        apiKeyMasked: maskSecret(effectiveKey),
        domain,
      },
      message: req.body.enabled ? 'Suolink 缩链已启用' : 'Suolink 已停用，当前使用自建短链',
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally { connection?.release(); }
}

async function getOgDeliveryReadiness(req, res, next) {
  void req;
  try {
    const [[primaryDomain]] = await pool.execute(
      `SELECT id, domain, platform, is_enabled
       FROM domains WHERE is_primary = 1 LIMIT 1`,
    );
    const [[latestLink]] = await pool.execute(
      `SELECT sl.short_url, sl.long_url, sl.card_token, sl.card_title,
              sl.card_description, sl.card_cover_url, sl.status,
              d.platform, v.title AS video_title,
              v.description AS video_description, v.cover_url AS video_cover_url
       FROM short_links sl
       INNER JOIN domains d ON d.id = sl.domain_id
       INNER JOIN videos v ON v.id = sl.video_id
       WHERE sl.status = 'active'
       ORDER BY sl.id DESC LIMIT 1`,
    );

    let existingShortLinkReachable = false;
    let selfShortLinkMetadataReady = false;
    if (latestLink?.short_url) {
      try {
        const response = await axios.get(latestLink.short_url, {
          timeout: 8000,
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
          validateStatus: () => true,
        });
        const html = String(response.data || '');
        if (latestLink.platform === 'suolink') {
          const location = response.headers?.location
            ? new URL(response.headers.location, latestLink.short_url).toString()
            : '';
          existingShortLinkReachable = response.status === 302
            && location === latestLink.long_url
            && !suolinkService.isProviderNotFoundPage(html);
        } else {
          existingShortLinkReachable = response.status === 200;
          selfShortLinkMetadataReady = response.status === 200
            && /property=["']og:title["']/i.test(html)
            && /property=["']og:description["']/i.test(html)
            && /property=["']og:image["']/i.test(html);
        }
      } catch {
        existingShortLinkReachable = false;
      }
    }

    let landingReachable = false;
    let shareMetadataReady = false;
    if (latestLink?.long_url) {
      try {
        const response = await axios.get(latestLink.long_url, {
          timeout: 8000,
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
          validateStatus: () => true,
        });
        const html = String(response.data || '');
        landingReachable = response.status === 200;
        shareMetadataReady = landingReachable
          && /property=["']og:title["']/i.test(html)
          && /property=["']og:description["']/i.test(html)
          && /property=["']og:image["']/i.test(html);
      } catch {
        landingReachable = false;
      }
    }

    const checks = {
      shortLinkServiceConfigured: Boolean(primaryDomain?.is_enabled),
      existingShortLinkReachable,
      landingReachable,
      shareMetadataReady,
      selfShortLinkMetadataReady: latestLink?.platform === 'suolink'
        ? true
        : selfShortLinkMetadataReady,
      shortLinkHttps: Boolean(latestLink?.short_url && /^https:\/\//i.test(latestLink.short_url)),
      landingHttps: Boolean(latestLink?.long_url && /^https:\/\//i.test(latestLink.long_url)),
      cardTargetReady: Boolean(
        latestLink?.card_token
          && /\/card\/[A-Za-z0-9_-]{20,128}\/?(?:$|\?)/.test(latestLink.long_url || ''),
      ),
      serverOgMode: true,
    };

    return res.json({
      success: true,
      data: {
        checkedAt: new Date().toISOString(),
        checks,
        allReady: Object.values(checks).every(Boolean),
        current: {
          primaryDomain: primaryDomain?.domain || '',
          latestShortUrl: latestLink?.short_url || '',
          landingUrl: latestLink?.long_url || '',
        },
        diagnostics: {},
      },
      message: 'Open Graph 投放链路检测完成',
    });
  } catch (error) { return next(error); }
}

async function setPrimary(connection, domainId, platform) {
  await connection.execute('UPDATE domains SET is_primary = 0 WHERE is_primary = 1');
  await connection.execute('UPDATE domains SET is_primary = 1 WHERE id = ?', [domainId]);
  await connection.execute(
    `INSERT INTO system_configs (config_key, config_value)
     VALUES ('primary_domain_id', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [domainId],
  );
  await connection.execute(
    `INSERT INTO system_configs (config_key, config_value)
     VALUES ('shortlink_platform', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [platform],
  );
}

async function switchDomain(req, res, next) {
  let connection;
  let transactionFinished = false;

  try {
    const domainId = normalizeDomainId(req.body?.domainId);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 锁住域名集合，确保并发切换时最多只有一个主域名。
    await connection.execute('SELECT id FROM domains FOR UPDATE');
    const [rows] = await connection.execute(
      `SELECT id, domain, type,
              COALESCE(platform,
                CASE WHEN type = 'suolink' THEN 'suolink' ELSE 'self' END
              ) AS platform,
              is_enabled
       FROM domains
       WHERE id = ?
       LIMIT 1`,
      [domainId],
    );
    const domain = rows[0];

    if (!domain) {
      throw createHttpError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    }

    if (!domain.is_enabled) {
      throw createHttpError(409, '已停用的域名不能设为主域名', 'DOMAIN_DISABLED');
    }

    await setPrimary(connection, domainId, domain.platform);
    await connection.commit();
    transactionFinished = true;

    res.json({
      success: true,
      data: {
        ...domain,
        is_primary: 1,
      },
      message: `主域名切换成功，短链服务已切换为 ${
        domain.platform === 'suolink' ? '缩链' : '自建'
      }`,
    });
  } catch (error) {
    if (connection && !transactionFinished) {
      await connection.rollback();
    }
    next(error);
  } finally {
    connection?.release();
  }
}

async function createDomain(req, res, next) {
  let connection;

  try {
    const domain = normalizeDomainPayload(req.body);
    const makePrimary = req.body?.isPrimary === true || req.body?.is_primary === true;

    if (makePrimary && !domain.isEnabled) {
      throw createHttpError(409, '停用域名不能设为主域名', 'DOMAIN_DISABLED');
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute('SELECT id FROM domains FOR UPDATE');
    const [result] = await connection.execute(
      `INSERT INTO domains
         (domain, type, platform, is_primary, is_enabled, remark)
       VALUES (?, ?, ?, 0, ?, ?)`,
      [domain.domain, domain.type, domain.platform, domain.isEnabled ? 1 : 0, domain.remark],
    );

    if (makePrimary) {
      await setPrimary(connection, result.insertId, domain.platform);
    }

    await connection.commit();
    return res.status(201).json({
      success: true,
      data: { id: result.insertId, ...domain, is_primary: makePrimary ? 1 : 0 },
      message: makePrimary ? '域名已添加并设为主域名' : '域名添加成功',
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }
    if (isDuplicate(error)) {
      return next(createHttpError(409, '域名已存在', 'DOMAIN_DUPLICATE'));
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

async function updateDomain(req, res, next) {
  let connection;

  try {
    const domainId = normalizeDomainId(req.params.id);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT id, domain, type, platform, is_primary, is_enabled, remark
       FROM domains WHERE id = ? LIMIT 1 FOR UPDATE`,
      [domainId],
    );

    if (!rows[0]) {
      throw createHttpError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    }

    const normalized = normalizeDomainPayload(req.body, rows[0]);
    if (rows[0].is_primary && !normalized.isEnabled) {
      throw createHttpError(409, '请先切换主域名，再停用当前主域名', 'PRIMARY_DOMAIN_CONFLICT');
    }

    await connection.execute(
      `UPDATE domains
       SET domain = ?, type = ?, platform = ?, is_enabled = ?, remark = ?
       WHERE id = ?`,
      [
        normalized.domain,
        normalized.type,
        normalized.platform,
        normalized.isEnabled ? 1 : 0,
        normalized.remark,
        domainId,
      ],
    );

    if (rows[0].is_primary) {
      await setPrimary(connection, domainId, normalized.platform);
    }

    await connection.commit();
    return res.json({
      success: true,
      data: { id: rows[0].id, ...normalized, is_primary: rows[0].is_primary },
      message: '域名更新成功；已有短链地址保持不变',
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }
    if (isDuplicate(error)) {
      return next(createHttpError(409, '域名已存在', 'DOMAIN_DUPLICATE'));
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

async function toggleDomain(req, res, next) {
  let connection;

  try {
    const domainId = normalizeDomainId(req.params.id);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT id, domain, type, platform, is_primary, is_enabled
       FROM domains WHERE id = ? LIMIT 1 FOR UPDATE`,
      [domainId],
    );

    if (!rows[0]) {
      throw createHttpError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    }

    const enabled = typeof req.body?.enabled === 'boolean'
      ? req.body.enabled
      : !Boolean(rows[0].is_enabled);

    if (!enabled && rows[0].is_primary) {
      throw createHttpError(409, '请先切换主域名，再停用当前主域名', 'PRIMARY_DOMAIN_CONFLICT');
    }
    await connection.execute('UPDATE domains SET is_enabled = ? WHERE id = ?', [
      enabled ? 1 : 0,
      domainId,
    ]);
    await connection.commit();
    return res.json({
      success: true,
      data: { id: rows[0].id, is_enabled: enabled ? 1 : 0 },
      message: enabled ? '域名已启用' : '域名已停用',
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

async function deleteDomain(req, res, next) {
  let connection;

  try {
    const domainId = normalizeDomainId(req.params.id);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT id, domain, is_primary FROM domains WHERE id = ? LIMIT 1 FOR UPDATE`,
      [domainId],
    );

    if (!rows[0]) {
      throw createHttpError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    }

    if (rows[0].is_primary) {
      throw createHttpError(409, '请先切换主域名，再删除当前主域名', 'PRIMARY_DOMAIN_CONFLICT');
    }
    const [[usage]] = await connection.execute(
      'SELECT COUNT(*) AS link_count FROM short_links WHERE domain_id = ?',
      [domainId],
    );

    if (Number(usage.link_count) > 0) {
      throw createHttpError(409, '该域名已有短链关联，不能删除', 'DOMAIN_IN_USE');
    }

    await connection.execute('DELETE FROM domains WHERE id = ?', [domainId]);
    await connection.commit();
    return res.json({
      success: true,
      data: { id: rows[0].id },
      message: '域名删除成功',
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }
    return next(error);
  } finally {
    connection?.release();
  }
}

async function listDomains(req, res, next) {
  try {
    const [rows] = await pool.execute(
      `SELECT d.id, d.domain, d.type,
              COALESCE(d.platform,
                CASE WHEN d.type = 'suolink' THEN 'suolink' ELSE 'self' END
              ) AS platform,
              d.is_primary, d.is_enabled, d.remark, d.created_at, d.updated_at,
              COALESCE(usage_count.link_count, 0) AS link_count
       FROM domains d
       LEFT JOIN (
         SELECT domain_id, COUNT(*) AS link_count
         FROM short_links
         GROUP BY domain_id
       ) usage_count ON usage_count.domain_id = d.id
       ORDER BY d.is_primary DESC, d.is_enabled DESC,
                COALESCE(usage_count.link_count, 0) ASC, d.id ASC`,
    );

    res.json({
      success: true,
      data: rows.map((domain) => ({
        ...domain,
        status: !domain.is_enabled
          ? 'disabled'
          : domain.is_primary
            ? 'primary'
            : 'enabled',
      })),
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  switchDomain,
  listDomains,
  getSuolinkConfig,
  saveSuolinkConfig,
  getDeliveryReadiness: getOgDeliveryReadiness,
  createDomain,
  updateDomain,
  toggleDomain,
  deleteDomain,
};
