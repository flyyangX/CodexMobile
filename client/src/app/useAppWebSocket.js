/**
 * WebSocket 入站连接器：只消费 connected 与统一 sync payload，旧 live payload 不再直接驱动 UI。
 *
 * Keywords: websocket, sync-state, sync-event, connection
 *
 * Exports:
 * - 若干 `should*` 纯函数 — 旧测试兼容守卫，统一返回不直连旧 UI。
 * - useAppWebSocket — 建立 WS 连接并把 sync payload 分发到同步消费层。
 *
 * Inward: api、sync/useSyncSocket、model-sync、session-live-refresh。
 *
 * Outward: App.jsx 根编排。
 */

import { apiFetch, websocketUrl } from '../api.js';
import { applySessionRenameToProjectSessions } from '../session-live-refresh.js';
import { mergeModelSettingsIntoStatus, shouldApplyModelSettings } from './model-sync.js';
import { normalizeContextStatus } from './context-status.js';
import { applySyncSocketPayload } from '../sync/useSyncSocket.js';

export function isExternalThreadPayload(payload = {}) {
  void payload;
  return false;
}

export function isDesktopThreadStatusPayload(payload = {}) {
  void payload;
  return false;
}

export function shouldRenderStatusMessageForPayload(payload = {}) {
  void payload;
  return false;
}

export function shouldRenderActivityMessageForPayload(payload = {}) {
  void payload;
  return false;
}

export function shouldRenderAssistantMessageForPayload(payload = {}) {
  void payload;
  return false;
}

export function shouldRefreshDesktopThreadForPayload(payload = {}) {
  void payload;
  return false;
}

export function shouldCompleteLocalTurnBeforeRefresh(payload = {}) {
  void payload;
  return false;
}

export function shouldRefreshCurrentSessionAfterReconnect(session = null) {
  const sessionId = String(session?.id || '').trim();
  return Boolean(sessionId && !sessionId.startsWith('draft-'));
}

export function useAppWebSocket({
  useEffect,
  authenticated,
  defaultStatus,
  wsRef,
  selectedProjectRef,
  selectedSessionRef,
  setConnectionState,
  setStatus,
  setRunningById,
  runningByIdRef,
  setThreadRuntimeById,
  setSelectedSession,
  setSessionsByProject,
  setMessages,
  setContextStatus,
  setProjects,
  setSelectedProject,
  setExpandedProjectIds,
  loadSessions,
  markRun,
  clearRun,
  markSessionCompleteNotice,
  markTurnCompleted,
  scheduleTurnRefresh,
  upsertSessionInProject,
  onAuthRevoked
}) {
  useEffect(() => {
    if (!authenticated) {
      setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    let reconnectTimer = null;

    async function refreshCurrentSessionAfterReconnect() {
      const project = selectedProjectRef.current;
      const session = selectedSessionRef.current;
      if (!project?.id || !shouldRefreshCurrentSessionAfterReconnect(session)) {
        return;
      }
      await apiFetch('/api/sync', { method: 'POST' }).catch(() => null);
      await loadSessions(project, {
        chooseLatest: false,
        preferredSessionId: session.id,
        preserveSelection: true,
        silent: true
      });
    }

    function applyModelFromSyncPayload(payload = {}) {
      const settings =
        payload.type === 'sync-state'
          ? payload.state?.modelSettings
          : payload.event?.eventType === 'model.updated'
            ? payload.event
            : null;
      if (settings && shouldApplyModelSettings(settings, selectedSessionRef.current)) {
        setStatus((current) => mergeModelSettingsIntoStatus(current, settings));
      }
    }

    function handleThreadRenamed(event = {}) {
      const sessionId = event.sessionId || event.session?.id;
      const projectId = event.projectId || event.session?.projectId;
      const title = String(event.title || event.session?.title || '').trim();
      if (!sessionId || !projectId || !title) {
        return;
      }
      const renamePayload = {
        projectId,
        sessionId,
        title,
        titleLocked: event.titleLocked ?? event.session?.titleLocked ?? true,
        updatedAt: event.timestamp,
        session: event.session
      };
      setSessionsByProject((current) => applySessionRenameToProjectSessions(current, renamePayload));
      setSelectedSession((current) => {
        if (!current || String(current.id) !== String(sessionId)) {
          return current;
        }
        return { ...current, ...(event.session || {}), id: sessionId, projectId, title };
      });
    }

    function handleSessionsSynced(event = {}) {
      if (!Array.isArray(event.projects)) {
        return;
      }
      setProjects(event.projects);
      const project = selectedProjectRef.current;
      if (!project?.id) {
        const preferred =
          event.projects.find((item) => item.name.toLowerCase() === 'codexmobile') ||
          event.projects.find((item) => item.path.toLowerCase().includes('codexmobile')) ||
          event.projects[0] ||
          null;
        if (preferred) {
          setSelectedProject(preferred);
          setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
          loadSessions(preferred, {
            chooseLatest: true,
            preserveSelection: false
          }).catch(() => null);
        }
        return;
      }
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
        .then((data) => {
          const nextSessions = data.sessions || [];
          setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
          const currentSession = selectedSessionRef.current;
          const refreshedSession = nextSessions.find((session) => session.id === currentSession?.id);
          if (refreshedSession) {
            setSelectedSession((current) => (current?.id === refreshedSession.id ? { ...current, ...refreshedSession } : current));
            setContextStatus(normalizeContextStatus(refreshedSession.context || defaultStatus.context, defaultStatus.context));
          }
        })
        .catch(() => null);
    }

    function applySyncPayload(payload = {}) {
      applyModelFromSyncPayload(payload);
      applySyncSocketPayload(payload, {
        defaultStatus,
        selectedProjectRef,
        selectedSessionRef,
        setRunningById,
        runningByIdRef,
        setThreadRuntimeById,
        markRun,
        clearRun,
        markSessionCompleteNotice,
        markTurnCompleted,
        scheduleTurnRefresh,
        setMessages,
        setContextStatus,
        setProjects,
        setSelectedSession,
        setSessionsByProject,
        upsertSessionInProject,
        handleThreadRenamed
      });
      if (payload.type === 'sync-event' && payload.event?.eventType === 'sessions.synced') {
        handleSessionsSynced(payload.event);
      }
    }

    const connect = () => {
      setConnectionState('connecting');
      const ws = new WebSocket(websocketUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnectionState('connecting');
      ws.onclose = (event) => {
        setConnectionState('disconnected');
        if (event.code === 1008 || String(event.reason || '').toLowerCase().includes('revoked')) {
          stopped = true;
          onAuthRevoked?.();
          return;
        }
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 1200);
        }
      };
      ws.onerror = () => setConnectionState('disconnected');
      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'connected') {
          setStatus(payload.status || defaultStatus);
          setConnectionState(payload.status?.connected ? 'connected' : 'disconnected');
          if (payload.status?.syncState) {
            applySyncPayload({ type: 'sync-state', state: payload.status.syncState });
          }
          if (payload.status?.connected) {
            refreshCurrentSessionAfterReconnect().catch(() => null);
          }
          return;
        }
        if (payload.type === 'sync-state' || payload.type === 'sync-event') {
          applySyncPayload(payload);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      wsRef.current?.close();
      setConnectionState('disconnected');
    };
  }, [authenticated]);
}
