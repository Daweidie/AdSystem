import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function playAccessGate(apiBaseUrl) {
  return {
    name: 'play-access-gate',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url || '/', 'http://localhost');

        if (
          !['GET', 'HEAD'].includes(request.method || 'GET') ||
          requestUrl.pathname !== '/play' ||
          !requestUrl.searchParams.get('fileId')
        ) {
          next();
          return;
        }

        try {
          const validation = await fetch(
            `${apiBaseUrl}/video/access?fileId=${encodeURIComponent(
              requestUrl.searchParams.get('fileId'),
            )}`,
            { headers: { Accept: 'application/json' } },
          );

          if (validation.ok) {
            next();
            return;
          }

          if (![404, 410].includes(validation.status)) {
            next();
            return;
          }

          const payload = await validation.json().catch(() => ({}));
          const title = validation.status === 410 ? '视频不可用' : '视频不存在';
          const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070a;color:#e2e8f0;font-family:system-ui,sans-serif}.panel{text-align:center;padding:32px}h1{font-size:24px;margin:0 0 12px}p{color:#94a3b8;margin:0}</style></head><body><main class="panel"><h1>${title}</h1><p>${escapeHtml(payload.message || title)}</p></main></body></html>`;
          response.statusCode = validation.status;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(request.method === 'HEAD' ? undefined : html);
        } catch {
          // 后端短暂不可用时继续返回 SPA，由页面内 API 给出可诊断错误。
          next();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBaseUrl = (env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '');

  return {
    plugins: [playAccessGate(apiBaseUrl), vue()],
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
  };
});
