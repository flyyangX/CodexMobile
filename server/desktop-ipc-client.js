import crypto from 'node:crypto';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DESKTOP_IPC_METHOD_VERSIONS = new Map([
  ['thread-archived', 2],
  ['thread-unarchived', 1],
  ['thread-follower-start-turn', 1],
  ['thread-follower-compact-thread', 1],
  ['thread-follower-steer-turn', 1],
  ['thread-follower-interrupt-turn', 1],
  ['thread-follower-set-model-and-reasoning', 1],
  ['thread-follower-set-collaboration-mode', 1],
  ['thread-follower-edit-last-user-turn', 1],
  ['thread-follower-command-approval-decision', 1],
  ['thread-follower-file-approval-decision', 1],
  ['thread-follower-permissions-request-approval-response', 1],
  ['thread-follower-submit-user-input', 1],
  ['thread-follower-submit-mcp-server-elicitation-response', 1],
  ['thread-follower-set-queued-follow-ups-state', 1]
]);

export function desktopIpcMethodVersion(method) {
  return DESKTOP_IPC_METHOD_VERSIONS.get(method) || 0;
}

export function desktopIpcSocketPath() {
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\codex-ipc`;
  }
  const uid = process.getuid?.();
  return path.join(os.tmpdir(), 'codex-ipc', uid ? `ipc-${uid}.sock` : 'ipc.sock');
}

function frameFor(payload) {
  const json = JSON.stringify(payload);
  const size = Buffer.byteLength(json, 'utf8');
  const frame = Buffer.alloc(4 + size);
  frame.writeUInt32LE(size, 0);
  frame.write(json, 4, 'utf8');
  return frame;
}

function ipcError(message, code = 'CODEXMOBILE_DESKTOP_IPC_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function getDesktopIpcSocketStatus(sockPath = desktopIpcSocketPath()) {
  if (process.platform === 'win32') {
    return { ok: true, socketPath: sockPath, reason: null };
  }
  try {
    const stat = fsSync.statSync(sockPath);
    if (!stat.isSocket()) {
      return { ok: false, socketPath: sockPath, reason: `桌面端 IPC 路径不是 socket: ${sockPath}` };
    }
    return { ok: true, socketPath: sockPath, reason: null };
  } catch (error) {
    return {
      ok: false,
      socketPath: sockPath,
      reason: error.code === 'ENOENT'
        ? `桌面端 IPC socket 不存在: ${sockPath}`
        : `无法访问桌面端 IPC socket: ${error.message}`
    };
  }
}

export class DesktopIpcClient {
  constructor({ clientType = 'codexmobile', socketPath = desktopIpcSocketPath() } = {}) {
    this.clientType = clientType;
    this.socketPath = socketPath;
    this.clientId = 'initializing-client';
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextFrameSize = null;
    this.pending = new Map();
  }

  async connect({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.socket?.writable) {
      return this;
    }
    const status = getDesktopIpcSocketStatus(this.socketPath);
    if (!status.ok) {
      throw ipcError(status.reason || '桌面端 Codex IPC 未连接', 'CODEXMOBILE_DESKTOP_IPC_UNAVAILABLE');
    }
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(ipcError('连接桌面端 Codex IPC 超时', 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('close', () => this.rejectAll(ipcError('桌面端 Codex IPC 已断开', 'CODEXMOBILE_DESKTOP_IPC_CLOSED')));
        socket.on('error', (error) => this.rejectAll(error));
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const initialized = await this.request('initialize', { clientType: this.clientType }, { timeoutMs });
    if (initialized?.resultType !== 'success' || initialized?.method !== 'initialize') {
      throw ipcError(initialized?.error || '桌面端 Codex IPC 初始化失败');
    }
    this.clientId = initialized.result?.clientId || this.clientId;
    return this;
  }

  async request(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, targetClientId = null, version } = {}) {
    if (!this.socket?.writable) {
      throw ipcError('桌面端 Codex IPC 未连接', 'CODEXMOBILE_DESKTOP_IPC_UNAVAILABLE');
    }
    const requestId = crypto.randomUUID();
    const payload = {
      type: 'request',
      requestId,
      sourceClientId: this.clientId,
      version: version ?? desktopIpcMethodVersion(method),
      method,
      params
    };
    if (targetClientId) {
      payload.targetClientId = targetClientId;
    }
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(ipcError(`桌面端 Codex IPC 请求超时: ${method}`, 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
    });
    this.socket.write(frameFor(payload));
    return promise;
  }

  sendBroadcast(method, params = {}, { version } = {}) {
    if (!this.socket?.writable) {
      throw ipcError('桌面端 Codex IPC 未连接', 'CODEXMOBILE_DESKTOP_IPC_UNAVAILABLE');
    }
    this.socket.write(frameFor({
      type: 'broadcast',
      method,
      sourceClientId: this.clientId,
      version: version ?? desktopIpcMethodVersion(method),
      params
    }));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.nextFrameSize == null) {
        if (this.buffer.length < 4) {
          return;
        }
        this.nextFrameSize = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);
        if (this.nextFrameSize > MAX_FRAME_BYTES) {
          this.close();
          this.rejectAll(ipcError('桌面端 Codex IPC frame 过大'));
          return;
        }
      }
      if (this.buffer.length < this.nextFrameSize) {
        return;
      }
      const raw = this.buffer.subarray(0, this.nextFrameSize);
      this.buffer = this.buffer.subarray(this.nextFrameSize);
      this.nextFrameSize = null;
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.type === 'client-discovery-request') {
      this.socket?.write(frameFor({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false }
      }));
      return;
    }
    if (message.type !== 'response') {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

export async function probeDesktopIpc({ timeoutMs = 3000 } = {}) {
  const status = getDesktopIpcSocketStatus();
  if (!status.ok) {
    return { connected: false, mode: 'desktop-ipc', socketPath: status.socketPath, reason: status.reason };
  }
  const client = new DesktopIpcClient();
  try {
    await client.connect({ timeoutMs });
    return { connected: true, mode: 'desktop-ipc', socketPath: status.socketPath, reason: null };
  } catch (error) {
    return {
      connected: false,
      mode: 'desktop-ipc',
      socketPath: status.socketPath,
      reason: error.message || '桌面端 Codex IPC 连接失败'
    };
  } finally {
    client.close();
  }
}

async function requestDesktopFollower(method, params, options = {}) {
  const client = new DesktopIpcClient({ socketPath: options.socketPath });
  try {
    await client.connect({ timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
    const response = await client.request(method, params, options);
    if (response.resultType === 'error') {
      const error = ipcError(response.error || `桌面端 Codex 拒绝请求: ${method}`);
      error.statusCode = response.error === 'no-client-found' ? 409 : 502;
      throw error;
    }
    return response.result;
  } finally {
    client.close();
  }
}

export async function startDesktopFollowerTurn(conversationId, turnStartParams, options = {}) {
  return requestDesktopFollower('thread-follower-start-turn', {
    conversationId,
    turnStartParams
  }, options);
}

export async function steerDesktopFollowerTurn(conversationId, { input, attachments = [], restoreMessage = {} }, options = {}) {
  return requestDesktopFollower('thread-follower-steer-turn', {
    conversationId,
    input,
    attachments,
    restoreMessage
  }, options);
}

export async function interruptDesktopFollowerTurn(conversationId, options = {}) {
  return requestDesktopFollower('thread-follower-interrupt-turn', {
    conversationId
  }, options);
}

export async function setDesktopFollowerCollaborationMode(conversationId, collaborationMode, options = {}) {
  return requestDesktopFollower('thread-follower-set-collaboration-mode', {
    conversationId,
    collaborationMode
  }, options);
}

export async function submitDesktopFollowerUserInput(conversationId, { threadId, turnId, itemId, response }, options = {}) {
  return requestDesktopFollower('thread-follower-submit-user-input', {
    conversationId,
    threadId,
    turnId,
    itemId,
    response
  }, options);
}

export async function broadcastDesktopThreadArchived(conversationId, { hostId = 'local', cwd = null, timeoutMs = 1500 } = {}) {
  const client = new DesktopIpcClient({ clientType: 'codexmobile-archive-sync' });
  try {
    await client.connect({ timeoutMs });
    client.sendBroadcast('thread-archived', {
      hostId,
      conversationId,
      cwd
    });
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: error.message || '桌面端 Codex IPC 广播失败'
    };
  } finally {
    client.close();
  }
}
