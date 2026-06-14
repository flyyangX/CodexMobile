/**
 * CodexMobile 服务端主入口：装配 HTTP/HTTPS、WebSocket、路由与 Codex 缓存同步。
 *
 * Keywords: http-server, https, websocket, codex-cache, auth, routes, desktop-refresh
 *
 * Exports:
 * - 无 default；副作用启动 main()。
 *
 * Inward（本模块依赖/组装的关键符号）: auth、codex-data、chat/file/git/session/voice 等 route handler、静态资源与推送。
 *
 * Outward（谁在用/调用场景）: Node 进程直接执行本文件作为服务端入口。
 *
 * 不负责: 各子模块内的具体业务实现。
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  getTrustedDeviceCount,
  initializeAuth,
  completePairingRequest,
  listDevices,
  registerSocket,
  revokeDevice,
  revokeToken,
  startPairingRequest,
  unregisterSocket,
  verifyToken
} from './auth.js';
import {
  clientRemoteAddress,
  isPrivateRemoteAddress,
  isRequestTransportSecure,
  normalizeRemoteAddress,
  readSecurityOptions,
  requestMayUsePublicHttp,
  sameOriginAllowed
} from './security-options.js';
import {
  buildAuthCookie,
  clearAuthCookie,
  extractCookieToken,
  extractRequestToken,
  rejectSuspiciousFetchSite,
  rejectUnsafeOrigin,
  setSecurityHeaders
} from './request-security.js';
import {
  applySessionTitleUpdate,
  deleteSession,
  getCacheSnapshot,
  getHostName,
  getProject,
  getSession,
  hideSessionMessage,
  listArchivedSessions,
  listProjectSessions,
  listProjects,
  readSessionMessages,
  rememberLiveSession,
  refreshCodexCache,
  renameSession,
  unarchiveSession
} from './codex-data.js';
import { getCodexQuota } from './codex-quota.js';
import {
  modelSettingsKey,
  readCodexConfig,
  readCodexModelSettings,
  readCodexThreadModelSettings,
  writeCodexModelSettings
} from './codex-config.js';
import { getDesktopBridgeStatus } from './codex-app-server.js';
import { createChatRouteHandler } from './chat-routes.js';
import { createFeishuIntegration } from './feishu-routes.js';
import { createFileRouteHandler, isReadonlyLocalFileRoute } from './file-routes.js';
import { createGitRouteHandler } from './git-routes.js';
import { createGitService } from './git-service.js';
import { createNotificationRouteHandler } from './notification-routes.js';
import { createSessionRouteHandler } from './session-routes.js';
import { createUpdateRouteHandler } from './update-routes.js';
import { createUpdateService } from './update-service.js';
import { createVoiceRouteHandler } from './voice-routes.js';
import { abortCodexTurn, getActiveRuns, runCodexTurn, steerCodexTurn } from './codex-runner.js';
import { setDesktopFollowerModelAndReasoning } from './desktop-ipc-client.js';
import { GENERATED_ROOT, isImageRequest, runImageTurn } from './image-generator.js';
import { useLegacyImageGenerator } from './codex-native-images.js';
import { getLarkDocsStatus, logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { publicVoiceTranscriptionStatus } from './voice-transcriber.js';
import { publicVoiceSpeechStatus } from './voice-speaker.js';
import { publicVoiceRealtimeStatus, startVoiceRealtimeProxy } from './realtime-voice.js';
import { maybeAutoNameSession } from './session-title-generator.js';
import { createChatService } from './chat-service.js';
import { createDesktopIpcBroadcastListener } from './desktop-ipc-broadcast-listener.js';
import {
  configureRuntimeDebug,
  getRuntimeDebugPublicState,
  runtimeDebugStatusActiveRuns,
  setRuntimeDebugUiEnabled
} from './runtime-debug.js';
import {
  configureDesktopRefresh,
  getDesktopRefreshPublicState,
  openDesktopThread,
  setDesktopRefreshEnabled
} from './desktop-refresh.js';
import { readBody, sendJson } from './http-utils.js';
import { createPushService } from './push-service.js';
import { createStaticService } from './static-service.js';
import { createSyncBridge } from './sync/sync-bridge.js';
import { createSyncEventPayload } from './sync/sync-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
configureRuntimeDebug({ rootDir: ROOT_DIR });
configureDesktopRefresh({ rootDir: ROOT_DIR });
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');
const UPLOAD_ROOT = path.join(ROOT_DIR, '.codexmobile', 'uploads');
const IMAGE_PROMPT_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'image-prompts.json');
const FEISHU_AUTH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'feishu-auth.json');
const PUSH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'push-notifications.json');
const PORT = Number(process.env.PORT || 3321);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HTTPS_PFX_PATH = process.env.HTTPS_PFX_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'server.pfx');
const HTTPS_ROOT_CA_PATH = process.env.HTTPS_ROOT_CA_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'codexmobile-root-ca.cer');
const HTTPS_PFX_PASSPHRASE = process.env.HTTPS_PFX_PASSPHRASE || 'codexmobile-local-https';
const PUBLIC_URL = process.env.CODEXMOBILE_PUBLIC_URL || '';
const FEISHU_APP_ID = String(process.env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
const FEISHU_APP_SECRET = String(process.env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();
const FEISHU_REDIRECT_URI = String(process.env.CODEXMOBILE_FEISHU_REDIRECT_URI || '').trim();
const FEISHU_DOCS_HOME_URL = process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/';
const PUSH_SUBJECT = String(process.env.CODEXMOBILE_PUSH_SUBJECT || PUBLIC_URL || 'mailto:codexmobile@localhost').trim();
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const SYNC_RESPONSE_TIMEOUT_MS = Math.max(1000, Number(process.env.CODEXMOBILE_SYNC_RESPONSE_TIMEOUT_MS) || 12_000);
const securityOptions = readSecurityOptions();
let syncRefreshPromise = null;

const sockets = new Set();
const staticService = createStaticService({
  clientDist: CLIENT_DIST,
  generatedRoot: GENERATED_ROOT,
  httpsRootCaPath: HTTPS_ROOT_CA_PATH
});
const gitService = createGitService({ getProject });
const updateService = createUpdateService({ rootDir: ROOT_DIR });
const pushService = createPushService({
  statePath: PUSH_STATE,
  subject: PUSH_SUBJECT
});

function quotePosixPath(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_/:.,@%+=\\\-\u4e00-\u9fff]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function quoteWindowsPath(value) {
  const text = String(value || '');
  if (!/[\s"&<>|^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function pairingTerminalStatus() {
  const cwd = ROOT_DIR;
  const target = process.platform === 'win32' ? quoteWindowsPath(cwd) : quotePosixPath(cwd);
  return {
    cwd,
    commands: [
      process.platform === 'win32' ? `cd /d ${target}` : `cd ${target}`,
      'npm run pair'
    ]
  };
}
const syncBridge = createSyncBridge();
const feishuIntegration = createFeishuIntegration({
  statePath: FEISHU_AUTH_STATE,
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  redirectUri: FEISHU_REDIRECT_URI,
  publicUrl: PUBLIC_URL,
  docsHomeUrl: FEISHU_DOCS_HOME_URL,
  getLarkDocsStatus,
  startLarkCliAuth,
  logoutLarkCli,
  requestOrigin,
  remoteAddress
});
let statusConfigFallback = null;
let liveModelSettings = null;
let lastObservedModelSettingsKey = '';
const lastObservedThreadModelSettingsKeys = new Map();

async function getStatusConfigFallback() {
  if (!statusConfigFallback) {
    statusConfigFallback = readCodexConfig().catch((error) => {
      console.warn('[server] Failed to read status config fallback:', error.message);
      statusConfigFallback = null;
      return null;
    });
  }
  return statusConfigFallback;
}
function fallbackModels(config) {
  const model = config.model || 'gpt-5.5';
  return [{ value: model, label: model }];
}

function publicModelSettings(settings = {}, extra = {}) {
  const model = String(settings.model || 'gpt-5.5').trim() || 'gpt-5.5';
  const reasoningEffort = String(settings.reasoningEffort || DEFAULT_REASONING_EFFORT).trim() || DEFAULT_REASONING_EFFORT;
  return {
    provider: String(settings.provider || 'codex').trim() || 'codex',
    model,
    modelShort: settings.modelShort || `${model.replace(/^gpt-/i, '').replace(/-codex.*$/i, '').replace(/-mini$/i, ' mini')} 中`,
    reasoningEffort,
    ...(settings.sessionId ? { sessionId: String(settings.sessionId) } : {}),
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

function mergeStatusModelSettings(config = {}) {
  const settings = liveModelSettings || publicModelSettings(config);
  return {
    ...config,
    ...settings,
    reasoningEffort: settings.reasoningEffort || config.reasoningEffort || DEFAULT_REASONING_EFFORT
  };
}

function normalizeReasoningEffort(value) {
  const text = String(value || '').trim();
  return ['low', 'medium', 'high', 'xhigh', 'minimal'].includes(text) ? text : null;
}

function normalizeRequestedModel(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const trustedForwarded = securityOptions.trustedProxyCidrs?.length ? forwardedProto : '';
  const proto = trustedForwarded || (req.socket.encrypted ? 'https' : 'http');
  const host = securityOptions.trustedProxyCidrs?.length && req.headers['x-forwarded-host']
    ? req.headers['x-forwarded-host']
    : req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function remoteAddress(req) {
  return clientRemoteAddress(req, securityOptions);
}

function isLoopbackAddress(value) {
  const address = normalizeRemoteAddress(value);
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function authCookieOptions(req) {
  return {
    secure: isRequestTransportSecure(req, securityOptions),
    maxAgeSeconds: Math.floor(securityOptions.tokenTtlMs / 1000)
  };
}

function requestToken(req) {
  return extractRequestToken(req, { allowBearer: securityOptions.legacyBearerEnabled });
}

function setResponseCookie(res, cookieValue) {
  const previous = res.getHeader('set-cookie');
  if (!previous) {
    res.setHeader('set-cookie', cookieValue);
    return;
  }
  const next = Array.isArray(previous) ? [...previous, cookieValue] : [previous, cookieValue];
  res.setHeader('set-cookie', next);
}

async function authenticateRequest(req, res = null, { rotate = true } = {}) {
  const requestAuth = requestToken(req);
  const result = await verifyToken(requestAuth.token, {
    remoteAddress: remoteAddress(req),
    userAgent: req.headers['user-agent'],
    securityOptions,
    rotate
  });
  if (!result.ok) {
    return { ok: false, token: requestAuth.token, source: requestAuth.source };
  }
  if (res && result.replacementToken) {
    setResponseCookie(res, buildAuthCookie(result.replacementToken, authCookieOptions(req)));
  } else if (res && requestAuth.source === 'bearer') {
    setResponseCookie(res, buildAuthCookie(requestAuth.token, authCookieOptions(req)));
    res.setHeader('x-codexmobile-token-migrated', '1');
  }
  return { ...result, token: requestAuth.token, source: requestAuth.source };
}

async function isAuthenticated(req, url = null, res = null) {
  void url;
  return (await authenticateRequest(req, res)).ok;
}

async function requireAuth(req, res, pathname = '', url = null) {
  if (await isAuthenticated(req, url, res)) {
    return true;
  }
  if ((req.method || 'GET') !== 'GET') {
    console.warn(`[auth] rejected ${req.method || 'GET'} ${pathname || req.url || ''} remote=${remoteAddress(req)}`);
  }
  sendJson(res, 401, { error: 'Pairing required' });
  return false;
}

function broadcast(payload) {
  const outbound = payload?.type === 'app-server-message'
    ? syncBridge.consumeAppServerMessage(payload.appMessage, payload.context)
    : payload?.type === 'sync-event' && payload.event
      ? syncBridge.consumeSyncEvents([payload.event])
      : payload?.type === 'sync-state'
        ? [payload]
        : [];
  if (!outbound.length && !['sync-event', 'sync-state', 'app-server-message'].includes(payload?.type)) {
    console.warn(`[sync] Ignored non-sync broadcast payload: ${payload?.type || 'unknown'}`);
  }
  for (const item of outbound) {
    sendSocketPayload(item);
  }
  for (const item of outbound) {
    pushService.notifyForPayload(item).catch((error) => {
      console.warn('[push] Notification dispatch failed:', error.message);
    });
  }
}

function sendSocketPayload(payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
}

function broadcastModelSettings(settings, { source = 'server', desktopSync = null, sessionId = null } = {}) {
  const payload = {
    source,
    ...publicModelSettings(settings, sessionId ? { sessionId } : {}),
    desktopSync,
    timestamp: new Date().toISOString()
  };
  if (!payload.sessionId) {
    liveModelSettings = publicModelSettings(payload);
    lastObservedModelSettingsKey = modelSettingsKey(liveModelSettings);
  }
  const syncPayload = createSyncEventPayload('model.updated', payload, {
    model: payload.model || null,
    modelShort: payload.modelShort || null,
    reasoningEffort: payload.reasoningEffort || null,
    provider: payload.provider || null,
    desktopSync: payload.desktopSync || null
  });
  broadcast(syncPayload);
  return syncPayload.event;
}

function startModelSettingsWatcher() {
  async function tick() {
    try {
      const settings = publicModelSettings(await readCodexModelSettings(), { source: 'codex-config' });
      const key = modelSettingsKey(settings);
      if (!lastObservedModelSettingsKey) {
        liveModelSettings = settings;
        lastObservedModelSettingsKey = key;
        return;
      }
      if (key === lastObservedModelSettingsKey) {
        return;
      }
      statusConfigFallback = null;
      broadcastModelSettings(settings, { source: 'desktop-config' });
    } catch (error) {
      console.warn('[model-settings] Watch failed:', error.message);
    }
  }
  tick();
  const timer = setInterval(tick, 2500);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function startThreadModelSettingsWatcher() {
  async function tick() {
    try {
      const settingsRows = await readCodexThreadModelSettings({ limit: 250 });
      const seen = new Set();
      for (const settings of settingsRows) {
        if (!settings.sessionId) {
          continue;
        }
        seen.add(settings.sessionId);
        const key = modelSettingsKey(settings);
        const previousKey = lastObservedThreadModelSettingsKeys.get(settings.sessionId);
        lastObservedThreadModelSettingsKeys.set(settings.sessionId, key);
        if (!previousKey || previousKey === key) {
          continue;
        }
        broadcastModelSettings(settings, {
          source: 'desktop-thread',
          sessionId: settings.sessionId
        });
      }
      for (const sessionId of lastObservedThreadModelSettingsKeys.keys()) {
        if (!seen.has(sessionId)) {
          lastObservedThreadModelSettingsKeys.delete(sessionId);
        }
      }
    } catch (error) {
      console.warn('[model-settings] Thread watch failed:', error.message);
    }
  }
  tick();
  const timer = setInterval(tick, 2500);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

const chatService = createChatService({
  imagePromptState: IMAGE_PROMPT_STATE,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  uploadRoot: UPLOAD_ROOT,
  getProject,
  getSession,
  getCacheSnapshot,
  getDesktopBridgeStatus,
  listProjectSessions,
  readSessionMessages,
  refreshCodexCache,
  renameSession,
  broadcast,
  runCodexTurn,
  abortCodexTurn,
  getActiveRuns,
  steerCodexTurn,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession,
  rememberLiveSession
});

function desktopBroadcastSessionId(message = {}) {
  const params = message.params || {};
  const change = params.change || params.state || params.thread || {};
  return String(
    params.conversationId ||
    params.conversation_id ||
    params.threadId ||
    params.thread_id ||
    params.sessionId ||
    params.session_id ||
    change.conversationId ||
    change.conversation_id ||
    change.threadId ||
    change.thread_id ||
    change.sessionId ||
    change.session_id ||
    ''
  ).trim();
}

function desktopBroadcastRuntimeStatus(message = {}) {
  const params = message.params || {};
  const change = params.change || params.state || params.thread || {};
  const status = String(
    params.status ||
    params.streamState ||
    params.stream_state ||
    change.status ||
    change.streamState ||
    change.stream_state ||
    ''
  ).toLowerCase();
  if (['running', 'queued', 'streaming', 'active'].includes(status)) {
    return 'running';
  }
  if (['completed', 'complete', 'success', 'succeeded', 'idle', 'stopped'].includes(status)) {
    return 'completed';
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) {
    return 'failed';
  }
  if (params.isStreaming === false || params.streaming === false || change.isStreaming === false || change.streaming === false) {
    return 'completed';
  }
  return '';
}

function desktopBroadcastIsThreadStateChange(message = {}) {
  return ['thread-stream-state-changed', 'thread-read-state-changed'].includes(String(message.method || ''));
}

function syncStateHasDesktopRuntime(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) {
    return false;
  }
  const runtimeById = syncBridge.publicState()?.runtimeById || {};
  return Object.values(runtimeById).some(
    (runtime) => runtime?.source === 'desktop-ipc' && String(runtime?.sessionId || '') === id
  );
}

async function refreshAfterDesktopThreadStateChange({ sessionId, projectId, inferIdleCompletion = false } = {}) {
  const snapshot = await startSyncRefresh();
  if (snapshot?.projects) {
    broadcast(createSyncEventPayload('sessions.synced', {
      source: 'desktop-ipc',
      syncedAt: snapshot.syncedAt,
      projects: snapshot.projects
    }, {
      syncedAt: snapshot.syncedAt,
      projects: snapshot.projects
    }));
  }
  if (!inferIdleCompletion || !sessionId) {
    return;
  }
  const refreshedSession = getSession(sessionId);
  if (!refreshedSession || refreshedSession.runtime?.status === 'running') {
    return;
  }
  broadcast(createSyncEventPayload('turn.completed', {
    source: 'desktop-ipc',
    sessionId,
    projectId: projectId || refreshedSession.projectId || null,
    status: 'completed',
    timestamp: new Date().toISOString()
  }));
}

const desktopIpcBroadcastListener = createDesktopIpcBroadcastListener({
  async onBroadcast(message) {
    const params = message.params || {};
    if (desktopBroadcastIsThreadStateChange(message)) {
      const sessionId = desktopBroadcastSessionId(message);
      if (!sessionId) {
        return;
      }
      const session = getSession(sessionId);
      const status = desktopBroadcastRuntimeStatus(message);
      const eventType = status === 'completed'
        ? 'turn.completed'
        : status === 'failed'
          ? 'turn.failed'
          : status === 'running'
            ? 'turn.running'
            : 'thread.updated';
      broadcast(createSyncEventPayload(eventType, {
        source: 'desktop-ipc',
        appMethod: message.method,
        sessionId,
        projectId: params.projectId || params.project_id || session?.projectId || null,
        status: status || undefined,
        timestamp: new Date().toISOString()
      }));
      const shouldRefresh =
        (status && status !== 'running') ||
        (!status && syncStateHasDesktopRuntime(sessionId));
      if (shouldRefresh) {
        refreshAfterDesktopThreadStateChange({
          sessionId,
          projectId: params.projectId || params.project_id || session?.projectId || null,
          inferIdleCompletion: !status
        }).catch((error) => {
          console.warn('[desktop-ipc] sync refresh after thread state change failed:', error.message);
        });
      }
      return;
    }
    if (message?.method !== 'thread-title-updated') {
      return;
    }
    const sessionId = String(params.conversationId || params.threadId || '').trim();
    const title = String(params.title || params.name || '').trim();
    if (!sessionId || !title) {
      return;
    }
    const renamed = await applySessionTitleUpdate(sessionId, title, { projectId: params.projectId || null });
    if (!renamed?.projectId) {
      return;
    }
    broadcast(createSyncEventPayload('thread.renamed', {
      source: 'desktop-ipc',
      projectId: renamed.projectId,
      sessionId: renamed.id,
      title: renamed.title,
      titleLocked: renamed.titleLocked,
      updatedAt: renamed.updatedAt,
      session: renamed
    }, {
      title: renamed.title,
      titleLocked: renamed.titleLocked,
      session: renamed
    }));
    const snapshot = getCacheSnapshot();
    broadcast(createSyncEventPayload('sessions.synced', {
      source: 'desktop-ipc',
      syncedAt: snapshot.syncedAt,
      projects: snapshot.projects
    }, {
      syncedAt: snapshot.syncedAt,
      projects: snapshot.projects
    }));
  }
});
const handleNotificationApi = createNotificationRouteHandler({
  pushService,
  remoteAddress
});
const handleSessionApi = createSessionRouteHandler({
  listProjects,
  getProject,
  getSession,
  listProjectSessions,
  renameSession,
  deleteSession,
  unarchiveSession,
  listArchivedSessions,
  hideSessionMessage,
  readSessionMessages,
  refreshCodexCache,
  broadcast,
  chatService
});
const handleGitApi = createGitRouteHandler({ gitService });
const handleUpdateApi = createUpdateRouteHandler({ updateService });
const handleFileApi = createFileRouteHandler({
  getProject,
  staticService,
  uploadRoot: UPLOAD_ROOT,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  remoteAddress
});
const handleVoiceApi = createVoiceRouteHandler({
  getCacheSnapshot,
  maxVoiceBytes: MAX_VOICE_BYTES,
  remoteAddress
});
const handleChatApi = createChatRouteHandler({
  chatService,
  remoteAddress
});

function startSyncRefresh() {
  if (!syncRefreshPromise) {
    syncRefreshPromise = refreshCodexCache().finally(() => {
      syncRefreshPromise = null;
    });
  }
  return syncRefreshPromise;
}

async function refreshCodexCacheForSyncResponse() {
  const currentSnapshot = getCacheSnapshot();
  if (currentSnapshot.projects?.length) {
    startSyncRefresh()
      .then((snapshot) => {
        broadcast(createSyncEventPayload('sessions.synced', {
          source: 'server',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }, {
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }));
      })
      .catch((error) => {
        console.warn('[sync] Background refresh failed:', error.message);
      });
    return { timedOut: false, snapshot: currentSnapshot, staleWhileRevalidate: true };
  }
  const refresh = startSyncRefresh();
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true, snapshot: getCacheSnapshot() });
    }, SYNC_RESPONSE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  const result = await Promise.race([
    refresh
      .then((snapshot) => ({ timedOut: false, snapshot }))
      .catch((error) => ({ timedOut: false, snapshot: getCacheSnapshot(), error })),
    timeout
  ]);
  if (result.error) {
    console.warn('[sync] Refresh failed:', result.error.message);
  }
  if (result.timedOut) {
    refresh
      .then((snapshot) => {
        broadcast(createSyncEventPayload('sessions.synced', {
          source: 'server',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }, {
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }));
      })
      .catch((error) => {
        console.warn('[sync] Background refresh failed:', error.message);
      });
  }
  return result;
}

async function publicStatus(authenticated, req = null) {
  const snapshot = getCacheSnapshot();
  const config = mergeStatusModelSettings(snapshot.config || await getStatusConfigFallback() || {});
  const desktopBridge = await getDesktopBridgeStatus();
  syncBridge.setBridgeStatus(desktopBridge);
  const activeRuns = [
    ...getActiveRuns(),
    ...chatService.getActiveImageRuns()
  ];
  runtimeDebugStatusActiveRuns(activeRuns);
  return {
    connected: true,
    desktopBridge,
    hostName: getHostName(),
    port: PORT,
    pairing: pairingTerminalStatus(),
    provider: config.provider || 'codex',
    model: config.model || 'gpt-5.5',
    modelShort: config.modelShort || '5.5 中',
    models: config.models?.length ? config.models : fallbackModels(config),
    skills: Array.isArray(config.skills) ? config.skills : [],
    context: config.context || null,
    reasoningEffort: config.reasoningEffort || DEFAULT_REASONING_EFFORT,
    voiceTranscription: publicVoiceTranscriptionStatus(config),
    voiceSpeech: publicVoiceSpeechStatus(config),
    voiceRealtime: publicVoiceRealtimeStatus(config),
    docs: await feishuIntegration.publicDocsStatus(authenticated),
    syncedAt: snapshot.syncedAt,
    activeRuns,
    localHeadlessRuns: activeRuns,
    syncState: syncBridge.publicState(),
    runtimeDebug: getRuntimeDebugPublicState(),
    desktopRefresh: getDesktopRefreshPublicState(),
    auth: {
      required: true,
      authenticated,
      trustedDevices: getTrustedDeviceCount(),
      canPair: req
        ? securityOptions.allowRemotePairing || isPrivateRemoteAddress(remoteAddress(req), securityOptions)
        : true
    },
    security: {
      publicAccess: securityOptions.publicAccess,
      publicUrl: securityOptions.publicUrl || '',
      dangerFullAccessEnabled: securityOptions.dangerFullAccessEnabled
    }
  };
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/status') {
    const authResult = await authenticateRequest(req, res);
    sendJson(res, 200, await publicStatus(authResult.ok, req));
    return;
  }

  if (method === 'POST' && pathname === '/api/pair/request') {
    const body = await readBody(req);
    const result = await startPairingRequest({
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'],
      remoteAddress: remoteAddress(req),
      securityOptions
    });
    if (!result.ok) {
      if (result.retryAfterSeconds) {
        res.setHeader('retry-after', String(result.retryAfterSeconds));
      }
      sendJson(res, result.statusCode || 400, {
        error: result.error || 'Pairing request failed',
        retryAfterSeconds: result.retryAfterSeconds || null
      });
      return;
    }
    sendJson(res, 200, {
      requestId: result.requestId,
      codeLength: result.codeLength,
      expiresAt: result.expiresAt,
      requestCooldownSeconds: result.requestCooldownSeconds
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/pair/terminal-request') {
    if (!isLoopbackAddress(remoteAddress(req))) {
      sendJson(res, 403, { error: 'Terminal pairing is only available from this computer' });
      return;
    }
    const body = await readBody(req);
    const result = await startPairingRequest({
      deviceName: body.deviceName || 'Terminal pairing',
      userAgent: 'CodexMobile CLI',
      remoteAddress: remoteAddress(req),
      revealCode: true,
      securityOptions: {
        ...securityOptions,
        pairingMaxFailures: Math.max(securityOptions.pairingMaxFailures, 100),
        pairingRequestCooldownMs: 0
      }
    });
    if (!result.ok) {
      if (result.retryAfterSeconds) {
        res.setHeader('retry-after', String(result.retryAfterSeconds));
      }
      sendJson(res, result.statusCode || 400, {
        error: result.error || 'Terminal pairing request failed',
        retryAfterSeconds: result.retryAfterSeconds || null
      });
      return;
    }
    sendJson(res, 200, {
      requestId: result.requestId,
      code: result.code,
      codeLength: result.codeLength,
      expiresAt: result.expiresAt,
      requestCooldownSeconds: result.requestCooldownSeconds
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/pair') {
    const body = await readBody(req);
    const paired = await completePairingRequest({
      requestId: body.requestId,
      code: body.code,
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'] || '',
      remoteAddress: remoteAddress(req),
      securityOptions
    });
    if (!paired.ok) {
      if (paired.retryAfterSeconds) {
        res.setHeader('retry-after', String(paired.retryAfterSeconds));
      }
      sendJson(res, paired.statusCode || 403, {
        error: paired.error || 'Invalid pairing code',
        retryAfterSeconds: paired.retryAfterSeconds || null
      });
      return;
    }
    setResponseCookie(res, buildAuthCookie(paired.token, authCookieOptions(req)));
    res.setHeader('x-codexmobile-token-migrated', '1');
    sendJson(res, 200, { success: true, device: paired.device });
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/auth/callback') {
    await feishuIntegration.handleCallback(req, res, url);
    return;
  }

  if (isReadonlyLocalFileRoute(method, pathname) && await handleFileApi(req, res, url)) {
    return;
  }

  if (!(await requireAuth(req, res, pathname, url))) {
    return;
  }

  if (method === 'GET' && pathname === '/api/devices') {
    const token = requestToken(req).token;
    sendJson(res, 200, { devices: listDevices({ currentToken: token }) });
    return;
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const token = extractCookieToken(req) || requestToken(req).token;
    if (token) {
      await revokeToken(token);
    }
    setResponseCookie(res, clearAuthCookie(authCookieOptions(req)));
    res.setHeader('x-codexmobile-token-migrated', '1');
    sendJson(res, 200, { success: true });
    return;
  }

  const revokeMatch = pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (method === 'POST' && revokeMatch) {
    const result = await revokeDevice(decodeURIComponent(revokeMatch[1]));
    if (!result.ok) {
      sendJson(res, 404, { error: 'Device not found' });
      return;
    }
    sendJson(res, 200, { success: true, deviceId: result.deviceId });
    return;
  }

  const deleteDeviceMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (method === 'DELETE' && deleteDeviceMatch) {
    const result = await revokeDevice(decodeURIComponent(deleteDeviceMatch[1]));
    if (!result.ok) {
      sendJson(res, 404, { error: 'Device not found' });
      return;
    }
    sendJson(res, 200, { success: true, deviceId: result.deviceId });
    return;
  }

  if (method === 'POST' && pathname === '/api/runtime-debug') {
    const body = await readBody(req);
    setRuntimeDebugUiEnabled(Boolean(body.enabled));
    sendJson(res, 200, getRuntimeDebugPublicState());
    return;
  }

  if (method === 'POST' && pathname === '/api/desktop-refresh') {
    const body = await readBody(req);
    const desktopRefresh = setDesktopRefreshEnabled(Boolean(body.enabled));
    sendJson(res, 200, { success: true, desktopRefresh });
    return;
  }

  if (method === 'POST' && pathname === '/api/desktop-handoff') {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || body.threadId || '').trim();
    const result = await openDesktopThread(sessionId, { reason: 'manual-desktop-handoff' });
    if (result.triggered) {
      sendJson(res, 200, { success: true, ...result });
      return;
    }
    const statusCode = result.reason === 'desktop-refresh-missing-thread'
      ? 400
      : result.reason === 'desktop-refresh-unsupported-platform'
        ? 501
        : 500;
    sendJson(res, statusCode, {
      success: false,
      error: result.error || '无法打开桌面端对话',
      code: result.reason || 'desktop-handoff-failed',
      ...result
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/model-settings') {
    const body = await readBody(req);
    const baseConfig = mergeStatusModelSettings(getCacheSnapshot().config || await getStatusConfigFallback() || {});
    const model = normalizeRequestedModel(body.model) || normalizeRequestedModel(baseConfig.model);
    const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort) || normalizeReasoningEffort(baseConfig.reasoningEffort) || DEFAULT_REASONING_EFFORT;
    if (!model) {
      sendJson(res, 400, { error: 'Invalid model setting', code: 'CODEXMOBILE_INVALID_MODEL' });
      return;
    }

    const written = publicModelSettings(await writeCodexModelSettings({ model, reasoningEffort }), { source: 'mobile' });
    statusConfigFallback = null;
    let desktopSync = { attempted: false, synced: false, error: null };
    const sessionId = String(body.sessionId || body.conversationId || '').trim();
    const desktopBridge = await getDesktopBridgeStatus();
    if (sessionId && desktopBridge?.connected && desktopBridge?.capabilities?.sendToOpenDesktopThread) {
      desktopSync = { attempted: true, synced: false, error: null };
      try {
        await setDesktopFollowerModelAndReasoning(sessionId, written.model, written.reasoningEffort, { timeoutMs: 2500 });
        desktopSync.synced = true;
      } catch (error) {
        desktopSync.error = error.code || error.message || 'desktop-sync-failed';
        console.warn('[model-settings] Desktop IPC model sync failed:', error.message);
      }
    }
    const payload = broadcastModelSettings(written, { source: 'mobile', desktopSync });
    sendJson(res, 200, { success: true, settings: payload, desktopSync });
    return;
  }

  if (method === 'POST' && pathname === '/api/sync') {
    const result = await refreshCodexCacheForSyncResponse();
    const { snapshot, timedOut } = result;
    if (!timedOut) {
      broadcast(createSyncEventPayload('sessions.synced', {
        source: 'server',
        syncedAt: snapshot.syncedAt,
        projects: snapshot.projects
      }, {
        syncedAt: snapshot.syncedAt,
        projects: snapshot.projects
      }));
    }
    sendJson(res, 200, { success: !timedOut && !result.error, pending: timedOut, error: result.error?.message || null, ...snapshot });
    return;
  }

  if (await handleNotificationApi(req, res, url)) {
    return;
  }

  if (await handleSessionApi(req, res, url)) {
    return;
  }

  if (await handleGitApi(req, res, url)) {
    return;
  }

  if (await handleUpdateApi(req, res, url)) {
    return;
  }

  if (method === 'GET' && pathname === '/api/quotas/codex') {
    try {
      sendJson(res, 200, await getCodexQuota());
    } catch (error) {
      console.warn(`[quota] codex quota failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
      sendJson(res, 500, { error: 'Failed to query Codex quota' });
    }
    return;
  }

  if (await handleFileApi(req, res, url)) {
    return;
  }

  if (await feishuIntegration.handleApi(req, res, url)) {
    return;
  }

  if (await handleVoiceApi(req, res, url)) {
    return;
  }

  if (await handleChatApi(req, res, url)) {
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    const secureRequest = isRequestTransportSecure(req, securityOptions);
    const requestSecurityOptions = {
      ...securityOptions,
      allowedOrigins: [...new Set([requestOrigin(req), ...(securityOptions.allowedOrigins || [])].filter(Boolean))]
    };
    setSecurityHeaders(res, url.pathname === '/preview/file'
      ? { secure: secureRequest, frameAncestors: "'self'", frameOptions: 'SAMEORIGIN' }
      : { secure: secureRequest });
    if (!requestMayUsePublicHttp(req, requestSecurityOptions)) {
      sendJson(res, 403, { error: 'HTTPS is required for public access' });
      return;
    }
    const originRejection = rejectUnsafeOrigin(req, requestSecurityOptions);
    if (originRejection) {
      sendJson(res, originRejection.statusCode, { error: originRejection.error });
      return;
    }
    const fetchSiteRejection = rejectSuspiciousFetchSite(req);
    if (fetchSiteRejection) {
      sendJson(res, fetchSiteRejection.statusCode, { error: fetchSiteRejection.error });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await staticService.serveStatic(req, res, url);
  } catch (error) {
    console.error('[server] Request failed:', error);
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  const auth = await initializeAuth();
  await feishuIntegration.loadState();
  await chatService.loadRecentImagePrompts();

  const server = http.createServer(requestHandler);
  const wss = new WebSocketServer({ noServer: true });
  const realtimeWss = new WebSocketServer({ noServer: true });

  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname !== '/ws' && url.pathname !== '/ws/realtime') {
      socket.destroy();
      return;
    }
    const requestSecurityOptions = {
      ...securityOptions,
      allowedOrigins: [...new Set([requestOrigin(req), ...(securityOptions.allowedOrigins || [])].filter(Boolean))]
    };
    if (!requestMayUsePublicHttp(req, requestSecurityOptions) || !sameOriginAllowed(req.headers.origin, requestSecurityOptions)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const authResult = await authenticateRequest(req, null, { rotate: false });
    if (!authResult.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname === '/ws/realtime') {
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      sockets.add(ws);
      registerSocket(authResult.tokenHash, ws);
      ws.on('close', () => {
        sockets.delete(ws);
        unregisterSocket(authResult.tokenHash, ws);
      });
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true, req) }));
      ws.send(JSON.stringify(syncBridge.publicStatePayload()));
    });
  };

  server.on('upgrade', handleUpgrade);
  desktopIpcBroadcastListener.start();
  startModelSettingsWatcher();
  startThreadModelSettingsWatcher();

  server.listen(PORT, HOST, () => {
    console.log(`CodexMobile listening on http://${HOST}:${PORT}`);
    console.log(`Trusted devices: ${auth.trustedDevices}. Run npm run pair to create a pairing code.`);
    console.log('Use Tailscale and open http://<this-pc-tailscale-ip>:3321 on iPhone.');
  });

  refreshCodexCache().catch((error) => {
    console.warn('[server] Initial sync failed:', error.message);
  });

  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    const httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
      if (PUBLIC_URL) {
        console.log(`Public/private URL: ${PUBLIC_URL}`);
      } else {
        console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
