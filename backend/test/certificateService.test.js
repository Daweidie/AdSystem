const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('certificate uploader writes managed virtual hosts to nginx conf.d root', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/services/certificateService.js'),
    'utf8',
  );

  assert.match(source, /CERTIFICATE_NGINX_CONFIG_DIR \|\| '\/etc\/nginx\/conf\.d'/);
  assert.match(source, /demo18-certificate-\$\{hostname\}\.conf/);
  assert.match(source, /verifyNginxServesCertificate\(hostname, certificateBuffer\)/);
  assert.match(source, /configured: false, legacyConfigDetected/);
  assert.match(source, /restoreFile\(files\.nginxConfig, previous\.nginxConfig\)/);
  assert.match(source, /fs\.rmSync\(files\.legacyNginxConfig, \{ force: true \}\)/);
});
