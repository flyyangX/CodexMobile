import { apiFetch, websocketUrl } from '../api.js';
import {
  applySessionRenameToProjectSessions
} from '../session-live-refresh.js';
import {
  upsertActivityMessage,
  upsertAssistantMessage,
  upsertStatusMessage
} from '../chat/activity-model.js';
import { sameUserMessageContent } from '../chat/message-identity.js';
import { mergeContextStatus, normalizeContextStatus } from './context-status.js';

const EXTERNAL_THREAD_SOURCES = new Set(['desktop-ipc', 'desktop-thread', 'headless-local']);

export function isExternalThreadPayload(payload = {}) {
  return EXTERNAL_THREAD_SOURCES.has(payload?.source);
}

export function isDesktopThreadStatusPayload(payload = {}) {
  return isExternalThreadPayload(payload);
}

export function shouldRenderStatusMessageForPayload(payload = {}) {
  if (isExternalThreadPayload(payload)) {
    return false;
  }
  return true;
}

export function shouldRenderActivityMessageForPayload(payload = {}) {
  return !isExternalThreadPayload(payload);
}

export function shouldRenderAssistantMessageForPayload(payload = {}) {
  return !isExternalThreadPayload(payload);
}

export function shouldRefreshDesktopThreadForPayload(payload = {}) {
  if (!isExternalThreadPayload(payload)) {
    return false;
  }
  if (payload.type === 'chat-complete') {
    return true;
  }
  return payload.type === 'status-update' && payload.kind === 'turn' && ['completed', 'failed'].includes(payload.status);
}

export function shouldCompleteLocalTurnBeforeRefresh(payload = {}) {
  if (!shouldRefreshDesktopThreadForPayload(payload)) {
    return false;
  }
  if (payload.type === 'chat-complete') {
    return true;
  }
  return payload.type === 'status-update' && payload.kind === 'turn' && payload.status === 'completed';
}

export function shouldRefreshCurrentSessionAfterReconnect(session = null) {
  const sessionId = String(session?.id || '').trim();
  return Boolean(sessionId && !sessionId.startsWith('draft-'));
}

export function isRevokedWebSocketClose(event = {}) {
  return Number(event?.code) === 1008 && String(event?.reason || '') === 'revoked';
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
  syncActiveRunsFromStatus,
  markRun,
  clearRun,
  markSessionCompleteNotice,
  markTurnCompleted,
  scheduleTurnRefresh,
  payloadMatchesCurrentConversation,
  upsertSessionInProject,
  setSelectedSession,
  setSessionsByProject,
  setMessages,
  setContextStatus,
  applyAutoSessionTitle,
  notifyFromPayload,
  loadQueueDrafts,
  setProjects,
  setSelectedProject,
  setExpandedProjectIds,
  loadSessions,
  onAuthenticationRevoked
}) {
  useEffect(() => {
    if (!authenticated) {
      setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    let reconnectTimer = null;
    let reconnectingAfterDrop = false;

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

    const connect = () => {
      setConnectionState('connecting');
      const ws = new WebSocket(websocketUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnectionState('connecting');
      ws.onclose = (event) => {
        setConnectionState('disconnected');
        if (isRevokedWebSocketClose(event)) {
          stopped = true;
          onAuthenticationRevoked?.();
          return;
        }
        if (!stopped) {
          reconnectingAfterDrop = true;
          reconnectTimer = window.setTimeout(connect, 1200);
        }
      };
      ws.onerror = () => setConnectionState('disconnected');
      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'connected') {
          const forceClearLocalRuns = reconnectingAfterDrop;
          reconnectingAfterDrop = false;
          setStatus(payload.status || defaultStatus);
          setConnectionState(payload.status?.connected ? 'connected' : 'disconnected');
          syncActiveRunsFromStatus(payload.status || defaultStatus, { forceClear: forceClearLocalRuns });
          if (payload.status?.connected) {
            refreshCurrentSessionAfterReconnect().catch(() => null);
          }
          return;
        }
        if (payload.type === 'chat-started') {
          markRun(payload);
          if (!payloadMatchesCurrentConversation(payload)) {
            return;
          }
          if (!selectedSessionRef.current && payload.sessionId) {
            setSelectedSession({ id: payload.sessionId, projectId: payload.projectId, title: '新对话' });
          }
          return;
        }
        if (payload.type === 'thread-started' && payload.sessionId) {
          const projectId = payload.projectId || selectedProjectRef.current?.id || selectedSessionRef.current?.projectId;
          const currentSession = selectedSessionRef.current;
          const nextSession = {
            ...(currentSession || {}),
            id: payload.sessionId,
            projectId,
            title: currentSession?.title || '新对话',
            turnId: payload.turnId || currentSession?.turnId || null,
            updatedAt: new Date().toISOString(),
            draft: false
          };
          markRun(payload);
          setSelectedSession((current) => {
            if (!current) {
              return nextSession;
            }
            const shouldReplace =
              current.id === payload.previousSessionId ||
              current.id === payload.sessionId ||
              current.turnId === payload.turnId ||
              (current.draft && current.projectId === projectId);
            return shouldReplace ? { ...current, ...nextSession } : current;
          });
          setSessionsByProject((current) =>
            upsertSessionInProject(current, projectId, nextSession, payload.previousSessionId)
          );
          setMessages((current) =>
            current.map((message) =>
              message.turnId === payload.turnId || message.sessionId === payload.previousSessionId
                ? { ...message, sessionId: payload.sessionId }
                : message
            )
          );
          return;
        }
        if (payload.type === 'message-deleted') {
          if (payloadMatchesCurrentConversation(payload)) {
            setMessages((current) => current.filter((message) => String(message.id) !== String(payload.messageId)));
          }
          return;
        }
        if (payload.type === 'session-renamed') {
          const sessionId = payload.sessionId || payload.session?.id;
          const projectId = payload.projectId || payload.session?.projectId;
          const title = String(payload.title || payload.session?.title || '').trim();
          if (!sessionId || !projectId || !title) {
            return;
          }
          setSessionsByProject((current) => applySessionRenameToProjectSessions(current, payload));
          setSelectedSession((current) => {
            if (!current || String(current.id) !== String(sessionId)) {
              return current;
            }
            return {
              ...current,
              ...(payload.session || {}),
              id: sessionId,
              projectId,
              title,
              titleLocked: payload.titleLocked ?? payload.session?.titleLocked ?? true,
              updatedAt: payload.updatedAt || payload.session?.updatedAt || current.updatedAt
            };
          });
          return;
        }
        if (payload.type === 'user-message') {
          if (!payloadMatchesCurrentConversation(payload)) {
            return;
          }
          setMessages((current) => {
            const alreadyShown = current.some(
              (message) => message.role === 'user' && sameUserMessageContent(message.content, payload.message.content)
            );
            if (alreadyShown) {
              return current;
            }
            return [...current, payload.message];
          });
          return;
        }
        if (payload.type === 'assistant-update') {
          if (!payload.content?.trim()) {
            return;
          }
          markRun(payload);
          if (!payloadMatchesCurrentConversation(payload)) {
            return;
          }
          if (!shouldRenderAssistantMessageForPayload(payload)) {
            return;
          }
          if (payload.phase === 'commentary') {
            setMessages((current) =>
              upsertStatusMessage(current, {
                ...payload,
                kind: payload.kind || 'agent_message',
                label: String(payload.content || '').trim(),
                status: payload.status || 'running'
              })
            );
            return;
          }
          setMessages((current) => upsertAssistantMessage(current, payload));
          if (payload.done !== false) {
            applyAutoSessionTitle(payload, payload.content);
          }
          return;
        }
        if (payload.type === 'status-update') {
          if (payload.status === 'running' || payload.status === 'queued') {
            markRun(payload);
          }
          notifyFromPayload(payload);
          if (payload.kind === 'turn' && payload.status === 'completed') {
            markSessionCompleteNotice(payload);
            clearRun(payload);
          }
          if (payload.status === 'queued' && payloadMatchesCurrentConversation(payload)) {
            loadQueueDrafts(selectedSessionRef.current).catch(() => null);
          }
          if (!payloadMatchesCurrentConversation(payload)) {
            return;
          }
          if (shouldRefreshDesktopThreadForPayload(payload)) {
            if (shouldCompleteLocalTurnBeforeRefresh(payload)) {
              markTurnCompleted(payload);
            }
            scheduleTurnRefresh(payload);
            return;
          }
          if (payload.kind === 'turn' && payload.status === 'completed') {
            markTurnCompleted(payload);
            return;
          }
          if (!shouldRenderStatusMessageForPayload(payload)) {
            return;
          }
          setMessages((current) => upsertStatusMessage(current, payload));
          return;
        }
        if (payload.type === 'activity-update') {
          if (payload.status === 'running' || payload.status === 'queued') {
            markRun(payload);
          }
          notifyFromPayload(payload);
          if (!payloadMatchesCurrentConversation(payload)) {
            return;
          }
          if (!shouldRenderActivityMessageForPayload(payload)) {
            return;
          }
          setMessages((current) => upsertActivityMessage(current, payload));
          return;
        }
        if (payload.type === 'context-status-update') {
          markRun(payload);
          if (payloadMatchesCurrentConversation(payload)) {
            setContextStatus((current) => mergeContextStatus(current, payload, defaultStatus.context));
          }
          return;
        }
        if (payload.type === 'chat-complete' || payload.type === 'chat-error' || payload.type === 'chat-aborted') {
          notifyFromPayload(payload);
          loadQueueDrafts(selectedSessionRef.current).catch(() => null);
          if (payload.type === 'chat-complete') {
            markSessionCompleteNotice(payload);
            clearRun(payload);
          }
          if (!payloadMatchesCurrentConversation(payload)) {
            clearRun(payload);
            return;
          }
          if (payload.type === 'chat-complete') {
            if (payload.context) {
              setContextStatus((current) => mergeContextStatus(current, payload.context, defaultStatus.context));
            }
            if (shouldRefreshDesktopThreadForPayload(payload)) {
              if (shouldCompleteLocalTurnBeforeRefresh(payload)) {
                markTurnCompleted(payload);
              }
              scheduleTurnRefresh(payload);
              return;
            }
            markTurnCompleted(payload);
            scheduleTurnRefresh(payload);
            return;
          }
          clearRun(payload);
          if (payload.type === 'chat-error' && payload.error) {
            setMessages((current) =>
              upsertStatusMessage(current, {
                ...payload,
                status: 'failed',
                label: '任务失败',
                detail: payload.error
              })
            );
          } else if (payload.type === 'chat-aborted') {
            setMessages((current) =>
              upsertStatusMessage(current, {
                ...payload,
                status: 'completed',
                label: '已中止'
              })
            );
          }
          return;
        }
        if (payload.type === 'sync-complete' && payload.projects) {
          setProjects(payload.projects);
          const project = selectedProjectRef.current;
          if (!project?.id) {
            const preferred =
              payload.projects.find((item) => item.name.toLowerCase() === 'codexmobile') ||
              payload.projects.find((item) => item.path.toLowerCase().includes('codexmobile')) ||
              payload.projects[0] ||
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
          if (project?.id) {
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
