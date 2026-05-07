import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  extractBearerToken,
  getPairingCode,
  getTrustedDeviceCount,
  initializeAuth,
  pairDevice,
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
  refreshCodexCache,
  renameSession
} from './codex-data.js';
import { getCodexQuota } from './codex-quota.js';
import { readCodexConfig } from './codex-config.js';
import { getDesktopBridgeStatus } from './codex-app-server.js';
import { createGitService } from './git-service.js';
import { abortCodexTurn, getActiveRuns, runCodexTurn, steerCodexTurn } from './codex-runner.js';
import {
  interruptDesktopFollowerTurn,
  startDesktopFollowerTurn,
  submitDesktopFollowerUserInput,
  steerDesktopFollowerTurn
} from './desktop-ipc-client.js';
import { GENERATED_ROOT, isImageRequest, runImageTurn } from './image-generator.js';
import { useLegacyImageGenerator } from './codex-native-images.js';
import { getLarkDocsStatus, logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { publicVoiceTranscriptionStatus, transcribeAudio } from './voice-transcriber.js';
import { publicVoiceSpeechStatus, synthesizeSpeech } from './voice-speaker.js';
import { publicVoiceRealtimeStatus, startVoiceRealtimeProxy } from './realtime-voice.js';
import { maybeAutoNameSession } from './session-title-generator.js';
import { createChatService } from './chat-service.js';
import { normalizeDesktopUserInputSubmission } from './user-input-requests.js';
import { searchProjectFiles } from './file-search.js';
import { htmlEscape, readBody, sendHtml, sendJson } from './http-utils.js';
import { createPushService } from './push-service.js';
import { createStaticService } from './static-service.js';
import { readVoiceUpload, saveUpload } from './upload-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
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
const FEISHU_AUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const SYNC_RESPONSE_TIMEOUT_MS = Math.max(1000, Number(process.env.CODEXMOBILE_SYNC_RESPONSE_TIMEOUT_MS) || 12_000);
let syncRefreshPromise = null;

const sockets = new Set();
const staticService = createStaticService({
  clientDist: CLIENT_DIST,
  generatedRoot: GENERATED_ROOT,
  httpsRootCaPath: HTTPS_ROOT_CA_PATH
});
const gitService = createGitService({ getProject });
const pushService = createPushService({
  statePath: PUSH_STATE,
  subject: PUSH_SUBJECT
});
let statusConfigFallback = null;

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
let feishuAuthState = { token: null, pendingStates: {} };

function fallbackModels(config) {
  const model = config.model || 'gpt-5.5';
  return [{ value: model, label: model }];
}

async function loadFeishuAuthState() {
  try {
    const raw = await fs.readFile(FEISHU_AUTH_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    feishuAuthState = {
      token: parsed?.token && typeof parsed.token === 'object' ? parsed.token : null,
      pendingStates: parsed?.pendingStates && typeof parsed.pendingStates === 'object' ? parsed.pendingStates : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[feishu] Failed to read auth state:', error.message);
    }
    feishuAuthState = { token: null, pendingStates: {} };
  }
}

async function saveFeishuAuthState() {
  await fs.mkdir(path.dirname(FEISHU_AUTH_STATE), { recursive: true });
  await fs.writeFile(FEISHU_AUTH_STATE, JSON.stringify(feishuAuthState, null, 2), 'utf8');
}

function cleanupFeishuPendingStates() {
  const now = Date.now();
  const nextStates = {};
  for (const [state, payload] of Object.entries(feishuAuthState.pendingStates || {})) {
    const createdAt = Number(payload?.createdAt || 0);
    if (createdAt && now - createdAt <= FEISHU_AUTH_STATE_MAX_AGE_MS) {
      nextStates[state] = payload;
    }
  }
  feishuAuthState.pendingStates = nextStates;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function feishuRedirectUri(req) {
  if (FEISHU_REDIRECT_URI) {
    return FEISHU_REDIRECT_URI;
  }
  const base = PUBLIC_URL || requestOrigin(req);
  return new URL('/api/feishu/auth/callback', base.endsWith('/') ? base : `${base}/`).toString();
}

function feishuConfigured() {
  return Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);
}

function feishuTokenValid() {
  const expiresAt = Number(feishuAuthState.token?.expiresAt || 0);
  return Boolean(feishuAuthState.token?.accessToken && expiresAt && expiresAt > Date.now() + 60_000);
}

function feishuUserSummary() {
  const user = feishuAuthState.token?.user || {};
  const name = user.name || user.enName || user.email || user.enterpriseEmail || user.openId || '';
  return name ? {
    name,
    email: user.email || user.enterpriseEmail || '',
    openId: user.openId || ''
  } : null;
}

async function publicDocsStatus(authenticated) {
  try {
    return await getLarkDocsStatus({ authenticated });
  } catch (error) {
    return {
      provider: 'feishu',
      integration: 'lark-cli',
      label: '飞书文档',
      configured: feishuConfigured(),
      connected: authenticated ? feishuTokenValid() : false,
      user: authenticated ? feishuUserSummary() : null,
      homeUrl: FEISHU_DOCS_HOME_URL,
      cliInstalled: false,
      skillsInstalled: false,
      capabilities: [],
      codexEnabled: false,
      error: error.message || 'lark-cli status failed'
    };
  }
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 1000) };
  }
  if (!response.ok || Number(data.code || 0) !== 0) {
    const error = new Error(data.msg || data.message || `Feishu API request failed: ${response.status}`);
    error.statusCode = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

async function getFeishuAppAccessToken() {
  if (!feishuConfigured()) {
    const error = new Error('Feishu app credentials are not configured');
    error.statusCode = 400;
    throw error;
  }
  const data = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    })
  });
  return data.app_access_token;
}

async function exchangeFeishuCode(code) {
  const appAccessToken = await getFeishuAppAccessToken();
  const data = await feishuJson('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Bearer ${appAccessToken}` },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code
    })
  });
  const token = data.data || data;
  const now = Date.now();
  feishuAuthState.token = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    expiresAt: now + Math.max(0, Number(token.expires_in || 0)) * 1000,
    refreshExpiresAt: token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : 0,
    user: {
      name: token.name || '',
      enName: token.en_name || '',
      email: token.email || '',
      enterpriseEmail: token.enterprise_email || '',
      openId: token.open_id || '',
      unionId: token.union_id || '',
      userId: token.user_id || '',
      tenantKey: token.tenant_key || ''
    },
    updatedAt: new Date().toISOString()
  };
  await saveFeishuAuthState();
  return feishuAuthState.token;
}

async function handleFeishuCallback(req, res, url) {
  const code = String(url.searchParams.get('code') || '').trim();
  const state = String(url.searchParams.get('state') || '').trim();
  const error = String(url.searchParams.get('error') || '').trim();
  cleanupFeishuPendingStates();
  const pending = state ? feishuAuthState.pendingStates[state] : null;
  if (!pending) {
    sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权已过期，请回到 CodexMobile 重新连接。</p>');
    return;
  }
  delete feishuAuthState.pendingStates[state];
  await saveFeishuAuthState();
  if (error) {
    sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(error)}</p>`);
    return;
  }
  if (!code) {
    sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权失败：没有收到授权码。</p>');
    return;
  }
  try {
    await exchangeFeishuCode(code);
    const backUrl = new URL('/', pending.redirectUri).toString();
    res.writeHead(302, { location: `${backUrl}?feishu=connected` });
    res.end();
  } catch (callbackError) {
    console.warn(`[feishu] OAuth callback failed remote=${remoteAddress(req)} message=${callbackError.message}`);
    sendHtml(res, 502, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(callbackError.message)}</p>`);
  }
}

function remoteAddress(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

async function isAuthenticated(req) {
  return verifyToken(extractBearerToken(req), { remoteAddress: remoteAddress(req) });
}

async function requireAuth(req, res, pathname = '') {
  if (await isAuthenticated(req)) {
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

function sendGitError(res, error, fallback = 'Git operation failed') {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, { error: error.message || fallback });
}

const chatService = createChatService({
  imagePromptState: IMAGE_PROMPT_STATE,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  getProject,
  getSession,
  getCacheSnapshot,
  getDesktopBridgeStatus,
  listProjectSessions,
  refreshCodexCache,
  renameSession,
  broadcast,
  runCodexTurn,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  abortCodexTurn,
  getActiveRuns,
  steerCodexTurn,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession
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

async function publicStatus(authenticated) {
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
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    voiceTranscription: publicVoiceTranscriptionStatus(config),
    voiceSpeech: publicVoiceSpeechStatus(config),
    voiceRealtime: publicVoiceRealtimeStatus(config),
    docs: await publicDocsStatus(authenticated),
    syncedAt: snapshot.syncedAt,
    activeRuns: [...getActiveRuns(), ...chatService.getActiveImageRuns()],
    auth: {
      required: true,
      authenticated,
      trustedDevices: getTrustedDeviceCount()
    }
  };
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, await publicStatus(await isAuthenticated(req)));
    return;
  }

  if (method === 'POST' && pathname === '/api/pair') {
    const body = await readBody(req);
    const paired = await pairDevice({
      code: body.code,
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'],
      remoteAddress: remoteAddress(req)
    });
    if (!paired) {
      sendJson(res, 403, { error: 'Invalid pairing code' });
      return;
    }
    sendJson(res, 200, paired);
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/auth/callback') {
    await handleFeishuCallback(req, res, url);
    return;
  }

  if (!(await requireAuth(req, res, pathname))) {
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

  if (method === 'GET' && pathname === '/api/notifications/public-key') {
    sendJson(res, 200, await pushService.publicStatus());
    return;
  }

  if (method === 'POST' && pathname === '/api/notifications/subscribe') {
    try {
      const body = await readBody(req);
      const result = await pushService.subscribe(body.subscription || body);
      await pushService.sendNotification({
        level: 'success',
        title: '完成通知已开启',
        body: 'CodexMobile 后台通知已经接通。',
        tag: 'codexmobile-notifications-enabled'
      });
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.warn(`[push] subscribe failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || 'Failed to subscribe push notification' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/notifications/unsubscribe') {
    try {
      const body = await readBody(req);
      const endpoint = body.endpoint || body.subscription?.endpoint;
      sendJson(res, 200, { success: true, ...(await pushService.unsubscribe(endpoint)) });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, { error: error.message || 'Failed to unsubscribe push notification' });
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: listProjects() });
    return;
  }

  if (method === 'GET' && pathname === '/api/git/status') {
    const projectId = url.searchParams.get('projectId');
    try {
      sendJson(res, 200, { success: true, status: await gitService.status(projectId) });
    } catch (error) {
      console.warn(`[git] status failed project=${projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to read Git status');
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/git/diff') {
    const projectId = url.searchParams.get('projectId');
    try {
      sendJson(res, 200, { success: true, diff: await gitService.diff(projectId) });
    } catch (error) {
      console.warn(`[git] diff failed project=${projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to read Git diff');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/git/branch') {
    const body = await readBody(req);
    try {
      const result = await gitService.createBranch(body.projectId, body.branchName);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      console.warn(`[git] branch failed project=${body.projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to create Git branch');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/git/commit') {
    const body = await readBody(req);
    try {
      const result = await gitService.commit(body.projectId, body.message);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      console.warn(`[git] commit failed project=${body.projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to commit Git changes');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/git/push') {
    const body = await readBody(req);
    try {
      const result = await gitService.push(body.projectId, {
        remote: body.remote,
        branch: body.branch
      });
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      console.warn(`[git] push failed project=${body.projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to push Git branch');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/git/pull') {
    const body = await readBody(req);
    try {
      const result = await gitService.pull(body.projectId, {
        remote: body.remote,
        branch: body.branch
      });
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      console.warn(`[git] pull failed project=${body.projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to pull Git branch');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/git/sync') {
    const body = await readBody(req);
    try {
      const result = await gitService.sync(body.projectId);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      console.warn(`[git] sync failed project=${body.projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to sync Git branch');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/git/commit-push') {
    const body = await readBody(req);
    try {
      const result = await gitService.commitPush(body.projectId, body.message);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      console.warn(`[git] commit-push failed project=${body.projectId || ''}: ${error.message}`);
      sendGitError(res, error, 'Failed to commit and push Git changes');
    }
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

  if (method === 'GET' && pathname === '/api/local-image') {
    await staticService.sendLocalImage(req, res, url);
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/status') {
    sendJson(res, 200, await publicDocsStatus(true));
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/cli/auth/start') {
    try {
      const auth = await startLarkCliAuth();
      sendJson(res, 200, {
        success: true,
        ...auth,
        docs: await publicDocsStatus(true)
      });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.warn(`[lark-cli] auth start failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '飞书 CLI 授权失败' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/cli/auth/logout') {
    try {
      await logoutLarkCli();
      sendJson(res, 200, {
        success: true,
        docs: await publicDocsStatus(true)
      });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.warn(`[lark-cli] auth logout failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '断开飞书 CLI 授权失败' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/auth/start') {
    if (!feishuConfigured()) {
      sendJson(res, 400, { error: 'Feishu app credentials are not configured' });
      return;
    }
    cleanupFeishuPendingStates();
    const state = crypto.randomBytes(24).toString('base64url');
    const redirectUri = feishuRedirectUri(req);
    feishuAuthState.pendingStates[state] = {
      createdAt: Date.now(),
      redirectUri
    };
    await saveFeishuAuthState();
    const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/index');
    authUrl.searchParams.set('app_id', FEISHU_APP_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    sendJson(res, 200, {
      url: authUrl.toString(),
      redirectUri
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/auth/logout') {
    feishuAuthState.token = null;
    await saveFeishuAuthState();
    sendJson(res, 200, { success: true, ...(await publicDocsStatus(true)) });
    return;
  }

  const parts = pathname.split('/').filter(Boolean);

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    sendJson(res, 200, { sessions: listProjectSessions(projectId) });
    return;
  }

  if (method === 'PATCH' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    const sessionId = decodeURIComponent(parts[4]);
    const project = getProject(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const session = getSession(sessionId);
    if (!session || session.projectId !== project.id) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 52);
    if (!title) {
      sendJson(res, 400, { error: 'Title is required' });
      return;
    }

    try {
      const renamed = await renameSession(session.id, project.id, title, { auto: Boolean(body.auto) });
      broadcast({
        type: 'session-renamed',
        projectId: project.id,
        sessionId: renamed.id,
        title: renamed.title,
        titleLocked: renamed.titleLocked,
        updatedAt: renamed.updatedAt,
        session: renamed
      });
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, session: renamed });
    } catch (error) {
      console.warn(`[sessions] rename failed session=${sessionId} project=${projectId}: ${error.message}`);
      sendJson(res, 500, { error: 'Failed to rename session' });
    }
    return;
  }

  if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    const sessionId = decodeURIComponent(parts[4]);
    const project = getProject(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const session = getSession(sessionId);
    if (!session || session.projectId !== project.id) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    if (chatService.sessionHasActiveWork(sessionId)) {
      sendJson(res, 409, { error: 'Session is running' });
      return;
    }
    try {
      const deleted = await deleteSession(sessionId, project.id);
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...deleted });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.warn(`[sessions] archive failed session=${sessionId} project=${projectId}: ${error.message}`);
      sendJson(res, statusCode, { error: statusCode === 409 ? error.message : 'Failed to archive session' });
    }
    return;
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'chat' && parts[2] === 'turns') {
    const turnId = decodeURIComponent(parts[3]);
    sendJson(res, 200, { turn: chatService.getTurn(turnId) });
    return;
  }

  if (method === 'GET' && pathname === '/api/chat/queue') {
    sendJson(res, 200, chatService.listQueue({
      sessionId: url.searchParams.get('sessionId') || '',
      draftSessionId: url.searchParams.get('draftSessionId') || ''
    }));
    return;
  }

  if (method === 'DELETE' && pathname === '/api/chat/queue') {
    const body = await readBody(req);
    const draft = chatService.removeQueuedDraft(body);
    sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/queue/restore') {
    const body = await readBody(req);
    const draft = chatService.restoreQueuedDraft(body);
    sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/queue/steer') {
    const body = await readBody(req);
    try {
      const result = await chatService.steerQueuedDraft(body);
      sendJson(res, result ? 202 : 404, result || { error: 'Queued draft not found' });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to steer queued draft' });
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/files/search') {
    const project = getProject(url.searchParams.get('projectId') || '');
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    try {
      const files = await searchProjectFiles(project, url.searchParams.get('q') || '');
      sendJson(res, 200, { files });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to search files' });
    }
    return;
  }

  if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
    const sessionId = decodeURIComponent(parts[2]);
    const messageId = decodeURIComponent(parts[4]);
    try {
      const deleted = await hideSessionMessage(sessionId, messageId);
      broadcast({ type: 'message-deleted', ...deleted });
      sendJson(res, 200, { success: true, ...deleted });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.warn(`[sessions] message delete failed session=${sessionId} message=${messageId}: ${error.message}`);
      sendJson(res, statusCode, { error: statusCode === 400 ? error.message : 'Failed to delete message' });
    }
    return;
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
    const sessionId = decodeURIComponent(parts[2]);
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
    const result = await readSessionMessages(sessionId, {
      limit: limit ? Number(limit) : 120,
      offset: offset !== null ? Number(offset) : null,
      latest: offset === null || url.searchParams.get('latest') === '1',
      includeActivity: url.searchParams.get('activity') === '1'
    });
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/uploads') {
    const upload = await saveUpload(req, { uploadRoot: UPLOAD_ROOT, maxUploadBytes: MAX_UPLOAD_BYTES });
    console.log(`[upload] saved name=${upload.name} size=${upload.size} kind=${upload.kind} remote=${remoteAddress(req)}`);
    sendJson(res, 200, { upload });
    return;
  }

  if (method === 'POST' && pathname === '/api/voice/transcribe') {
    const startedAt = Date.now();
    try {
      const audio = await readVoiceUpload(req, { maxVoiceBytes: MAX_VOICE_BYTES });
      const config = getCacheSnapshot().config || {};
      const result = await transcribeAudio(audio, config);
      console.log(`[voice] transcribed size=${audio.data.length} mime=${audio.mimeType} provider=${result.provider} model=${result.model} remote=${remoteAddress(req)}`);
      sendJson(res, 200, { text: result.text || '', durationMs: Date.now() - startedAt });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const providerInfo = error.providerHost ? ` provider=${error.providerHost}` : '';
      const safeMessage = String(error.message || '语音转写失败')
        .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
        .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
      console.warn(`[voice] transcribe failed status=${statusCode}${providerInfo} remote=${remoteAddress(req)} message=${safeMessage}`);
      sendJson(res, statusCode, {
        error: safeMessage || '语音转写失败'
      });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/voice/speech') {
    const startedAt = Date.now();
    try {
      const body = await readBody(req);
      const config = getCacheSnapshot().config || {};
      const result = await synthesizeSpeech(body.text, config);
      console.log(`[voice] synthesized bytes=${result.data.length} provider=${result.provider} model=${result.model} voice=${result.voice} remote=${remoteAddress(req)}`);
      res.writeHead(200, {
        'content-type': result.mimeType,
        'content-length': result.data.length,
        'cache-control': 'no-store',
        'x-codexmobile-duration-ms': String(Date.now() - startedAt)
      });
      res.end(result.data);
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const safeMessage = String(error.message || '语音合成失败')
        .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
        .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
      console.warn(`[voice] speech failed status=${statusCode} remote=${remoteAddress(req)} message=${safeMessage}`);
      sendJson(res, statusCode, {
        error: safeMessage || '语音合成失败'
      });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/send') {
    const body = await readBody(req);
    try {
      const result = await chatService.sendChat(body, { remoteAddress: remoteAddress(req) });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to send chat' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/user-input/respond') {
    const body = await readBody(req);
    try {
      const result = chatService.respondToUserInput(body);
      if (result.ok) {
        sendJson(res, 200, { accepted: true });
        return;
      }
      const desktopSubmission = normalizeDesktopUserInputSubmission(body);
      if (desktopSubmission) {
        const { conversationId, ...request } = desktopSubmission;
        await submitDesktopFollowerUserInput(conversationId, request);
        sendJson(res, 200, { accepted: true, delivery: 'desktop-ipc' });
        return;
      }
      sendJson(res, 404, { error: 'User input request not found' });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to submit user input' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/abort') {
    const body = await readBody(req);
    const aborted = chatService.abortChat(body, { remoteAddress: remoteAddress(req) });
    sendJson(res, aborted ? 200 : 404, { aborted });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
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
  await loadFeishuAuthState();
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

    const token = url.searchParams.get('token') || '';
    const ok = await verifyToken(token, { remoteAddress: remoteAddress(req) });
    if (!ok) {
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
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true) }));
    });
  };

  server.on('upgrade', handleUpgrade);

  server.listen(PORT, HOST, () => {
    console.log(`CodexMobile listening on http://${HOST}:${PORT}`);
    console.log(`Pairing code: ${getPairingCode()} (${auth.trustedDevices} trusted device(s)${auth.fixedPairingCode ? ', fixed' : ''})`);
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
