/**
 * 同步状态仓库：消费 SyncEvent，维护服务端可广播给移动端的 live runtime 与会话快照。
 *
 * Keywords: sync-store, runtime-state, websocket, projection
 *
 * Exports:
 * - createSyncStore — 创建内存同步仓库。
 *
 * Inward（本模块依赖/组装的关键符号）: sync-events 的 run key 与生命周期判定。
 *
 * Outward（谁在用/调用场景）: sync-bridge 处理旧广播后更新统一状态。
 *
 * 不负责: 持久化；持久真相仍来自 Codex jsonl/sqlite/session index。
 */

import {
  isRuntimeSyncEvent,
  isTerminalSyncEvent,
  runKeysForSyncEvent
} from './sync-events.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function runtimeForEvent(event) {
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
    startedAt: event.startedAt || event.timestamp || null,
    updatedAt: event.timestamp || new Date().toISOString(),
    steerable: event.source === 'desktop-ipc' ? false : true
  };
}

export function createSyncStore({ maxEvents = 200 } = {}) {
  const state = {
    runtimeById: {},
    terminalById: {},
    bridgeStatus: null,
    modelSettings: null,
    projects: [],
    syncedAt: null,
    events: []
  };

  function rememberEvent(event) {
    state.events.push(event);
    if (state.events.length > maxEvents) {
      state.events.splice(0, state.events.length - maxEvents);
    }
  }

  function applyRuntime(event) {
    const keys = runKeysForSyncEvent(event);
    if (!keys.length) {
      return;
    }
    if (isTerminalSyncEvent(event)) {
      const keysToClear = new Set(keys);
      const sessionKeys = new Set([event.sessionId, event.previousSessionId].filter(Boolean).map(String));
      for (const [key, runtime] of Object.entries(state.runtimeById)) {
        const runtimeSessionKeys = [runtime?.sessionId, runtime?.previousSessionId].filter(Boolean).map(String);
        if (runtimeSessionKeys.some((id) => sessionKeys.has(id))) {
          keysToClear.add(key);
        }
      }
      for (const key of keysToClear) {
        delete state.runtimeById[key];
        state.terminalById[key] = {
          status: event.status || event.eventType.split('.')[1],
          protocol: event.protocol || null,
          appMethod: event.appMethod || null,
          source: event.source || null,
          sessionId: event.sessionId || null,
          previousSessionId: event.previousSessionId || null,
          turnId: event.turnId || event.clientTurnId || null,
          clientTurnId: event.clientTurnId || null,
          appTurnId: event.appTurnId || null,
          completedAt: event.completedAt || event.timestamp || null,
          updatedAt: event.timestamp || new Date().toISOString()
        };
      }
      return;
    }
    const runtime = runtimeForEvent(event);
    for (const key of keys) {
      state.runtimeById[key] = runtime;
      delete state.terminalById[key];
    }
  }

  function applyEvent(event) {
    if (!event?.eventType) {
      return snapshot();
    }
    rememberEvent(event);
    if (isRuntimeSyncEvent(event)) {
      applyRuntime(event);
    }
    if (event.eventType === 'sessions.synced') {
      state.projects = Array.isArray(event.projects) ? event.projects : state.projects;
      state.syncedAt = event.syncedAt || event.timestamp || state.syncedAt;
    }
    if (event.eventType === 'model.updated') {
      state.modelSettings = {
        provider: event.provider || null,
        model: event.model || null,
        modelShort: event.modelShort || null,
        reasoningEffort: event.reasoningEffort || null,
        sessionId: event.sessionId || null,
        updatedAt: event.timestamp || new Date().toISOString(),
        source: event.source || null,
        desktopSync: event.desktopSync || null
      };
    }
    if (event.eventType === 'thread.renamed' && event.sessionId && event.title) {
      state.projects = state.projects.map((project) => ({
        ...project,
        sessions: Array.isArray(project.sessions)
          ? project.sessions.map((session) =>
            String(session.id) === String(event.sessionId)
              ? { ...session, title: event.title, titleLocked: event.titleLocked, updatedAt: event.timestamp }
              : session
          )
          : project.sessions
      }));
    }
    return snapshot();
  }

  function setBridgeStatus(bridgeStatus) {
    state.bridgeStatus = bridgeStatus || null;
  }

  function snapshot() {
    return {
      runtimeById: clone(state.runtimeById) || {},
      terminalById: clone(state.terminalById) || {},
      bridgeStatus: clone(state.bridgeStatus),
      modelSettings: clone(state.modelSettings),
      projects: clone(state.projects) || [],
      syncedAt: state.syncedAt,
      lastEventId: state.events.at(-1)?.id || null
    };
  }

  return {
    applyEvent,
    setBridgeStatus,
    snapshot
  };
}
