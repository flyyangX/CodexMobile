import { useEffect } from 'react';
import { apiFetch } from '../api.js';
import {
  messageStreamSignature
} from '../chat/activity-model.js';
import {
  desktopThreadHasAssistantAfterLocalSend,
  desktopThreadHasAssistantAfterPendingSend,
  mergeLiveSelectedThreadMessages,
  shouldPollSelectedSessionMessages
} from '../session-live-refresh.js';
import { mergeContextStatus } from './context-status.js';
import {
  hasRunningKey,
  isDraftSession,
  selectedRunKeys,
  sessionMessagesApiPath
} from './session-utils.js';

export function useSessionLivePolling({
  authenticated,
  selectedSession,
  hasRunningActivity,
  running,
  desktopBridge,
  defaultStatus,
  sessionLivePollRef,
  selectedSessionRef,
  runningByIdRef,
  desktopIpcPendingRunsRef,
  messagesRef,
  setContextStatus,
  setMessages,
  completeDesktopIpcPendingRun
}) {
  useEffect(() => {
    if (!authenticated || !selectedSession?.id || isDraftSession(selectedSession)) {
      return undefined;
    }

    const sessionId = selectedSession.id;
    let stopped = false;
    async function pollSelectedSession() {
      if (stopped || sessionLivePollRef.current) {
        return;
      }
      const hasSelectedRunning = hasRunningKey(
        runningByIdRef.current || {},
        selectedRunKeys(selectedSessionRef.current || selectedSession)
      );
      const hasExternalThreadRefresh = Boolean(desktopIpcPendingRunsRef.current.get(sessionId));
      if (!shouldPollSelectedSessionMessages({
        hasSelectedRunning,
        desktopBridge,
        hasExternalThreadRefresh
      })) {
        return;
      }
      sessionLivePollRef.current = true;
      try {
        const data = await apiFetch(sessionMessagesApiPath(sessionId));
        if (!stopped && selectedSessionRef.current?.id === sessionId && Array.isArray(data.messages)) {
          const pendingDesktopRun = desktopIpcPendingRunsRef.current.get(sessionId) || null;
          const shouldCompleteDesktopRun =
            hasSelectedRunning &&
            desktopBridge?.mode === 'desktop-ipc' &&
            (
              desktopThreadHasAssistantAfterPendingSend(pendingDesktopRun, data.messages) ||
              desktopThreadHasAssistantAfterLocalSend(messagesRef.current, data.messages)
            );
          setContextStatus((current) => mergeContextStatus(current, data.context || defaultStatus.context, defaultStatus.context));
          setMessages((current) =>
            messageStreamSignature(current) === messageStreamSignature(data.messages)
              ? current
              : mergeLiveSelectedThreadMessages(current, data.messages)
          );
          if (shouldCompleteDesktopRun) {
            completeDesktopIpcPendingRun(sessionId);
          }
        }
      } catch {
        // Keep the currently rendered conversation if a transient poll fails.
      } finally {
        sessionLivePollRef.current = false;
      }
    }

    const intervalMs = hasRunningActivity || running ? 700 : 1600;
    const timer = window.setInterval(pollSelectedSession, intervalMs);
    pollSelectedSession();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    authenticated,
    selectedSession?.id,
    hasRunningActivity,
    running,
    desktopBridge
  ]);
}
