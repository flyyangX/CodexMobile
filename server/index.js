import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  getTrustedDeviceCount,
  initializeAuth,
  listDevices,
  registerSocket,
  completePairingRequest,
  revokeDevice,
  revokeToken,
  startPairingRequest,
  unregisterSocket,
  verifyToken
} from './auth.js';
import {
  deleteSession,
  getCacheSnapshot,
  getHostName,
  getProject,
  getSession,
  hideSessionMessage,
  listProjectSessions,
  listProjects,
  readSessionMessages,
  rememberLiveSession,
  refreshCodexCache,
  renameSession
} from './codex-data.js';
import { getCodexQuota } from './codex-quota.js';
import { readCodexConfig } from './codex-config.js';
import { getDesktopBridgeStatus } from './codex-app-server.js';
import { createChatRouteHandler } from './chat-routes.js';
import { createFeishuIntegration } from './feishu-routes.js';
import { createFileRouteHandler } from './file-routes.js';
import { createGitRouteHandler } from './git-routes.js';
import { createGitService } from './git-service.js';
import { createNotificationRouteHandler } from './notification-routes.js';
import { createSessionRouteHandler } from './session-routes.js';
import { createVoiceRouteHandler } from './voice-routes.js';
import { abortCodexTurn, getActiveRuns, runCodexTurn, steerCodexTurn } from './codex-runner.js';
import {
  interruptDesktopFollowerTurn,
  setDesktopFollowerCollaborationMode,
  setDesktopFollowerModelAndReasoning,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn
} from './desktop-ipc-client.js';
import { GENERATED_ROOT, isImageRequest, runImageTurn } from './image-generator.js';
import { useLegacyImageGenerator } from './codex-native-images.js';
import { getLarkDocsStatus, logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { publicVoiceTranscriptionStatus } from './voice-transcriber.js';
import { publicVoiceSpeechStatus } from './voice-speaker.js';
import { publicVoiceRealtimeStatus, startVoiceRealtimeProxy } from './realtime-voice.js';
import { maybeAutoNameSession } from './session-title-generator.js';
import { createChatService } from './chat-service.js';
import { readBody, sendJson } from './http-utils.js';
import { createPushService } from './push-service.js';
import { createStaticService } from './static-service.js';
import { readServerOptions, resolveHttpListenHost, serverOptionsHelp } from './server-options.js';
import {
  clientRemoteAddress,
  isPrivateRemoteAddress,
  isRequestTransportSecure,
  readSecurityOptions,
  requestMayUsePublicHttp,
  sameOriginAllowed
} from './security-options.js';
import {
  buildAuthCookie,
  clearAuthCookie,
  extractRequestToken,
  rejectSuspiciousFetchSite,
  rejectUnsafeOrigin,
  setSecurityHeaders
} from './request-security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');
const UPLOAD_ROOT = path.join(ROOT_DIR, '.codexmobile', 'uploads');
const DESKTOP_IMAGE_ROOT = path.join(ROOT_DIR, '.codexmobile', 'desktop-images');
const IMAGE_PROMPT_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'image-prompts.json');
const FEISHU_AUTH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'feishu-auth.json');
const PUSH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'push-notifications.json');
let serverOptions = null;
try {
  serverOptions = readServerOptions();
} catch (error) {
  console.error(`[server] ${error.message}`);
  console.error(serverOptionsHelp());
  process.exit(1);
}
if (serverOptions.help) {
  console.log(serverOptionsHelp());
  process.exit(0);
}
const PORT = serverOptions.port;
const HOST = serverOptions.host;
const HTTPS_PORT = serverOptions.httpsPort;
let actualHttpHost = HOST;
const HTTPS_PFX_PATH = process.env.HTTPS_PFX_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'server.pfx');
const HTTPS_ROOT_CA_PATH = process.env.HTTPS_ROOT_CA_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'codexmobile-root-ca.cer');
const HTTPS_PFX_PASSPHRASE = process.env.HTTPS_PFX_PASSPHRASE || 'codexmobile-local-https';
const PUBLIC_URL = process.env.CODEXMOBILE_PUBLIC_URL || '';
const APP_VERSION = process.env.npm_package_version || '1.2.0';
const FEISHU_APP_ID = String(process.env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
const FEISHU_APP_SECRET = String(process.env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();
const FEISHU_REDIRECT_URI = String(process.env.CODEXMOBILE_FEISHU_REDIRECT_URI || '').trim();
const FEISHU_DOCS_HOME_URL = process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/';
const PUSH_SUBJECT = String(process.env.CODEXMOBILE_PUSH_SUBJECT || PUBLIC_URL || 'mailto:codexmobile@localhost').trim();
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const SYNC_RESPONSE_TIMEOUT_MS = Math.max(1000, Number(process.env.CODEXMOBILE_SYNC_RESPONSE_TIMEOUT_MS) || 12_000);
const securityOptions = withLocalAllowedOrigins(readSecurityOptions());
let syncRefreshPromise = null;

const sockets = new Set();
const staticService = createStaticService({
  clientDist: CLIENT_DIST,
  generatedRoot: GENERATED_ROOT,
  desktopImageRoot: DESKTOP_IMAGE_ROOT,
  uploadRoot: UPLOAD_ROOT,
  httpsRootCaPath: HTTPS_ROOT_CA_PATH
});
const gitService = createGitService({ getProject });
const pushService = createPushService({
  statePath: PUSH_STATE,
  subject: PUSH_SUBJECT
});
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

function listen(serverToStart, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      serverToStart.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      serverToStart.off('error', onError);
      resolve();
    };
    serverToStart.once('error', onError);
    serverToStart.once('listening', onListening);
    serverToStart.listen(port, host);
  });
}

function closeServer(serverToClose) {
  return new Promise((resolve) => {
    if (!serverToClose) {
      resolve();
      return;
    }
    try {
      serverToClose.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

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

function withLocalAllowedOrigins(options) {
  const localOrigins = [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `https://127.0.0.1:${HTTPS_PORT}`,
    `https://localhost:${HTTPS_PORT}`
  ];
  return {
    ...options,
    allowedOrigins: [...new Set([...(options.allowedOrigins || []), ...localOrigins].filter(Boolean))]
  };
}

function requestOrigin(req) {
  const proto = isRequestTransportSecure(req, securityOptions) ? 'https' : 'http';
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function requestHostname(req) {
  const host = String(req.headers.host || '').split(',')[0].trim();
  if (!host) {
    return '';
  }
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.replace(/^\[/, '').replace(/\]$/, '').split(':')[0];
  }
}

function securityOptionsForRequest(req) {
  const allowedOrigins = new Set(securityOptions.allowedOrigins || []);
  if (isPrivateRemoteAddress(requestHostname(req), securityOptions)) {
    allowedOrigins.add(requestOrigin(req));
  }
  return {
    ...securityOptions,
    allowedOrigins: [...allowedOrigins]
  };
}

function remoteAddress(req) {
  return clientRemoteAddress(req, securityOptions);
}

function requestToken(req) {
  return extractRequestToken(req, { allowBearer: securityOptions.legacyBearerEnabled });
}

async function authenticateRequest(req, res = null, { rotate = true } = {}) {
  const result = await verifyToken(requestToken(req), {
    remoteAddress: remoteAddress(req),
    userAgent: req.headers['user-agent'],
    securityOptions,
    rotate
  });
  if (res && result?.ok === true && result.replacementToken) {
    res.setHeader('set-cookie', buildAuthCookie(result.replacementToken, {
      secure: isRequestTransportSecure(req, securityOptions),
      maxAgeSeconds: Math.floor(securityOptions.tokenTtlMs / 1000)
    }));
  }
  return result;
}

async function isAuthenticated(req, res = null) {
  const result = await authenticateRequest(req, res);
  return result === true || result?.ok === true;
}

async function requireAuth(req, res, pathname = '') {
  if (await isAuthenticated(req, res)) {
    return true;
  }
  if ((req.method || 'GET') !== 'GET') {
    console.warn(`[auth] rejected ${req.method || 'GET'} ${pathname || req.url || ''} remote=${remoteAddress(req)}`);
  }
  sendJson(res, 401, { error: 'Pairing required' });
  return false;
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
  pushService.notifyForPayload(payload).catch((error) => {
    console.warn('[push] Notification dispatch failed:', error.message);
  });
}

const chatService = createChatService({
  imagePromptState: IMAGE_PROMPT_STATE,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
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
  setDesktopFollowerModelAndReasoning,
  setDesktopFollowerCollaborationMode,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  abortCodexTurn,
  getActiveRuns,
  steerCodexTurn,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession,
  rememberLiveSession,
  uploadRoot: UPLOAD_ROOT,
  dangerFullAccessEnabled: securityOptions.dangerFullAccessEnabled
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
  hideSessionMessage,
  readSessionMessages,
  refreshCodexCache,
  broadcast,
  chatService
});
const handleGitApi = createGitRouteHandler({ gitService });
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
        broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      })
      .catch((error) => {
        console.warn('[sync] Background refresh failed:', error.message);
      });
  }
  return result;
}

function publicSecurityStatus(req = null) {
  return {
    publicAccess: securityOptions.publicAccess,
    dangerFullAccessEnabled: securityOptions.dangerFullAccessEnabled,
    httpsEnabled: req ? isRequestTransportSecure(req, securityOptions) : false,
    pairing: {
      lanOnly: !securityOptions.allowRemotePairing
    }
  };
}

function securityPosture(req = null) {
  const secure = req ? isRequestTransportSecure(req, securityOptions) : false;
  return {
    publicAccess: securityOptions.publicAccess,
    dangerFullAccessEnabled: securityOptions.dangerFullAccessEnabled,
    httpsActive: secure,
    hstsEnabled: secure,
    cspReportOnly: process.env.CODEXMOBILE_CSP_REPORT_ONLY === '1',
    trustedProxyCount: securityOptions.trustedProxyCidrs.length,
    privateCidrsConfigured: securityOptions.privateCidrs.length,
    remotePairingAllowed: securityOptions.allowRemotePairing,
    httpListenHost: actualHttpHost,
    httpsPort: HTTPS_PORT
  };
}

function canPairFromRequest(req) {
  return isPrivateRemoteAddress(remoteAddress(req), securityOptions) || securityOptions.allowRemotePairing;
}

async function publicStatus(authenticated, req = null) {
  const auth = {
    required: true,
    authenticated,
    trustedDevices: authenticated ? getTrustedDeviceCount() : 0,
    canPair: req ? canPairFromRequest(req) : false
  };
  const security = publicSecurityStatus(req);
  if (!authenticated) {
    return { auth, security, version: APP_VERSION };
  }

  const snapshot = getCacheSnapshot();
  const config = snapshot.config || await getStatusConfigFallback() || {};
  const desktopBridge = await getDesktopBridgeStatus();
  return {
    connected: true,
    desktopBridge,
    hostName: getHostName(),
    port: PORT,
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
    activeRuns: [...getActiveRuns(), ...chatService.getActiveDesktopIpcRuns(), ...chatService.getActiveImageRuns()],
    security,
    auth,
    version: APP_VERSION
  };
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/status') {
    const authResult = await authenticateRequest(req, res);
    sendJson(res, 200, await publicStatus(authResult === true || authResult?.ok === true, req));
    return;
  }

  if (method === 'GET' && pathname === '/api/security/posture') {
    sendJson(res, 200, securityPosture(req));
    return;
  }

  if (method === 'POST' && pathname === '/api/pair/request') {
    const body = await readBody(req);
    const requested = await startPairingRequest({
      deviceName: body.deviceName || 'iPhone',
      userAgent: req.headers['user-agent'],
      remoteAddress: remoteAddress(req),
      securityOptions
    });
    if (!requested.ok) {
      sendJson(res, requested.statusCode, {
        error: requested.error,
        retryAfterSeconds: requested.retryAfterSeconds || null
      });
      return;
    }
    sendJson(res, 200, {
      requestId: requested.requestId,
      expiresAt: requested.expiresAt,
      codeLength: requested.codeLength,
      requestCooldownSeconds: requested.requestCooldownSeconds || 0
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/pair') {
    const body = await readBody(req);
    if (!body.requestId) {
      sendJson(res, 400, { error: 'Pairing request is required' });
      return;
    }
    const paired = await completePairingRequest({
      requestId: body.requestId,
      code: body.code,
      remoteAddress: remoteAddress(req),
      securityOptions
    });
    if (!paired || paired.ok === false) {
      sendJson(res, paired?.statusCode || 403, {
        error: paired?.error || 'Invalid pairing code',
        retryAfterSeconds: paired?.retryAfterSeconds || null
      });
      return;
    }
    res.setHeader('set-cookie', buildAuthCookie(paired.token, {
      secure: isRequestTransportSecure(req, securityOptions),
      maxAgeSeconds: Math.floor(securityOptions.tokenTtlMs / 1000)
    }));
    sendJson(res, 200, { device: paired.device });
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/auth/callback') {
    await feishuIntegration.handleCallback(req, res, url);
    return;
  }

  if (!(await requireAuth(req, res, pathname))) {
    return;
  }

  if (method === 'GET' && pathname === '/api/devices') {
    sendJson(res, 200, { devices: listDevices({ currentToken: requestToken(req) }) });
    return;
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const token = requestToken(req);
    if (token) {
      await revokeToken(token);
    }
    res.setHeader('set-cookie', clearAuthCookie({ secure: isRequestTransportSecure(req, securityOptions) }));
    sendJson(res, 200, { success: true });
    return;
  }

  const parts = pathname.split('/').filter(Boolean);

  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'devices' && parts[3] === 'revoke') {
    const token = requestToken(req);
    const deviceId = decodeURIComponent(parts[2]);
    const devicesBefore = listDevices({ currentToken: token });
    const currentRevoked = devicesBefore.some((device) => device.id === deviceId && device.current);
    const revoked = await revokeDevice(deviceId);
    if (!revoked.ok) {
      sendJson(res, 404, { error: 'Device not found' });
      return;
    }
    if (currentRevoked) {
      res.setHeader('set-cookie', clearAuthCookie({ secure: isRequestTransportSecure(req, securityOptions) }));
    }
    sendJson(res, 200, {
      success: true,
      currentRevoked,
      devices: currentRevoked ? [] : listDevices({ currentToken: token })
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/sync') {
    const result = await refreshCodexCacheForSyncResponse();
    const { snapshot, timedOut } = result;
    if (!timedOut) {
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
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
    setSecurityHeaders(res, {
      secure: isRequestTransportSecure(req, securityOptions),
      cspReportOnly: process.env.CODEXMOBILE_CSP_REPORT_ONLY === '1'
    });
    if (!requestMayUsePublicHttp(req, securityOptions)) {
      sendJson(res, 403, { error: 'Public access requires HTTPS' });
      return;
    }
    const fetchSiteRejection = rejectSuspiciousFetchSite(req, {
      protectSafeMethod: url.pathname.startsWith('/api/')
    });
    if (fetchSiteRejection) {
      sendJson(res, fetchSiteRejection.statusCode, { error: fetchSiteRejection.error });
      return;
    }
    const originRejection = rejectUnsafeOrigin(req, securityOptionsForRequest(req));
    if (originRejection) {
      sendJson(res, originRejection.statusCode, { error: originRejection.error });
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

    if (!requestMayUsePublicHttp(req, securityOptions)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = String(req.headers.origin || '').trim();
    if (!sameOriginAllowed(origin, securityOptionsForRequest(req))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const authResult = await verifyToken(requestToken(req), {
      remoteAddress: remoteAddress(req),
      userAgent: req.headers['user-agent'],
      securityOptions,
      rotate: false
    });
    if (!(authResult === true || authResult?.ok === true)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const tokenHash = authResult?.tokenHash || '';

    if (url.pathname === '/ws/realtime') {
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        registerSocket(tokenHash, ws);
        ws.on('close', () => unregisterSocket(tokenHash, ws));
        startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      registerSocket(tokenHash, ws);
      sockets.add(ws);
      ws.on('close', () => {
        unregisterSocket(tokenHash, ws);
        sockets.delete(ws);
      });
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true, req) }));
    });
  };

  server.on('upgrade', handleUpgrade);

  refreshCodexCache().catch((error) => {
    console.warn('[server] Initial sync failed:', error.message);
  });

  let httpsStarted = false;
  let httpsServer = null;
  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    await listen(httpsServer, HTTPS_PORT, HOST);
    httpsStarted = true;
    console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
    if (PUBLIC_URL) {
      console.log(`Public/private URL: ${PUBLIC_URL}`);
    } else {
      console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
    httpsServer = null;
  }

  const httpHost = resolveHttpListenHost({
    publicAccess: securityOptions.publicAccess,
    httpsStarted,
    host: HOST
  });
  try {
    await listen(server, PORT, httpHost);
    actualHttpHost = httpHost;
  } catch (error) {
    if (httpsStarted && httpsServer) {
      await closeServer(httpsServer);
    }
    throw error;
  }
  console.log(`CodexMobile listening on http://${httpHost}:${PORT}`);
  console.log(`Pairing: open CodexMobile from the same LAN, then click "请求配对码" to print a one-time console code (${auth.trustedDevices} trusted device(s)).`);
  console.log(`Use Tailscale and open http://<this-pc-tailscale-ip>:${PORT} on iPhone.`);
}

main().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
