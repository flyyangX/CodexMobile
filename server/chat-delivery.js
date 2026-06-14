/**
 * 聊天投递层：读取桌面桥状态并执行后台 headless Codex 队列。
 *
 * Keywords: desktop-ipc, headless-codex, bridge, codex-turn-input
 *
 * Exports:
 * - readDesktopBridgeStatus — 获取桌面桥状态；移动端发送不因桌面离线而失败。
 * - runQueuedHeadlessChatJob — 排队执行后台 Codex。
 *
 * Inward（本模块依赖/组装的关键符号）: codex-runner 风格的 runCodexTurn、session registration hooks。
 *
 * Outward（谁在用/调用场景）: chat-service。
 *
 * 不负责: HTTP 层与路由注册。
 */
import { createSyncEventPayload } from './sync/sync-events.js';

export async function readDesktopBridgeStatus(getDesktopBridgeStatus) {
  if (!getDesktopBridgeStatus) {
    return null;
  }
  try {
    return await getDesktopBridgeStatus({ force: true });
  } catch (error) {
    return {
      connected: false,
      mode: 'unavailable',
      reason: error?.message || 'desktop bridge unavailable'
    };
  }
}

export function runQueuedHeadlessChatJob({
  job,
  queueKey,
  state,
  sessionId,
  runCodexTurn,
  registerProjectlessThread,
  registerMobileSession,
  refreshCodexCache,
  broadcast,
  rememberConversationAlias,
  rememberTurn,
  rememberLiveSession,
  notifyDesktopThreadListChanged,
  triggerDesktopRefreshForThread,
  requestCodexInteraction,
  emitJobEvent,
  scheduleAutoNameCompletedSession,
  onQueueDrained
}) {
  const metadataUpdates = [];
  let lastBackgroundThread = null;
  let terminalEventSeen = false;
  let desktopRefreshRequested = false;

  function requestDesktopRefresh(threadId, reason) {
    if (desktopRefreshRequested || !threadId) {
      return;
    }
    desktopRefreshRequested = true;
    Promise.resolve(triggerDesktopRefreshForThread?.(threadId, { reason })).catch((error) => {
      console.warn('[desktop-refresh] Failed to trigger after chat:', error.message);
    });
  }

  function rememberStartedBackgroundThread(payload) {
    if (!payload?.sessionId || !job.draftSessionId) {
      return;
    }
    const updatedAt = payload.startedAt || new Date().toISOString();
    const visibleContent = job.visibleMessage || job.displayMessage;
    const sessionRecord = {
      id: payload.sessionId,
      projectId: job.project.id,
      projectPath: job.executionProjectPath || job.project.path,
      projectless: Boolean(job.project?.projectless),
      title: job.displayMessage,
      summary: job.displayMessage,
      updatedAt,
      filePath: payload.filePath || payload.path || null,
      messages: [
        {
          id: `${payload.sessionId}-user-${job.turnId}`,
          role: 'user',
          content: visibleContent,
          timestamp: updatedAt
        }
      ]
    };
    const backgroundThread = {
      threadId: payload.sessionId,
      cwd: payload.cwd || job.executionProjectPath || job.project.path || null
    };
    lastBackgroundThread = backgroundThread;
    rememberLiveSession?.(sessionRecord);
    metadataUpdates.push(
      Promise.all([
        job.project?.projectless
          ? registerProjectlessThread(payload.sessionId, job.project.path)
          : Promise.resolve(null),
        registerMobileSession(sessionRecord)
      ]).then(() =>
        notifyDesktopThreadListChanged?.({
          ...backgroundThread,
          reason: 'background-thread-created'
        })
      ).catch((error) => {
        console.warn('[sessions] Failed to register background thread:', error.message);
      })
    );
  }

  function syncEventFromPayload(payload = {}) {
    return payload?.type === 'sync-event' ? payload.event : null;
  }

  function appServerThreadStartedPayload(payload = {}) {
    if (payload?.type !== 'app-server-message' || payload.appMessage?.method !== 'thread/started') {
      return null;
    }
    const thread = payload.appMessage?.params?.thread || {};
    const sessionId = thread.id || payload.context?.sessionId || '';
    return sessionId ? {
      sessionId,
      previousSessionId: payload.context?.previousSessionId || payload.context?.draftSessionId || null,
      turnId: payload.context?.turnId || job.turnId,
      projectPath: job.executionProjectPath || job.project.path,
      cwd: thread.cwd || job.executionProjectPath || job.project.path || null,
      filePath: thread.path || thread.filePath || null,
      startedAt: payload.context?.startedAt || new Date().toISOString()
    } : null;
  }

  function isTerminalPayload(payload = {}) {
    const event = syncEventFromPayload(payload);
    if (event) {
      return ['turn.completed', 'turn.failed', 'turn.aborted'].includes(event.eventType);
    }
    return payload?.type === 'app-server-message' && (
      payload.appMessage?.method === 'turn/completed' ||
      (payload.appMessage?.method === 'error' && !payload.appMessage?.params?.willRetry)
    );
  }

  function sessionIdFromPayload(payload = {}) {
    const event = syncEventFromPayload(payload);
    if (event) {
      return event.sessionId || event.previousSessionId || null;
    }
    if (payload?.type === 'app-server-message') {
      return payload.context?.sessionId || payload.context?.previousSessionId || payload.appMessage?.params?.thread?.id || null;
    }
    return payload.sessionId || null;
  }

  function previousSessionIdFromPayload(payload = {}) {
    const event = syncEventFromPayload(payload);
    return event ? event.previousSessionId || event.draftSessionId || null : payload.previousSessionId || null;
  }

  runCodexTurn(
    {
      sessionId,
      draftSessionId: job.draftSessionId,
      projectPath: job.executionProjectPath || job.project.path,
      message: job.codexMessage,
      attachments: job.attachments,
      selectedSkills: job.selectedSkills,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      serviceTier: job.serviceTier,
      permissionMode: job.permissionMode,
      collaborationMode: job.collaborationMode || null,
      turnId: job.turnId,
      onCodexServerRequest: requestCodexInteraction
        ? (appMessage, context) => requestCodexInteraction(job, appMessage, context)
        : null
    },
    (payload) => {
      const eventPayload = {
        ...payload,
        source: payload?.source || 'headless-local'
      };
      if (isTerminalPayload(eventPayload)) {
        terminalEventSeen = true;
        requestDesktopRefresh(
          sessionIdFromPayload(eventPayload) || state.sessionId || sessionId || job.selectedSessionId,
          lastBackgroundThread ? 'background-thread-done' : 'headless-turn-done'
        );
      }
      const payloadSessionId = sessionIdFromPayload(eventPayload);
      const payloadPreviousSessionId = previousSessionIdFromPayload(eventPayload);
      if (payloadSessionId) {
        state.sessionId = payloadSessionId;
        rememberConversationAlias(queueKey, payloadSessionId);
      }
      if (payloadPreviousSessionId) {
        rememberConversationAlias(queueKey, payloadPreviousSessionId);
      }
      const event = syncEventFromPayload(eventPayload);
      if (event?.eventType === 'thread.started') {
        rememberStartedBackgroundThread(event);
      } else {
        const startedPayload = appServerThreadStartedPayload(eventPayload);
        if (startedPayload) {
          rememberStartedBackgroundThread(startedPayload);
        }
      }
      emitJobEvent(job, eventPayload);
    }
  ).then(async (finalSessionId) => {
    if (finalSessionId) {
      state.sessionId = finalSessionId;
      rememberConversationAlias(queueKey, finalSessionId);
    }
    rememberTurn(job.turnId, {
      projectId: job.project.id,
      sessionId: finalSessionId || sessionId || job.selectedSessionId || job.draftSessionId || null,
      previousSessionId: job.draftSessionId || job.selectedSessionId || null
    });
    if (job.draftSessionId) {
      scheduleAutoNameCompletedSession({
        sessionId: finalSessionId || sessionId || job.selectedSessionId || null,
        turnId: job.turnId,
        userMessage: job.displayMessage
      });
    }
    if (!terminalEventSeen) {
      const completedAt = new Date().toISOString();
      terminalEventSeen = true;
      emitJobEvent(job, createSyncEventPayload('turn.completed', {
        source: 'headless-local',
        projectId: job.project.id,
        sessionId: finalSessionId || sessionId || job.selectedSessionId || null,
        previousSessionId: job.draftSessionId || job.selectedSessionId || null,
        turnId: job.turnId,
        completedAt,
        timestamp: completedAt
      }));
    }
  }).catch((error) => {
    if (terminalEventSeen) {
      return;
    }
    const completedAt = new Date().toISOString();
    terminalEventSeen = true;
    emitJobEvent(job, createSyncEventPayload('turn.failed', {
      source: 'headless-local',
      projectId: job.project.id,
      sessionId: state.sessionId || sessionId || job.selectedSessionId || null,
      previousSessionId: job.draftSessionId || job.selectedSessionId || null,
      turnId: job.turnId,
      error: error?.message || '任务失败',
      detail: error?.message || '任务失败',
      completedAt,
      timestamp: completedAt
    }));
  }).finally(async () => {
    state.running = false;
    if (state.jobs.length) {
      onQueueDrained?.();
    }
    try {
      if (metadataUpdates.length) {
        await Promise.allSettled(metadataUpdates);
      }
      const snapshot = await refreshCodexCache();
      broadcast(createSyncEventPayload('sessions.synced', {
        source: 'headless-local',
        syncedAt: snapshot.syncedAt,
        projects: snapshot.projects
      }, {
        syncedAt: snapshot.syncedAt,
        projects: snapshot.projects
      }));
      const refreshThreadId = lastBackgroundThread?.threadId || state.sessionId || sessionId || job.selectedSessionId || null;
      if (lastBackgroundThread) {
        await notifyDesktopThreadListChanged?.({
          ...lastBackgroundThread,
          reason: 'background-thread-done'
        });
      }
      if (refreshThreadId) {
        requestDesktopRefresh(refreshThreadId, lastBackgroundThread ? 'background-thread-done' : 'headless-turn-done');
      }
    } catch (error) {
      console.warn('[sync] Failed to refresh after chat:', error.message);
    }
  });
}
