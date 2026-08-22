const { spawn } = require('child_process');

const BACKEND_DIR = 'C:/Users/popol/Desktop/Projects/demo18/backend';
const TEST_PORT = 3018;

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('temporary backend did not become healthy');
}

(async () => {
  const switchResponse = await fetch('http://localhost:3001/api/domain/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ domainId: 2 }),
  });
  const switchPayload = await switchResponse.json();
  console.log('SWITCH_HTTP', switchResponse.status);
  console.log('SWITCH_PAYLOAD', JSON.stringify(switchPayload));

  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      SUOLINK_API_KEY: 'AT_E2E_INTENTIONALLY_INVALID_KEY',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForHealth();
    const response = await fetch(`http://localhost:${TEST_PORT}/api/shortlink/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        videoId: 2,
        longUrl: 'http://localhost:5173/play?fileId=5001834815472845728',
        platform: 'auto',
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('GENERATE_HTTP', response.status);
    console.log('GENERATE_PAYLOAD', JSON.stringify(payload));
    console.log('SERVER_STDOUT', JSON.stringify(stdout));
    console.log('SERVER_STDERR', JSON.stringify(stderr));
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
})().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
