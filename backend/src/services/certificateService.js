const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CERTIFICATE_ROOT = process.env.CERTIFICATE_STORAGE_DIR || '/etc/demo18/certificates';
// Ubuntu's default nginx.conf only includes /etc/nginx/conf.d/*.conf (not
// subdirectories). Keep managed vhosts in that directory so an upload cannot
// appear successful while the generated configuration is never loaded.
const NGINX_CONFIG_ROOT = process.env.CERTIFICATE_NGINX_CONFIG_DIR || '/etc/nginx/conf.d';
const LEGACY_NGINX_CONFIG_ROOT = '/etc/nginx/conf.d/demo18-certificates';
const APP_DIR = process.env.APP_DIR || '/var/www/demo18';
const BACKEND_PORT = process.env.PORT || '3001';

function createError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function hostnameFromDomain(domain) {
  const hostname = new URL(domain).hostname.toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
    throw createError('证书管理仅支持规范的域名地址', 'CERTIFICATE_DOMAIN_INVALID');
  }
  return hostname;
}

function runOpenSsl(args, message) {
  try {
    return execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw createError(message, 'CERTIFICATE_INVALID');
  }
}

function certificateNames(certificatePath) {
  const output = runOpenSsl(['x509', '-in', certificatePath, '-noout', '-ext', 'subjectAltName'], '证书链不是有效的 X.509 PEM 文件');
  return [...output.matchAll(/DNS:([^,\s]+)/g)].map((item) => item[1].toLowerCase());
}

function certificateCoversHost(names, hostname) {
  return names.some((name) => name === hostname || (name.startsWith('*.') && hostname.endsWith(name.slice(1)) && hostname.split('.').length === name.split('.').length));
}

function publicKeyFingerprint(command, filePath, extraArgs = []) {
  const output = runOpenSsl([...command, '-in', filePath, ...extraArgs], '证书与私钥格式无效');
  return crypto.createHash('sha256').update(output).digest('hex');
}

function nginxConfig(hostname, certificatePath, keyPath) {
  const proxy = `http://127.0.0.1:${BACKEND_PORT}`;
  const headers = `        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;`;
  return `# Managed by demo18 certificate upload. Do not edit manually.\nserver {\n    listen 80;\n    server_name ${hostname};\n    return 301 https://$host$request_uri;\n}\n\nserver {\n    listen 443 ssl;\n    server_name ${hostname};\n    root ${APP_DIR}/frontend/dist;\n    index index.html;\n    client_max_body_size 20m;\n    ssl_certificate ${certificatePath};\n    ssl_certificate_key ${keyPath};\n    include /etc/letsencrypt/options-ssl-nginx.conf;\n\n    location ^~ /card-covers/ {\n        alias ${APP_DIR}/backend/uploads/share-cards/;\n        limit_except GET HEAD { deny all; }\n        add_header Cache-Control \"public, max-age=86400\" always;\n        add_header X-Content-Type-Options \"nosniff\" always;\n    }\n\n    location = /play {\n        proxy_pass ${proxy}/play;\n${headers}\n    }\n\n    location ~ \"^/card/[A-Za-z0-9_-]{20,128}$\" {\n        proxy_pass ${proxy};\n${headers}\n    }\n\n    location ~ \"^/s/[A-Za-z0-9]{6,8}$\" {\n        proxy_pass ${proxy};\n${headers}\n    }\n\n    location /api/ {\n        proxy_pass ${proxy};\n${headers}\n    }\n\n    location = /health {\n        proxy_pass ${proxy}/health;\n${headers}\n    }\n\n    location ~ \"^/([A-Za-z0-9]{6,8})$\" {\n        rewrite \"^/([A-Za-z0-9]{6,8})$\" /api/short/$1 break;\n        proxy_pass ${proxy};\n${headers}\n    }\n\n    location / {\n        try_files $uri $uri/ /index.html;\n    }\n}\n`;
}

function certificatePaths(hostname) {
  const directory = path.join(CERTIFICATE_ROOT, hostname);
  return {
    directory,
    certificate: path.join(directory, 'fullchain.pem'),
    privateKey: path.join(directory, 'privkey.pem'),
    nginxConfig: path.join(NGINX_CONFIG_ROOT, `demo18-certificate-${hostname}.conf`),
    legacyNginxConfig: path.join(LEGACY_NGINX_CONFIG_ROOT, `${hostname}.conf`),
  };
}

function getCertificateStatus(domain) {
  const hostname = hostnameFromDomain(domain);
  const files = certificatePaths(hostname);
  const hasCertificate = fs.existsSync(files.certificate) && fs.existsSync(files.privateKey);
  const hasActiveConfig = fs.existsSync(files.nginxConfig);
  const legacyConfigDetected = fs.existsSync(files.legacyNginxConfig);
  // Ubuntu's stock nginx.conf only includes /etc/nginx/conf.d/*.conf. A file
  // left in the historical subdirectory is not an active virtual host and
  // must never be reported as configured: doing so leaves HTTPS clients on
  // the default reject_handshake server even though the admin UI says OK.
  if (!hasCertificate || !hasActiveConfig) {
    return { hostname, configured: false, legacyConfigDetected };
  }
  const details = runOpenSsl(['x509', '-in', files.certificate, '-noout', '-enddate', '-serial'], '已保存的证书文件无效');
  const expiresAt = (details.match(/notAfter=(.+)/) || [])[1] || '';
  return {
    hostname,
    configured: true,
    expiresAt,
    certificatePath: files.certificate,
    nginxConfigPath: files.nginxConfig,
    legacyConfigDetected,
  };
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return { content: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
}

function restoreFile(filePath, snapshot) {
  if (!snapshot) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot.content, { mode: snapshot.mode });
}

function verifyNginxServesCertificate(hostname, certificateBuffer) {
  let output;
  try {
    output = execFileSync('openssl', [
      's_client', '-connect', '127.0.0.1:443', '-servername', hostname, '-showcerts',
    ], { encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    throw createError('Nginx 重载后无法建立 HTTPS 验证连接', 'CERTIFICATE_HTTPS_VERIFY_FAILED', 500);
  }
  const pem = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!pem) throw createError('Nginx 未返回可验证的 SSL 证书', 'CERTIFICATE_HTTPS_VERIFY_FAILED', 500);
  try {
    const expected = new crypto.X509Certificate(certificateBuffer);
    const served = new crypto.X509Certificate(pem[0]);
    if (!served.checkHost(hostname) || served.fingerprint256 !== expected.fingerprint256) {
      throw new Error('certificate mismatch');
    }
  } catch {
    throw createError('证书文件已保存，但 Nginx 未实际加载该域名证书', 'CERTIFICATE_HTTPS_VERIFY_FAILED', 500);
  }
}

function installCertificate(domain, certificateBuffer, privateKeyBuffer) {
  const hostname = hostnameFromDomain(domain);
  if (!certificateBuffer?.length || !privateKeyBuffer?.length) {
    throw createError('请同时上传证书链和私钥文件', 'CERTIFICATE_FILES_REQUIRED');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'demo18-cert-'));
  const certificateInput = path.join(temporary, 'fullchain.pem');
  const keyInput = path.join(temporary, 'privkey.pem');
  try {
    fs.writeFileSync(certificateInput, certificateBuffer, { mode: 0o600 });
    fs.writeFileSync(keyInput, privateKeyBuffer, { mode: 0o600 });
    runOpenSsl(['x509', '-in', certificateInput, '-noout', '-checkend', '0'], '证书已过期或格式无效');
    runOpenSsl(['pkey', '-in', keyInput, '-noout'], '私钥格式无效或受密码保护');
    const names = certificateNames(certificateInput);
    if (!certificateCoversHost(names, hostname)) {
      throw createError(`证书不包含域名 ${hostname}`, 'CERTIFICATE_DOMAIN_MISMATCH');
    }
    const certificateKey = publicKeyFingerprint(['x509'], certificateInput, ['-pubkey', '-noout']);
    const privateKey = publicKeyFingerprint(['pkey'], keyInput, ['-pubout']);
    if (certificateKey !== privateKey) {
      throw createError('证书链与私钥不匹配', 'CERTIFICATE_KEY_MISMATCH');
    }
    const files = certificatePaths(hostname);
    const previous = {
      certificate: snapshotFile(files.certificate),
      privateKey: snapshotFile(files.privateKey),
      nginxConfig: snapshotFile(files.nginxConfig),
      legacyNginxConfig: snapshotFile(files.legacyNginxConfig),
    };
    fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(NGINX_CONFIG_ROOT, { recursive: true, mode: 0o755 });
    const certificateTemp = `${files.certificate}.new`;
    const keyTemp = `${files.privateKey}.new`;
    const configTemp = `${files.nginxConfig}.new`;
    fs.writeFileSync(certificateTemp, certificateBuffer, { mode: 0o644 });
    fs.writeFileSync(keyTemp, privateKeyBuffer, { mode: 0o600 });
    fs.writeFileSync(configTemp, nginxConfig(hostname, files.certificate, files.privateKey), { mode: 0o644 });
    fs.renameSync(certificateTemp, files.certificate);
    fs.renameSync(keyTemp, files.privateKey);
    fs.renameSync(configTemp, files.nginxConfig);
    try {
      // Remove the historical copy before testing/reloading. On installations
      // with a recursive custom include, keeping both files creates duplicate
      // server_name blocks and Nginx may continue selecting the stale one.
      if (files.legacyNginxConfig !== files.nginxConfig) {
        fs.rmSync(files.legacyNginxConfig, { force: true });
      }
      execFileSync('nginx', ['-t'], { stdio: 'pipe' });
      execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'pipe' });
      verifyNginxServesCertificate(hostname, certificateBuffer);
    } catch {
      // A failed upload must not strand an invalid config on disk or discard a
      // previously working certificate. Restore the exact prior state, then
      // ask Nginx to return to it before reporting failure.
      restoreFile(files.certificate, previous.certificate);
      restoreFile(files.privateKey, previous.privateKey);
      restoreFile(files.nginxConfig, previous.nginxConfig);
      restoreFile(files.legacyNginxConfig, previous.legacyNginxConfig);
      try {
        execFileSync('nginx', ['-t'], { stdio: 'pipe' });
        execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'pipe' });
      } catch {
        // Preserve the original, actionable upload error below. Operators can
        // inspect nginx -t output without leaking it through the public API.
      }
      throw createError('证书未被 Nginx 实际加载，请检查 Nginx 配置或端口 443', 'CERTIFICATE_NGINX_FAILED', 500);
    }
    return { ...getCertificateStatus(domain), names };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { getCertificateStatus, installCertificate, createError };
