<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

const TCPLAYER_SCRIPT =
  'https://web.sdk.qcloud.com/player/tcplayer/release/v4.5.4/tcplayer.v4.5.4.min.js';
const TCPLAYER_STYLE =
  'https://web.sdk.qcloud.com/player/tcplayer/release/v4.5.4/tcplayer.min.css';
const PLAYER_ELEMENT_ID = 'tcplayer-video';

const route = useRoute();
const playbackRouteContext = {
  fileId: '',
  shortLinkId: null,
};
const pageState = ref('loading');
const errorMessage = ref('');
const videoTitle = ref('视频播放');
const videoInfo = ref(null);
const playerElementKey = ref(0);

let player = null;
let loadSequence = 0;
let tcPlayerLoaderPromise = null;
let sessionId = '';
let startReported = false;
let lastProgressReportedAt = 0;
let lastPlayedSeconds = 0;

function getApiBaseUrl() {
  const configured = String(import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return window.location.port === '5173'
    ? 'http://localhost:3001/api'
    : `${window.location.origin}/api`;
}

function loadStyleOnce(href) {
  if (document.querySelector(`link[href="${href}"]`)) {
    return;
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.tcplayerAsset = 'style';
  document.head.appendChild(link);
}

function loadScript(src, globalName = 'TCPlayer') {
  if (window[globalName]) {
    return Promise.resolve(window[globalName]);
  }

  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${src}"]`);

    if (existingScript) {
      if (window[globalName]) {
        resolve(window[globalName]);
        return;
      }

      if (existingScript.dataset.loadState === 'loaded') {
        existingScript.remove();
        loadScript(src, globalName).then(resolve, reject);
        return;
      }

      existingScript.addEventListener('load', () => resolve(window[globalName]), {
        once: true,
      });
      existingScript.addEventListener('error', reject, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.tcplayerAsset = 'script';
    script.onload = () => {
      script.dataset.loadState = 'loaded';

      if (window[globalName]) {
        resolve(window[globalName]);
      } else {
        script.remove();
        reject(new Error(`${globalName} 脚本已加载，但未找到对应全局对象`));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`播放器脚本加载失败：${src}`));
    };
    document.head.appendChild(script);
  });
}

async function loadTcPlayer() {
  if (window.TCPlayer) {
    return window.TCPlayer;
  }

  if (!tcPlayerLoaderPromise) {
    tcPlayerLoaderPromise = (async () => {
      loadStyleOnce(TCPLAYER_STYLE);
      return loadScript(TCPLAYER_SCRIPT, 'TCPlayer');
    })().catch((error) => {
      tcPlayerLoaderPromise = null;
      throw error;
    });
  }

  return tcPlayerLoaderPromise;
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function getShortLinkId() {
  return playbackRouteContext.shortLinkId;
}

function getCurrentTime(instance = player) {
  try {
    const value = typeof instance?.currentTime === 'function'
      ? instance.currentTime()
      : document.getElementById(PLAYER_ELEMENT_ID)?.currentTime;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  } catch {
    return 0;
  }
}

async function reportPlaybackEvent(eventType, playedSeconds = getCurrentTime()) {
  const videoId = videoInfo.value?.id;

  if (!videoId || !sessionId) {
    return;
  }

  const apiBaseUrl = getApiBaseUrl();
  const body = {
    sessionId,
    eventType,
    playedSeconds: Math.max(0, Number(playedSeconds) || 0),
  };
  const shortLinkId = getShortLinkId();

  if (shortLinkId) {
    body.shortLinkId = shortLinkId;
  }

  try {
    const response = await fetch(
      `${apiBaseUrl}/video/${encodeURIComponent(videoId)}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      },
    );

    if (!response.ok) {
      let code = `HTTP_${response.status}`;

      try {
        code = (await response.json())?.code || code;
      } catch {
        // 只记录状态和错误码，不读取或输出签名、响应体等敏感内容。
      }

      console.warn('播放事件上报失败', { eventType, status: response.status, code });
    }
  } catch (error) {
    console.warn('播放事件上报失败', {
      eventType,
      code: error?.name || 'NETWORK_ERROR',
    });
  }
}

function handlePlaybackStarted() {
  if (startReported) {
    return;
  }

  startReported = true;
  void reportPlaybackEvent('start');
}

function handlePlaybackProgress() {
  const now = Date.now();
  const playedSeconds = getCurrentTime();

  if (now - lastProgressReportedAt < 10000 || playedSeconds <= lastPlayedSeconds) {
    return;
  }

  lastProgressReportedAt = now;
  lastPlayedSeconds = playedSeconds;
  void reportPlaybackEvent('progress', playedSeconds);
}

function getQueryFileId() {
  return playbackRouteContext.fileId;
}

function firstRouteQueryValue(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function capturePlaybackRouteContext() {
  playbackRouteContext.fileId = firstRouteQueryValue(route.query.fileId);
  const shortLinkId = firstRouteQueryValue(route.query.shortLinkId);
  playbackRouteContext.shortLinkId = /^\d+$/.test(shortLinkId) ? shortLinkId : null;
}

function readValidatedSharePath() {
  const raw = document
    .querySelector('meta[name="demo18-share-path"]')
    ?.getAttribute('content')
    ?.trim();
  if (
    !raw
    || !/^(?:\/s\/[A-Za-z0-9]{6,8}|\/card\/[A-Za-z0-9_-]{20,128})$/.test(raw)
    || raw.startsWith('//')
    || raw.includes('\\')
  ) return null;

  try {
    const destination = new URL(raw, window.location.origin);
    if (
      destination.origin !== window.location.origin
      || destination.username
      || destination.password
      || destination.search
      || destination.hash
      || destination.pathname !== raw
    ) return null;
    return destination.pathname;
  } catch {
    return null;
  }
}

function restoreServerSharePath() {
  const sharePath = readValidatedSharePath();
  if (!sharePath || window.location.pathname === sharePath) return;
  window.history.replaceState(window.history.state, '', sharePath);
}

function extractPlaybackData(payload, requestedFileId) {
  const data = payload?.data ?? payload;
  const playback = data?.playback ?? data?.playInfo ?? data;

  return {
    raw: data,
    fileId: playback?.fileId ?? playback?.fileID ?? requestedFileId,
    appId:
      playback?.appId ??
      playback?.appID ??
      data?.appId ??
      data?.appID ??
      import.meta.env.VITE_TENCENT_APP_ID,
    psign:
      playback?.psign ??
      playback?.pSign ??
      playback?.playSignature ??
      playback?.signature,
    licenseUrl: playback?.licenseUrl ?? data?.licenseUrl,
    poster: resolveAssetUrl(
      playback?.coverUrl ??
      playback?.cover_url ??
      data?.coverUrl ??
      data?.cover_url,
    ),
    title: data?.title ?? playback?.title,
    shareCard: data?.shareCard || null,
  };
}

function resolveAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(https?:|blob:|data:)/i.test(raw)) return raw;
  try {
    const apiBaseUrl = getApiBaseUrl();
    const apiOrigin = new URL(apiBaseUrl, window.location.origin).origin;
    return new URL(raw, raw.startsWith('/api/') ? apiOrigin : window.location.origin).toString();
  } catch {
    return raw;
  }
}

async function fetchPlaybackInfo(fileId, shortLinkId = getShortLinkId()) {
  const apiBaseUrl = getApiBaseUrl();
  const endpoint = new URL(
    `${apiBaseUrl}/video/${encodeURIComponent(fileId)}`,
    window.location.origin,
  );
  if (shortLinkId) endpoint.searchParams.set('shortLinkId', shortLinkId);
  const response = await fetch(endpoint.toString(), {
    headers: { Accept: 'application/json' },
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error('后端返回的数据格式不正确');
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `获取视频信息失败（HTTP ${response.status}）`);
  }

  return extractPlaybackData(payload, fileId);
}

function disposePlayer() {
  if (player && typeof player.dispose === 'function') {
    player.dispose();
  }

  player = null;
}

function getErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function getPlayerErrorDetail(event) {
  const detail = event?.data ?? event?.detail ?? event;
  const code = detail?.code ?? detail?.error?.code;
  const message = detail?.message ?? detail?.error?.message;

  if (code && message) {
    return `错误码 ${code}：${message}`;
  }

  if (code) {
    return `错误码 ${code}`;
  }

  return message || '';
}

function handlePlayerError(event, sequence, instance) {
  if (sequence !== loadSequence || player !== instance) {
    return;
  }

  const detail = getPlayerErrorDetail(event);
  void reportPlaybackEvent('error', getCurrentTime(instance));
  player = null;
  instance.dispose?.();
  pageState.value = 'error';
  errorMessage.value = detail
    ? `播放器加载失败（${detail}），请稍后重试`
    : '播放器加载失败，请检查网络后重试';
}

async function initializePlayer() {
  const currentSequence = ++loadSequence;
  const requestedFileId = getQueryFileId();

  pageState.value = 'loading';
  errorMessage.value = '';
  videoTitle.value = '视频播放';
  videoInfo.value = null;
  sessionId = createSessionId();
  startReported = false;
  lastProgressReportedAt = 0;
  lastPlayedSeconds = 0;
  disposePlayer();
  playerElementKey.value += 1;

  if (!requestedFileId) {
    pageState.value = 'empty';
    return;
  }

  let playback;

  try {
    playback = await fetchPlaybackInfo(requestedFileId);
  } catch (error) {
    if (currentSequence !== loadSequence) {
      return;
    }

    pageState.value = 'error';
    errorMessage.value = getErrorMessage(error, '无法获取视频信息');
    return;
  }

  if (currentSequence !== loadSequence) {
    return;
  }

  videoInfo.value = playback.raw;
  videoTitle.value = playback.title || '视频播放';

  if (!playback.appId || !playback.psign) {
    pageState.value = 'error';
    errorMessage.value = '播放器初始化失败：后端未返回 appId 或 psign';
    return;
  }

  let TCPlayer;

  try {
    TCPlayer = await loadTcPlayer();
  } catch (error) {
    if (currentSequence !== loadSequence) {
      return;
    }

    pageState.value = 'error';
    errorMessage.value = `播放器组件加载失败：${getErrorMessage(
      error,
      '请检查网络连接',
    )}`;
    return;
  }

  if (currentSequence !== loadSequence) {
    return;
  }

  pageState.value = 'ready';
  await nextTick();

  try {
    if (currentSequence !== loadSequence) {
      return;
    }

    const options = {
      fileID: String(playback.fileId),
      appID: String(playback.appId),
      psign: playback.psign,
      autoplay: true,
      controls: true,
    };

    if (playback.licenseUrl) {
      options.licenseUrl = playback.licenseUrl;
    }

    if (playback.poster) {
      options.poster = playback.poster;
    }

    const playerInstance = TCPlayer(PLAYER_ELEMENT_ID, options);

    if (!playerInstance) {
      throw new Error('播放器实例创建失败');
    }

    player = playerInstance;
    playerInstance.on?.('play', handlePlaybackStarted);
    playerInstance.on?.('playing', handlePlaybackStarted);
    playerInstance.on?.('timeupdate', handlePlaybackProgress);
    playerInstance.on?.('ended', () => {
      void reportPlaybackEvent('complete', getCurrentTime(playerInstance));
    });
    playerInstance.on?.('error', (event) => {
      handlePlayerError(event, currentSequence, playerInstance);
    });
    document.documentElement.dataset.demo18PlayerInitialized = 'true';
    restoreServerSharePath();
  } catch (error) {
    if (currentSequence !== loadSequence) {
      return;
    }

    disposePlayer();
    pageState.value = 'error';
    errorMessage.value = `播放器初始化失败：${getErrorMessage(
      error,
      '请稍后重试',
    )}`;
  }
}

watch(
  () => [route.query.fileId, route.query.shortLinkId],
  () => {
    capturePlaybackRouteContext();
    void initializePlayer();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  loadSequence += 1;
  delete document.documentElement.dataset.demo18PlayerInitialized;
  if (startReported && getCurrentTime() > lastPlayedSeconds) {
    void reportPlaybackEvent('progress');
  }
  disposePlayer();
});
</script>

<template>
  <main class="play-page">
    <header class="play-header">
      <h1>{{ videoTitle }}</h1>
    </header>

    <section class="player-shell" aria-live="polite">
      <div v-if="pageState === 'loading'" class="status-panel">
        <span class="spinner" aria-hidden="true"></span>
        <p>正在加载视频，请稍候…</p>
      </div>

      <div v-else-if="pageState === 'empty'" class="status-panel empty-panel">
        <h2>未找到要播放的视频</h2>
        <p>当前链接缺少 fileId 参数，请确认复制了完整的播放链接。</p>
      </div>

      <div v-else-if="pageState === 'error'" class="status-panel error-panel">
        <h2>视频暂时无法播放</h2>
        <p>{{ errorMessage }}</p>
        <button type="button" @click="initializePlayer">重新加载</button>
      </div>

      <video
        :key="playerElementKey"
        v-show="pageState === 'ready'"
        :id="PLAYER_ELEMENT_ID"
        class="tcplayer-video tcplayer-skin"
        preload="metadata"
        playsinline
        webkit-playsinline
        x5-playsinline
        x5-video-player-type="h5-page"
      ></video>
    </section>
  </main>
</template>

<style scoped>
.play-page {
  min-height: 100vh;
  min-height: 100dvh;
  color: #f8fafc;
  background: #05070a;
}

.play-header {
  padding: max(14px, env(safe-area-inset-top)) 16px 12px;
}

.play-header h1 {
  max-width: 960px;
  margin: 0 auto;
  overflow: hidden;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-shell {
  position: relative;
  width: 100%;
  max-width: 960px;
  min-height: min(56.25vw, 540px);
  margin: 0 auto;
  overflow: hidden;
  background: #000;
  aspect-ratio: 16 / 9;
}

.tcplayer-video,
.player-shell :deep(.tcp-video),
.player-shell :deep(.tcplayer) {
  width: 100% !important;
  height: 100% !important;
}

.status-panel {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  color: #cbd5e1;
  text-align: center;
}

.status-panel p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
}

.status-panel h2 {
  margin: 0;
  color: #f8fafc;
  font-size: 18px;
  font-weight: 600;
}

.empty-panel {
  color: #94a3b8;
  background: radial-gradient(circle at center, #172033 0%, #05070a 72%);
}

.spinner {
  width: 30px;
  height: 30px;
  border: 3px solid rgb(255 255 255 / 20%);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.error-panel button {
  padding: 9px 18px;
  color: #fff;
  font: inherit;
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 999px;
  background: rgb(255 255 255 / 10%);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (min-width: 768px) {
  .play-page {
    padding-bottom: 48px;
  }

  .player-shell {
    border-radius: 12px;
  }
}
</style>
