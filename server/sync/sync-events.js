/**
 * 统一同步事件模型：创建 SyncEvent 并提供运行态 key 与生命周期判定。
 *
 * Keywords: sync-event, websocket, runtime, lifecycle, event-builder
 *
 * Exports:
 * - createSyncEvent / createSyncEventPayload — 构造统一同步事件与 WS payload。
 * - runKeysForSyncEvent — 计算事件可命中的 runtime/session key。
 * - isTerminalSyncEvent / isRuntimeSyncEvent — 判定事件生命周期。
 *
 * Inward（本模块依赖/组装的关键符号）: 仅使用标准运行时工具函数。
 *
 * Outward（谁在用/调用场景）: sync-bridge、sync-store、服务端广播源、后端同步测试。
 *
 * 不负责: WebSocket 发送、Codex 原始 app-server 事件解析。
 */

const RUNTIME_EVENT_TYPES = new Set([
  'turn.submitted',
  'turn.accepted',
  'turn.running',
  'turn.queued',
  'turn.completed',
  'turn.failed',
  'turn.aborted'
]);

const TERMINAL_EVENT_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.aborted']);

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  const text = String(value || '').trim();
  return text || null;
}

function eventId(prefix = 'sync') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createSyncEvent(eventType, payload = {}, extra = {}) {
  const timestamp = clean(payload.timestamp) || clean(payload.completedAt) || clean(payload.startedAt) || nowIso();
  return {
    id: clean(payload.id) || eventId(eventType.replaceAll('.', '-')),
    eventType,
    protocol: clean(payload.protocol) || 'codexmobile-sync',
    appMethod: clean(payload.appMethod),
    source: clean(payload.source) || 'server',
    projectId: clean(payload.projectId),
    sessionId: clean(payload.sessionId),
    previousSessionId: clean(payload.previousSessionId),
    draftSessionId: clean(payload.draftSessionId),
    turnId: clean(payload.turnId),
    clientTurnId: clean(payload.clientTurnId),
    appTurnId: clean(payload.appTurnId),
    itemId: clean(payload.itemId) || clean(payload.messageId),
    itemType: clean(payload.itemType),
    status: clean(payload.status),
    label: clean(payload.label),
    detail: clean(payload.detail),
    startedAt: clean(payload.startedAt),
    completedAt: clean(payload.completedAt),
    durationMs: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
    timestamp,
    ...extra
  };
}

export function createSyncEventPayload(eventType, payload = {}, extra = {}) {
  return {
    type: 'sync-event',
    event: createSyncEvent(eventType, payload, extra)
  };
}

export function runKeysForSyncEvent(event = {}) {
  return [
    event.turnId,
    event.clientTurnId,
    event.appTurnId,
    event.sessionId,
    event.previousSessionId,
    event.draftSessionId
  ].filter(Boolean).map(String);
}

export function isRuntimeSyncEvent(event = {}) {
  return RUNTIME_EVENT_TYPES.has(String(event.eventType || ''));
}

export function isTerminalSyncEvent(event = {}) {
  return TERMINAL_EVENT_TYPES.has(String(event.eventType || ''));
}
