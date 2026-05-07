import { useCallback, useEffect } from 'react';
import { apiFetch } from '../api.js';
import {
  completeActivityMessagesForTurn,
  hasAssistantMessageForTurn,
  mergeLoadedMessagesPreservingActivity,
  upsertStatusMessage
} from '../chat/activity-model.js';
import { mergeContextStatus } from './context-status.js';
import {
  hasVisibleAssistantForTurn,
  isDraftSession,
  payloadRunKeys,
  sessionMessagesApiPath
} from './session-utils.js';

export function useTurnRuntime({
  defaultStatus,
  activePollsRef,
  turnRefreshTimersRef,
  desktopIpcPendingRunsRef,
  selectedSessionRef,
  runningByIdRef,
  setRunningById,
  setThreadRuntimeById,
  setCompletedSessionIds,
  setMessages,
  setContextStatus
}) {
  useEffect(
    () => () => {
      for (const timer of turnRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      turnRefreshTimersRef.current.clear();
    },
    [turnRefreshTimersRef]
  );

  function runtimeKeysForPayload(payload) {
    const keys = new Set(payloadRunKeys(payload));
    const current = selectedSessionRef.current;
    if (current) {
      const sameProject = !payload?.projectId || !current.projectId || payload.projectId === current.projectId;
      const matchesCurrent =
        keys.has(current.id) ||
        keys.has(current.turnId) ||
        (payload?.turnId && current.turnId === payload.turnId) ||
        (current.draft && sameProject);
      if (matchesCurrent) {
        if (current.id) {
          keys.add(current.id);
        }
        if (current.turnId) {
          keys.add(current.turnId);
        }
      }
    }
    return Array.from(keys).filter(Boolean);
  }

  function markRun(payload) {
    const keys = runtimeKeysForPayload(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = {
          status: 'running',
          steerable: payload.steerable !== false,
          updatedAt: payload.timestamp || payload.startedAt || new Date().toISOString()
        };
      }
      return next;
    });
  }

  function clearRun(payload) {
    const keys = runtimeKeysForPayload(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (next[key]?.status === 'running') {
          delete next[key];
        }
      }
      return next;
    });
  }

  function markSessionCompleteNotice(payload) {
    const ids = runtimeKeysForPayload(payload).filter((id) => !isDraftSession(id));
    if (!ids.length) {
      return;
    }
    setCompletedSessionIds((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = true;
      }
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = {
          status: 'completed',
          updatedAt: payload.completedAt || payload.timestamp || new Date().toISOString()
        };
      }
      return next;
    });
  }

  function clearSessionCompleteNotice(sessionId) {
    if (!sessionId) {
      return;
    }
    setCompletedSessionIds((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setThreadRuntimeById((current) => {
      if (current[sessionId]?.status !== 'completed') {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  const syncActiveRunsFromStatus = useCallback((nextStatus) => {
    const activeRuns = Array.isArray(nextStatus?.activeRuns) ? nextStatus.activeRuns : [];
    const shouldPreserveLocalRuns =
      activePollsRef.current.size > 0 ||
      turnRefreshTimersRef.current.size > 0;

    if (!activeRuns.length) {
      if (!shouldPreserveLocalRuns) {
        setRunningById(() => {
          runningByIdRef.current = {};
          return {};
        });
        setThreadRuntimeById((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(next)) {
            if (value?.status === 'running') {
              delete next[key];
            }
          }
          return next;
        });
      }
      setMessages((current) => {
        if (shouldPreserveLocalRuns) {
          return current;
        }
        return current.filter(
          (message) => !(message.role === 'activity' && (message.status === 'running' || message.status === 'queued'))
        );
      });
      return;
    }

    const nextRunning = {};
    const nextRuntime = {};
    for (const run of activeRuns) {
      for (const key of payloadRunKeys(run)) {
        nextRunning[key] = true;
        nextRuntime[key] = {
          status: 'running',
          steerable: run.steerable !== false,
          updatedAt: run.startedAt || new Date().toISOString()
        };
      }
    }
    setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRuntime } : nextRuntime;
      return next;
    });
  }, [activePollsRef, runningByIdRef, setMessages, setRunningById, setThreadRuntimeById, turnRefreshTimersRef]);

  function payloadMatchesCurrentConversation(payload) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    const keys = payloadRunKeys(payload);
    return keys.includes(current.id) || keys.includes(current.turnId);
  }

  function clearTurnRefreshTimer(turnId) {
    if (!turnId) {
      return;
    }
    const timer = turnRefreshTimersRef.current.get(turnId);
    if (timer) {
      window.clearTimeout(timer);
      turnRefreshTimersRef.current.delete(turnId);
    }
  }

  function rememberDesktopIpcPendingRun(sessionId, pending) {
    if (!sessionId || !pending?.message) {
      return;
    }
    desktopIpcPendingRunsRef.current.set(sessionId, {
      ...pending,
      sessionId,
      startedAt: pending.startedAt || new Date().toISOString()
    });
  }

  function completeDesktopIpcPendingRun(sessionId) {
    const pending = desktopIpcPendingRunsRef.current.get(sessionId);
    if (!pending) {
      return false;
    }
    desktopIpcPendingRunsRef.current.delete(sessionId);
    const completedPayload = {
      sessionId,
      turnId: selectedSessionRef.current?.turnId || pending.clientTurnId || pending.turnId || null,
      completedAt: new Date().toISOString()
    };
    clearRun(completedPayload);
    if (pending.turnId && pending.turnId !== completedPayload.turnId) {
      clearRun({ ...completedPayload, turnId: pending.turnId });
    }
    if (pending.clientTurnId && pending.clientTurnId !== completedPayload.turnId) {
      clearRun({ ...completedPayload, turnId: pending.clientTurnId });
    }
    markSessionCompleteNotice(completedPayload);
    return true;
  }

  async function refreshMessagesForPayload(payload) {
    if (!payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(sessionMessagesApiPath(payload.sessionId));
      if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, payload)) {
        setContextStatus((current) => mergeContextStatus(current, data.context || defaultStatus.context, defaultStatus.context));
        setMessages((current) => mergeLoadedMessagesPreservingActivity(current, data.messages, payload));
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function finalizeTurnWithoutAssistant(payload) {
    if (!payload?.turnId) {
      return;
    }
    clearTurnRefreshTimer(payload.turnId);
    setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'completed',
        label: '任务已完成',
        detail: payload.error || payload.detail || ''
      })
    );
    clearRun(payload);
  }

  function markTurnCompleted(payload, detail = '结果同步中') {
    if (!payload?.turnId) {
      return;
    }
    const completedAt = payload.completedAt || payload.timestamp || new Date().toISOString();
    setMessages((current) => {
      if (hasAssistantMessageForTurn(current, payload)) {
        return completeActivityMessagesForTurn(current, { ...payload, completedAt });
      }
      return upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'completed',
        label: '任务已完成',
        detail,
        completedAt
      });
    });
  }

  function scheduleTurnRefresh(payload, attempt = 0) {
    const turnId = payload?.turnId;
    if (!turnId || !payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return;
    }
    clearTurnRefreshTimer(turnId);
    const delays = [300, 800, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000, 30000];
    const delay = delays[attempt];
    if (delay === undefined) {
      finalizeTurnWithoutAssistant(payload);
      return;
    }

    const timer = window.setTimeout(async () => {
      if (!payloadMatchesCurrentConversation(payload)) {
        return;
      }
      const loaded = await refreshMessagesForPayload(payload);
      if (loaded) {
        clearTurnRefreshTimer(turnId);
        clearRun(payload);
        return;
      }
      scheduleTurnRefresh(payload, attempt + 1);
    }, delay);
    turnRefreshTimersRef.current.set(turnId, timer);
  }

  return {
    markRun,
    clearRun,
    markSessionCompleteNotice,
    clearSessionCompleteNotice,
    syncActiveRunsFromStatus,
    payloadMatchesCurrentConversation,
    rememberDesktopIpcPendingRun,
    completeDesktopIpcPendingRun,
    markTurnCompleted,
    scheduleTurnRefresh
  };
}
