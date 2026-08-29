<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
const loadingProgress = ref(8);
const loadingLabel = ref('正在连接视频服务…');
const videoTitle = ref('视频播放');
const videoInfo = ref(null);
const playerElementKey = ref(0);
const playerShell = ref(null);
const isPlaying = ref(false);
const isMuted = ref(false);
const isFullscreen = ref(false);
const currentTime = ref(0);
const duration = ref(0);

let player = null;
let loadSequence = 0;
let tcPlayerLoaderPromise = null;
let sessionId = '';
let startReported = false;
let lastProgressReportedAt = 0;
let lastPlayedSeconds = 0;
let furthestPlayedSeconds = 0;
let restoringSeek = false;

const NETWORK_RETRY_LIMIT = 3;
const NETWORK_RETRY_DELAYS = [300, 900, 1800];

const SEEK_TOLERANCE_SECONDS = 1.5;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryNetworkOperation(operation) {
  let lastError;
  for (let attempt = 0; attempt < NETWORK_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < NETWORK_RETRY_LIMIT - 1) {
        await wait(NETWORK_RETRY_DELAYS[attempt]);
      }
    }
  }
  throw lastError || new Error('网络请求失败');
}

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

function getNativeVideoElement() {
  return document.getElementById(PLAYER_ELEMENT_ID);
}

function getDuration(instance = player) {
  try {
    const value = typeof instance?.duration === 'function'
      ? instance.duration()
      : getNativeVideoElement()?.duration;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  } catch {
    return 0;
  }
}

function setCurrentTime(value, instance = player) {
  try {
    if (typeof instance?.currentTime === 'function') {
      instance.currentTime(value);
      return;
    }
    const video = getNativeVideoElement();
    if (video) video.currentTime = value;
  } catch {
    // 某些移动端在媒体元数据可用前禁止设置 currentTime，后续事件会再次校正。
  }
}

function enforceNormalPlaybackRate(instance = player) {
  try {
    if (typeof instance?.playbackRate === 'function' && Number(instance.playbackRate()) !== 1) {
      instance.playbackRate(1);
    }
  } catch {
    // 同时校正原生 video，兼容不公开 playbackRate 方法的播放器版本。
  }
  const video = getNativeVideoElement();
  if (video && video.playbackRate !== 1) video.playbackRate = 1;
}

function restoreForwardSeek(instance = player) {
  if (restoringSeek) return;
  const requestedTime = getCurrentTime(instance);
  if (requestedTime <= furthestPlayedSeconds + SEEK_TOLERANCE_SECONDS) return;

  restoringSeek = true;
  setCurrentTime(furthestPlayedSeconds, instance);
  currentTime.value = furthestPlayedSeconds;
  queueMicrotask(() => { restoringSeek = false; });
}

function handlePlayerTimeUpdate() {
  const playedSeconds = getCurrentTime();
  furthestPlayedSeconds = Math.max(furthestPlayedSeconds, playedSeconds);
  currentTime.value = playedSeconds;
  duration.value = getDuration();
  handlePlaybackProgress();
}

function formatPlayerTime(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function togglePlayback() {
  if (!player) return;
  try {
    if (isPlaying.value) {
      player.pause?.();
    } else {
      await player.play?.();
    }
  } catch {
    // 自动播放策略拒绝时，用户可以再次点击播放。
  }
}

function toggleMute() {
  const nextMuted = !isMuted.value;
  try {
    if (typeof player?.muted === 'function') player.muted(nextMuted);
    else if (typeof player?.mute === 'function') player.mute(nextMuted);
  } catch {
    // 继续同步原生 video。
  }
  const video = getNativeVideoElement();
  if (video) video.muted = nextMuted;
  isMuted.value = nextMuted;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      await exit?.call(document);
      return;
    }
    const shell = playerShell.value;
    const request = shell?.requestFullscreen || shell?.webkitRequestFullscreen;
    if (request) {
      await request.call(shell);
      return;
    }
    if (typeof player?.requestFullscreen === 'function') player.requestFullscreen();
  } catch {
    // 不支持全屏的内嵌浏览器保持当前播放状态。
  }
}

function updateFullscreenState() {
  isFullscreen.value = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
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
  isPlaying.value = true;
  enforceNormalPlaybackRate();
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
    // The backend serves card covers and the fallback poster.  During local
    // development the page is on :5173 while Express is on :3001, so using
    // window.location.origin would resolve the image to the Vite SPA and
    // return HTML instead of image bytes.
    return new URL(raw, apiOrigin).toString();
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
  loadingProgress.value = 8;
  loadingLabel.value = '正在连接视频服务…';
  errorMessage.value = '';
  videoTitle.value = '视频播放';
  videoInfo.value = null;
  sessionId = createSessionId();
  startReported = false;
  lastProgressReportedAt = 0;
  lastPlayedSeconds = 0;
  furthestPlayedSeconds = 0;
  restoringSeek = false;
  isPlaying.value = false;
  isMuted.value = false;
  currentTime.value = 0;
  duration.value = 0;
  disposePlayer();
  playerElementKey.value += 1;

  if (!requestedFileId) {
    pageState.value = 'empty';
    return;
  }

  let playback;

  try {
    playback = await retryNetworkOperation(() => fetchPlaybackInfo(requestedFileId));
    loadingProgress.value = 42;
    loadingLabel.value = '视频信息已获取，正在加载播放器…';
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
    TCPlayer = await retryNetworkOperation(() => loadTcPlayer());
    loadingProgress.value = 72;
    loadingLabel.value = '播放器组件已加载，正在初始化…';
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
      controls: false,
      bigPlayButton: false,
      playbackRates: [1],
      controlBar: {
        progressControl: false,
        playbackRateMenuButton: false,
      },
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
    playerInstance.on?.('pause', () => { isPlaying.value = false; });
    playerInstance.on?.('loadedmetadata', () => { duration.value = getDuration(playerInstance); });
    playerInstance.on?.('durationchange', () => { duration.value = getDuration(playerInstance); });
    playerInstance.on?.('timeupdate', handlePlayerTimeUpdate);
    playerInstance.on?.('seeking', () => { restoreForwardSeek(playerInstance); });
    playerInstance.on?.('ratechange', () => { enforceNormalPlaybackRate(playerInstance); });
    playerInstance.on?.('ended', () => {
      isPlaying.value = false;
      void reportPlaybackEvent('complete', getCurrentTime(playerInstance));
    });
    playerInstance.on?.('error', (event) => {
      handlePlayerError(event, currentSequence, playerInstance);
    });
    document.documentElement.dataset.demo18PlayerInitialized = 'true';
    restoreServerSharePath();
    loadingProgress.value = 100;
    loadingLabel.value = '加载完成，准备播放';
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

onMounted(() => {
  document.addEventListener('fullscreenchange', updateFullscreenState);
  document.addEventListener('webkitfullscreenchange', updateFullscreenState);
});

onBeforeUnmount(() => {
  loadSequence += 1;
  delete document.documentElement.dataset.demo18PlayerInitialized;
  if (startReported && getCurrentTime() > lastPlayedSeconds) {
    void reportPlaybackEvent('progress');
  }
  disposePlayer();
  document.removeEventListener('fullscreenchange', updateFullscreenState);
  document.removeEventListener('webkitfullscreenchange', updateFullscreenState);
});
</script>

<template>
  <main class="play-page">
    <header class="play-header">
      <h1>{{ videoTitle }}</h1>
    </header>

    <section ref="playerShell" class="player-shell" aria-live="polite">
      <div v-if="pageState === 'loading'" class="status-panel">
        <span class="spinner" aria-hidden="true"></span>
        <p>{{ loadingLabel }}</p>
        <div class="loading-progress" role="progressbar" :aria-valuenow="loadingProgress" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${loadingProgress}%` }"></span>
        </div>
        <small>{{ loadingProgress }}%</small>
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

      <div v-if="pageState === 'ready'" class="safe-controls" aria-label="视频播放控制">
        <button type="button" :aria-label="isPlaying ? '暂停' : '播放'" @click="togglePlayback">
          <svg v-if="!isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4L19 12 7 4.8Z" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h4v14h-4V5Zm7 0h4v14h-4V5Z" /></svg>
        </button>
        <button type="button" :aria-label="isMuted ? '取消静音' : '静音'" @click="toggleMute">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm11.5-.8v7.6a4.5 4.5 0 0 0 0-7.6Zm0-3.2v2.1a6.5 6.5 0 0 1 0 9.8V19a8.5 8.5 0 0 0 0-14Z" /></svg>
          <span v-if="isMuted" class="mute-slash" aria-hidden="true"></span>
        </button>
        <span class="safe-controls-time">{{ formatPlayerTime(currentTime) }} / {{ formatPlayerTime(duration) }}</span>
        <span class="playback-lock-note">顺序播放</span>
        <button type="button" :aria-label="isFullscreen ? '退出全屏' : '全屏播放'" @click="toggleFullscreen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h5v2H7v3H5V5Zm9 0h5v5h-2V7h-3V5ZM5 14h2v3h3v2H5v-5Zm12 0h2v5h-5v-2h3v-3Z" /></svg>
        </button>
      </div>
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

.safe-controls {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 48px;
  padding: 5px 8px max(5px, env(safe-area-inset-bottom));
  background: linear-gradient(transparent, rgb(0 0 0 / 82%));
}

.safe-controls button {
  position: relative;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  padding: 9px;
  color: #fff;
  border: 0;
  border-radius: 6px;
  background: transparent;
  -webkit-tap-highlight-color: transparent;
}

.safe-controls button:active {
  background: rgb(255 255 255 / 16%);
}

.safe-controls svg {
  display: block;
  width: 22px;
  height: 22px;
  fill: currentColor;
}

.safe-controls button:last-child {
  margin-left: auto;
}

.safe-controls-time {
  margin-left: 3px;
  color: #fff;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.playback-lock-note {
  margin-left: 8px;
  padding: 2px 7px;
  color: rgb(255 255 255 / 76%);
  font-size: 11px;
  line-height: 18px;
  border: 1px solid rgb(255 255 255 / 24%);
  border-radius: 999px;
  white-space: nowrap;
}

.mute-slash {
  position: absolute;
  top: 9px;
  left: 19px;
  width: 2px;
  height: 23px;
  background: #fff;
  transform: rotate(-45deg);
  transform-origin: center;
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

.loading-progress {
  width: min(260px, 80%);
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgb(255 255 255 / 18%);
}

.loading-progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #5eead4;
  transition: width 0.35s ease;
}

.status-panel small {
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
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
