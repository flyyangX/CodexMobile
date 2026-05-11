import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  broadcastDesktopThreadArchived,
  broadcastDesktopThreadTitleUpdated,
  probeDesktopIpc
} from './desktop-ipc-client.js';

const DEFAULT_CODEX_APP_BINARY = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONTROL_SOCKET = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
const BRIDGE_STATUS_CACHE_MS = 2500;

let bridgeStatusCache = null;

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = String(value || '').trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function pathApiForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function windowsCodexCandidates(env, pathApi) {
  const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? pathApi.join(env.USERPROFILE, 'AppData', 'Local') : '');
  const appData = env.APPDATA || (env.USERPROFILE ? pathApi.join(env.USERPROFILE, 'AppData', 'Roaming') : '');
  return [
    localAppData ? pathApi.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    appData ? pathApi.join(appData, 'npm', 'codex.exe') : '',
    appData ? pathApi.join(appData, 'npm', 'codex.cmd') : ''
  ];
}

function pathEnvironmentCandidates(command, env, platform, pathApi) {
  const pathValue = env.Path || env.PATH || env.path || '';
  const pathDirs = String(pathValue).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (!pathDirs.length) {
    return [];
  }
  const extensions = platform === 'win32'
    ? uniqueValues(['.exe', '.cmd', '.bat', ...(env.PATHEXT || '').split(';'), ''])
    : [''];
  return pathDirs.flatMap((dir) => extensions.map((ext) => pathApi.join(dir, `${command}${ext}`)));
}

export function resolveCodexBinary({
  env = process.env,
  platform = process.platform,
  existsSync = fsSync.existsSync
} = {}) {
  const pathApi = pathApiForPlatform(platform);
  const explicit = [
    env.CODEXMOBILE_CODEX_BINARY,
    env.CODEX_BINARY
  ];
  const platformCandidates = platform === 'win32'
    ? windowsCodexCandidates(env, pathApi)
    : [DEFAULT_CODEX_APP_BINARY];
  const candidates = [
    ...explicit,
    ...platformCandidates,
    ...pathEnvironmentCandidates('codex', env, platform, pathApi),
    'codex'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }
  return 'codex';
}

function responseError(message, method = '') {
  const error = new Error(message || `Codex app-server request failed${method ? `: ${method}` : ''}`);
  error.method = method;
  return error;
}

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function socketStatus(sockPath) {
  if (!sockPath) {
    return { ok: false, reason: '未找到桌面端 Codex app-server control socket' };
  }
  try {
    const stat = fsSync.statSync(sockPath);
    if (!stat.isSocket()) {
      return { ok: false, reason: `桌面端 control socket 路径不是 socket: ${sockPath}` };
    }
    return { ok: true, sockPath };
  } catch (error) {
    return {
      ok: false,
      reason: error.code === 'ENOENT'
        ? `桌面端 control socket 不存在: ${sockPath}`
        : `无法访问桌面端 control socket: ${error.message}`
    };
  }
}

export function resolveAppServerTransport(env = process.env, { allowHeadlessLocal = false } = {}) {
  const allowIsolated = isEnabled(env.CODEXMOBILE_ALLOW_ISOLATED_CODEX);
  const disableHeadless = isEnabled(env.CODEXMOBILE_DISABLE_HEADLESS_CODEX);
  const explicitSocket = String(env.CODEXMOBILE_CODEX_APP_SERVER_SOCK || '').trim();
  const candidateSocket = explicitSocket || DEFAULT_CONTROL_SOCKET;
  const candidate = socketStatus(candidateSocket);
  if (candidate.ok) {
    return {
      mode: 'desktop-proxy',
      strict: true,
      sockPath: candidate.sockPath,
      connected: true,
      reason: null
    };
  }
  if (allowIsolated) {
    return {
      mode: 'isolated-dev',
      strict: false,
      sockPath: null,
      connected: true,
      reason: 'CODEXMOBILE_ALLOW_ISOLATED_CODEX=1，正在使用独立开发 app-server'
    };
  }
  if (allowHeadlessLocal && !disableHeadless) {
    return {
      mode: 'headless-local',
      strict: false,
      sockPath: null,
      connected: true,
      reason: '桌面端 Codex 未连接，正在使用后台 Codex 执行'
    };
  }
  return {
    mode: 'unavailable',
    strict: true,
    sockPath: candidateSocket,
    connected: false,
    reason: candidate.reason
  };
}

function unavailableBridgeError(transport) {
  const error = responseError(
    `桌面端 Codex 未连接：${transport?.reason || '未找到可用 app-server control socket'}`,
    'desktop-bridge'
  );
  error.statusCode = 503;
  error.code = 'CODEXMOBILE_DESKTOP_BRIDGE_UNAVAILABLE';
  error.transport = transport;
  return error;
}

export function defaultServerRequestResult(message) {
  switch (message?.method) {
    case 'item/commandExecution/requestApproval':
      return { decision: 'decline' };
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'denied' };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'item/plan/requestImplementation':
      return {};
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'item/tool/call':
      return { contentItems: [], success: false };
    default:
      return null;
  }
}

export class CodexAppServerClient {
  constructor({
    env = process.env,
    cwd = process.cwd(),
    clientInfo = {},
    onNotification = null,
    onServerRequest = null,
    allowReadOnlyIsolated = false,
    allowHeadlessLocal = false,
    transport = null
  } = {}) {
    this.env = env;
    this.cwd = cwd;
    this.clientInfo = {
      name: clientInfo.name || 'CodexMobile',
      title: clientInfo.title || null,
      version: clientInfo.version || '0.1.0'
    };
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.transport = transport || resolveAppServerTransport({
      ...env,
      CODEXMOBILE_ALLOW_ISOLATED_CODEX: allowReadOnlyIsolated ? '1' : env.CODEXMOBILE_ALLOW_ISOLATED_CODEX
    }, { allowHeadlessLocal });
    this.child = null;
    this.readline = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  start() {
    if (this.child) {
      return;
    }
    if (this.transport.mode === 'unavailable') {
      throw unavailableBridgeError(this.transport);
    }
    const args = this.transport.mode === 'desktop-proxy'
      ? ['app-server', 'proxy', '--sock', this.transport.sockPath]
      : ['app-server', '--listen', 'stdio://'];
    this.child = spawn(resolveCodexBinary(), args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.readline = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity
    });
    this.readline.on('line', (line) => this.handleLine(line));

    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 24_000) {
        this.stderr = this.stderr.slice(-12_000);
      }
    });

    this.child.on('error', (error) => {
      this.rejectAll(error);
      this.resolveClosed?.({ code: null, signal: null, error });
    });
    this.child.on('close', (code, signal) => {
      const error = responseError(
        this.stderr.trim() || `Codex app-server exited with ${code ?? signal ?? 'unknown status'}`
      );
      this.rejectAll(error);
      this.resolveClosed?.({ code, signal, error: code === 0 ? null : error });
    });
  }

  async initialize() {
    this.start();
    await this.request('initialize', {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized');
    return this;
  }

  request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.start();
    const id = this.nextId;
    this.nextId += 1;
    const payload = params === undefined ? { id, method } : { id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(responseError(`Codex app-server request timed out: ${method}`, method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
    });
    this.write(payload);
    return promise;
  }

  notify(method, params) {
    const payload = params === undefined ? { method } : { method, params };
    this.write(payload);
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, message, code = -32603) {
    this.write({ id, error: { code, message } });
  }

  write(payload) {
    if (!this.child?.stdin?.writable) {
      throw responseError('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(responseError(message.error.message, pending.method));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && this.onNotification) {
      this.onNotification(message);
    }
  }

  async handleServerRequest(message) {
    try {
      const result = this.onServerRequest
        ? await this.onServerRequest(message)
        : defaultServerRequestResult(message);
      if (result === null || result === undefined) {
        this.respondError(message.id, `Unsupported Codex app-server request: ${message.method}`, -32601);
        return;
      }
      this.respond(message.id, result);
    } catch (error) {
      this.respondError(message.id, error.message || `Failed to handle ${message.method}`);
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}

function isArchivedOrDeletedDesktopThread(thread = null) {
  if (!thread || typeof thread !== 'object') {
    return true;
  }
  const status = String(thread.status || '').toLowerCase();
  const archivedAt = String(thread.archivedAt || thread.deletedAt || thread.archived_at || thread.deleted_at || '').trim();
  const deletedFlag = Boolean(thread.deleted) || Boolean(thread.isDeleted) || status === 'deleted' || status === 'archived';
  const archivedFlag = Boolean(thread.archived) || Boolean(thread.isArchived) || status === 'archived';
  return deletedFlag || archivedFlag || Boolean(archivedAt);
}

export async function createCodexAppServerClient(options = {}) {
  const client = new CodexAppServerClient(options);
  await client.initialize();
  return client;
}

export async function getDesktopBridgeStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && bridgeStatusCache && now - bridgeStatusCache.checkedAt < BRIDGE_STATUS_CACHE_MS) {
    return bridgeStatusCache.status;
  }
  const transport = resolveAppServerTransport(process.env, { allowHeadlessLocal: true });
  const ipc = await probeDesktopIpc({ timeoutMs: 1200 }).catch((error) => ({
    connected: false,
    mode: 'desktop-ipc',
    socketPath: null,
    reason: error.message
  }));
  if (ipc.connected) {
    const status = {
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      socketPath: ipc.socketPath || null,
      checkedAt: new Date(now).toISOString(),
      capabilities: {
        read: true,
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadReason: '当前 Codex Desktop IPC 只暴露已有线程接管入口，还没有开放外部新建桌面线程入口。',
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    };
    bridgeStatusCache = { checkedAt: now, status };
    return status;
  }
  const base = {
    strict: transport.strict,
    connected: false,
    mode: transport.mode,
    reason: transport.reason || ipc.reason,
    socketPath: transport.sockPath || null,
    checkedAt: new Date(now).toISOString(),
    capabilities: {
      read: false,
      sendToOpenDesktopThread: false,
      createThread: false
    }
  };
  if (transport.mode === 'unavailable') {
    bridgeStatusCache = { checkedAt: now, status: base };
    return base;
  }

  const client = new CodexAppServerClient({
    clientInfo: { name: 'CodexMobileBridgeProbe', title: null, version: '0.1.0' },
    transport
  });
  try {
    await client.initialize();
    await client.request('thread/loaded/list', { limit: 1 }, { timeoutMs: 1500 }).catch(() => null);
    const status = {
      ...base,
      connected: true,
      reason: transport.mode === 'isolated-dev' || transport.mode === 'headless-local' ? transport.reason : null,
      capabilities: {
        read: true,
        sendToOpenDesktopThread: transport.mode === 'desktop-proxy',
        createThread: transport.mode !== 'isolated-dev',
        headless: transport.mode === 'headless-local',
        backgroundCodex: transport.mode === 'headless-local'
      }
    };
    bridgeStatusCache = { checkedAt: now, status };
    return status;
  } catch (error) {
    const status = {
      ...base,
      connected: false,
      reason: error.message || transport.reason || '桌面端 Codex app-server 连接失败'
    };
    bridgeStatusCache = { checkedAt: now, status };
    return status;
  } finally {
    client.close();
  }
}

export async function listDesktopThreads({ limit = 1000, pageSize = 100 } = {}) {
  const client = await createCodexAppServerClient({
    clientInfo: { name: 'CodexMobileList', title: null, version: '0.1.0' },
    allowReadOnlyIsolated: true
  });
  try {
    const threads = [];
    let cursor = null;
    while (threads.length < limit) {
      const response = await client.request('thread/list', {
        cursor,
        limit: Math.min(pageSize, limit - threads.length),
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false
      }, { timeoutMs: 20_000 });
      const rawData = Array.isArray(response?.data) ? response.data : [];
      const data = rawData.filter((thread) => !isArchivedOrDeletedDesktopThread(thread));
      threads.push(...data);
      cursor = response?.nextCursor || null;
      if (!cursor || !rawData.length) {
        break;
      }
    }
    return threads;
  } finally {
    client.close();
  }
}

export async function readDesktopThread(threadId, { includeTurns = true } = {}) {
  const client = await createCodexAppServerClient({
    clientInfo: { name: 'CodexMobileRead', title: null, version: '0.1.0' },
    allowReadOnlyIsolated: true
  });
  try {
    return await client.request('thread/read', {
      threadId,
      includeTurns
    }, { timeoutMs: 20_000 });
  } finally {
    client.close();
  }
}

export async function setDesktopThreadName(threadId, name) {
  const client = await createCodexAppServerClient({
    clientInfo: { name: 'CodexMobileRename', title: null, version: '0.1.0' },
    allowHeadlessLocal: true
  });
  try {
    const result = await client.request('thread/name/set', {
      threadId,
      name
    }, { timeoutMs: 20_000 });
    const broadcast = await broadcastDesktopThreadTitleUpdated(threadId, name);
    if (!broadcast.sent) {
      console.warn(`[desktop-ipc] title broadcast skipped thread=${threadId}: ${broadcast.reason}`);
    }
    return result;
  } finally {
    client.close();
  }
}

export async function archiveDesktopThread(threadId) {
  const client = await createCodexAppServerClient({
    clientInfo: { name: 'CodexMobileArchive', title: null, version: '0.1.0' },
    allowHeadlessLocal: true
  });
  try {
    const result = await client.request('thread/archive', {
      threadId
    }, { timeoutMs: 20_000 });
    const broadcast = await broadcastDesktopThreadArchived(threadId);
    if (!broadcast.sent) {
      console.warn(`[desktop-ipc] archive broadcast skipped thread=${threadId}: ${broadcast.reason}`);
    }
    return result;
  } finally {
    client.close();
  }
}
