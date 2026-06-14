/**
 * 前端同步 reducer：把服务端 sync-event/sync-state 投影为运行态、消息和会话列表补丁。
 *
 * Keywords: sync-reducer, runtime, websocket, dedupe, sessions
 *
 * Exports:
 * - applySyncRuntimeEvent — 根据 SyncEvent 更新 runtime map。
 * - mergeSyncStateRuntime — 合并服务端 sync-state runtime。
 * - syncEventRunKeys / isSyncTerminalEvent — 事件辅助函数。
 *
 * Inward（本模块依赖/组装的关键符号）: 无 React 依赖；纯函数便于测试。
 *
 * Outward（谁在用/调用场景）: useSyncSocket、sync reducer 单测。
 *
 * 不负责: 实际 setState 与消息渲染。
 */

const TERMINAL_EVENTS = new Set(['turn.completed', 'turn.failed', 'turn.aborted']);
const RUNNING_EVENTS = new Set(['turn.submitted', 'turn.accepted', 'turn.running', 'turn.queued']);

export function syncEventRunKeys(event = {}) {
  return [
    event.turnId,
    event.clientTurnId,
    event.appTurnId,
    event.sessionId,
    event.previousSessionId,
    event.draftSessionId
  ].filter(Boolean).map(String);
}

export function isSyncTerminalEvent(event = {}) {
  return TERMINAL_EVENTS.has(String(event.eventType || ''));
}

export function isSyncRunningEvent(event = {}) {
  return RUNNING_EVENTS.has(String(event.eventType || ''));
}

export function runtimeRecordForSyncEvent(event = {}) {
  return {
    status: event.status || (event.eventType === 'turn.queued' ? 'queued' : 'running'),
    protocol: event.protocol || null,
    appMethod: event.appMethod || null,
    source: event.source || null,
    projectId: event.projectId || null,
    sessionId: event.sessionId || null,
    previousSessionId: event.previousSessionId || null,
    turnId: event.turnId || event.clientTurnId || null,
    clientTurnId: event.clientTurnId || null,
    appTurnId: event.appTurnId || null,
    label: event.label || null,
    detail: event.detail || null,
    startedAt: event.startedAt || event.timestamp || new Date().toISOString(),
    updatedAt: event.timestamp || new Date().toISOString(),
    steerable: event.source === 'desktop-ipc' ? false : true
  };
}

export function applySyncRuntimeEvent(runtimeById = {}, event = {}) {
  const keys = syncEventRunKeys(event);
  if (!keys.length) {
    return runtimeById || {};
  }
  const next = { ...(runtimeById || {}) };
  if (isSyncTerminalEvent(event)) {
    for (const key of keys) {
      delete next[key];
    }
    return next;
  }
  if (!isSyncRunningEvent(event)) {
    return runtimeById || {};
  }
  const runtime = runtimeRecordForSyncEvent(event);
  const anchor = runtimeGroupAnchor(next, keys, runtime.status);
  for (const key of keys) {
    next[key] = mergeRuntimeRecord(next[key] || anchor, runtime);
  }
  return next;
}

export function mergeSyncStateRuntime(runtimeById = {}, syncState = {}) {
  const incoming = syncState?.runtimeById && typeof syncState.runtimeById === 'object'
    ? syncState.runtimeById
    : {};
  const next = { ...(runtimeById || {}) };
  const incomingKeys = Object.keys(incoming);
  for (const [key, runtime] of Object.entries(incoming)) {
    if (runtime?.status === 'running' || runtime?.status === 'queued') {
      const anchor = runtimeGroupAnchor(next, incomingKeys, runtime.status);
      next[key] = mergeRuntimeRecord(next[key] || anchor, runtime);
    }
  }
  const incomingKeySet = new Set(incomingKeys);
  for (const [key, runtime] of Object.entries(next)) {
    if (
      ['desktop-ipc', 'headless-local', 'local-handoff', 'codexmobile'].includes(String(runtime?.source || '')) &&
      !incomingKeySet.has(key)
    ) {
      delete next[key];
    }
  }
  return next;
}

export function sessionMatchesSyncEvent(session = null, event = {}) {
  if (!session) {
    return true;
  }
  const keys = new Set(syncEventRunKeys(event));
  return keys.has(String(session.id || '')) || keys.has(String(session.turnId || ''));
}

function mergeRuntimeRecord(previous, incoming) {
  if (!previous || !isLiveRuntimeStatus(previous.status)) {
    return incoming;
  }
  const previousStatus = String(previous.status || '').toLowerCase();
  const incomingStatus = String(incoming.status || '').toLowerCase();
  const preserveStartedAt =
    previousStatus === incomingStatus ||
    (previousStatus === 'running' && incomingStatus === 'running');
  return {
    ...previous,
    ...incoming,
    startedAt: preserveStartedAt ? (previous.startedAt || incoming.startedAt) : incoming.startedAt
  };
}

function runtimeGroupAnchor(runtimeById = {}, keys = [], incomingStatus = '') {
  const normalizedStatus = String(incomingStatus || '').toLowerCase();
  if (!isLiveRuntimeStatus(normalizedStatus)) {
    return null;
  }
  const candidates = keys
    .map((key) => runtimeById?.[key])
    .filter((runtime) => isLiveRuntimeStatus(String(runtime?.status || '').toLowerCase()));
  return candidates.find((runtime) => String(runtime.status || '').toLowerCase() === normalizedStatus) ||
    candidates.find((runtime) => String(runtime.status || '').toLowerCase() === 'running') ||
    candidates[0] ||
    null;
}

function isLiveRuntimeStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'running' || normalized === 'queued';
}
