import {
  registerProjectlessThread as registerProjectlessThreadInCodexState
} from './codex-config.js';
import { registerMobileSession as registerMobileSessionInIndex } from './mobile-session-index.js';
import { createChatQueue } from './chat-queue.js';
import {
  assertDesktopBridgeAvailable,
  backgroundFallbackBridge,
  desktopIpcCanUseBackgroundFallback,
  runQueuedHeadlessChatJob,
  sendViaDesktopIpc
} from './chat-delivery.js';
import {
  prepareChatRequest,
  projectlessThreadWorkingDirectory
} from './chat-request-prep.js';
import { createChatImageHandler } from './chat-image-handler.js';
import { createChatAutoNamer } from './chat-auto-title.js';
import { createDesktopTurnMonitor } from './desktop-turn-monitor.js';
import { normalizePermissionMode } from './permission-policy.js';

export { normalizeSelectedSkills } from './chat-request-prep.js';

export function createChatService({
  imagePromptState,
  defaultReasoningEffort = 'xhigh',
  getProject,
  getSession,
  getCacheSnapshot,
  getDesktopBridgeStatus,
  listProjectSessions,
  readSessionMessages = async () => ({ messages: [] }),
  refreshCodexCache,
  renameSession,
  broadcast,
  runCodexTurn,
  steerCodexTurn,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  setDesktopFollowerModelAndReasoning,
  setDesktopFollowerCollaborationMode,
  abortCodexTurn,
  getActiveRuns,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession,
  registerProjectlessThread = registerProjectlessThreadInCodexState,
  registerMobileSession = registerMobileSessionInIndex,
  rememberLiveSession = () => null,
  uploadRoot = '',
  dangerFullAccessEnabled = false,
  desktopOwnerRetryDelays = [250, 700, 1500]
}) {
  const chatQueue = createChatQueue();
  const getConversationQueue = chatQueue.getConversationQueue;
  const rememberConversationAlias = chatQueue.rememberConversationAlias;
  const rememberTurn = chatQueue.rememberTurn;
  const rememberTurnEvent = chatQueue.rememberTurnEvent;
  const resolveConversationKey = chatQueue.resolveConversationKey;
  const chatImage = createChatImageHandler({
    imagePromptState,
    runImageTurn,
    isImageRequest,
    listProjectSessions,
    refreshCodexCache,
    broadcast,
    rememberTurn,
    emitJobEvent: (job, payload) => emitJobEvent(job, payload)
  });
  const desktopTurnMonitor = createDesktopTurnMonitor({
    readSessionMessages,
    refreshCodexCache,
    rememberTurn,
    broadcast
  });

  function sessionHasActiveWork(sessionId) {
    return (
      chatQueue.sessionHasActiveWork(sessionId, [
        ...getActiveRuns(),
        ...chatImage.getActiveImageRuns(),
        ...desktopTurnMonitor.getActiveRuns()
      ]) ||
      desktopTurnMonitor.hasActiveWork(sessionId)
    );
  }

  function activeLocalRunForAbort({ turnId = '', sessionId = '', previousSessionId = '' } = {}) {
    const ids = new Set([turnId, sessionId, previousSessionId].map((value) => String(value || '').trim()).filter(Boolean));
    if (!ids.size) {
      return null;
    }
    return getActiveRuns().find((run) => (
      run?.status === 'running' &&
      [run.turnId, run.sessionId, run.previousSessionId].some((value) => ids.has(String(value || '').trim()))
    )) || null;
  }

  function emitJobEvent(job, payload) {
    const enriched = { projectId: job.project.id, ...payload };
    rememberTurnEvent(enriched);
    broadcast(enriched);
  }

  const { scheduleAutoNameCompletedSession } = createChatAutoNamer({
    getTurn: chatQueue.getTurn,
    refreshCodexCache,
    getSession,
    maybeAutoNameSession,
    renameSession,
    broadcast
  });

  async function steerQueuedDraft(query = {}) {
    const draft = chatQueue.removeQueuedDraft(query);
    if (!draft) {
      return null;
    }
    const sessionId = String(query.sessionId || draft.sessionId || '').trim();
    if (!sessionId) {
      const error = new Error('没有可发送到当前任务的线程。');
      error.statusCode = 409;
      throw error;
    }
    return sendChat({
      projectId: query.projectId || draft.projectId,
      sessionId,
      message: draft.text,
      attachments: draft.attachments,
      selectedSkills: draft.selectedSkills,
      fileMentions: draft.fileMentions,
      collaborationMode: draft.collaborationMode,
      sendMode: 'steer'
    });
  }

  function enqueueChatJob(job, { forceQueued = false, autoStart = true } = {}) {
    const { queued, state } = chatQueue.enqueueJob(job, { forceQueued });

    if (queued) {
      const sessionId = state.sessionId || job.selectedSessionId || job.draftSessionId;
      rememberTurn(job.turnId, {
        status: 'queued',
        label: '已加入队列',
        sessionId: sessionId || null
      });
      broadcast({
        type: 'status-update',
        projectId: job.project.id,
        sessionId,
        turnId: job.turnId,
        kind: 'turn',
        status: 'queued',
        label: '已加入队列',
        detail: '',
        timestamp: new Date().toISOString()
      });
    }

    if (autoStart) {
      runNextQueuedChat(job.queueKey);
    }
    return queued;
  }

  function runNextQueuedChat(queueKey) {
    const state = getConversationQueue(queueKey);
    if (state.running) {
      return;
    }

    const job = state.jobs.shift();
    if (!job) {
      return;
    }

    state.running = true;
    const sessionId = state.sessionId || job.selectedSessionId;

    runQueuedHeadlessChatJob({
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
      emitJobEvent,
      scheduleAutoNameCompletedSession,
      onQueueDrained: () => setTimeout(() => runNextQueuedChat(queueKey), 0)
    });
  }

  async function sendChat(body, { remoteAddress = '' } = {}) {
    const attachmentCount = Array.isArray(body.attachments) ? body.attachments.length : 0;
    console.log(
      `[chat] send request remote=${remoteAddress} project=${body.projectId || ''} session=${body.sessionId || body.draftSessionId || ''} attachments=${attachmentCount}`
    );
    const project = getProject(body.projectId);
    if (!project) {
      console.warn(`[chat] rejected project not found: ${body.projectId || ''}`);
      const error = new Error('Project not found');
      error.statusCode = 404;
      throw error;
    }
    const config = getCacheSnapshot().config || {};
    const prepared = prepareChatRequest(body, {
      getSession,
      config,
      defaultReasoningEffort,
      uploadRoot
    });
    const {
      attachments,
      fileMentions,
      requestedSessionId,
      draftSessionId,
      turnId,
      sendMode,
      selectedSkills,
      modelForTurn,
      reasoningEffortForTurn,
      serviceTierForTurn,
      collaborationMode,
      displayMessage,
      visibleMessage,
      codexMessage
    } = prepared;
    const permissionModeForTurn = normalizePermissionMode(body.permissionMode, { dangerFullAccessEnabled });
    let selectedSessionId = prepared.selectedSessionId;
    let conversationSessionId = prepared.conversationSessionId;
    let bridge = await assertDesktopBridgeAvailable(getDesktopBridgeStatus);

    const imagePrompt = chatImage.resolveImagePrompt({
      enabled: useLegacyImageGenerator(),
      projectId: project.id,
      displayMessage,
      attachments
    });
    const queueKey = resolveConversationKey(selectedSessionId, draftSessionId, requestedSessionId);
    const existingConversationState = getConversationQueue(queueKey);
    let selectedSessionResolvedFromBackgroundAlias = false;
    if (!selectedSessionId && draftSessionId && existingConversationState.sessionId) {
      selectedSessionId = existingConversationState.sessionId;
      conversationSessionId = selectedSessionId;
      selectedSessionResolvedFromBackgroundAlias = true;
    }
    const shouldHoldInLocalQueue =
      sendMode === 'queue' &&
      conversationSessionId &&
      sessionHasActiveWork(conversationSessionId);

    if (shouldHoldInLocalQueue) {
      const queued = enqueueChatJob({
        queueKey,
        project,
        selectedSessionId,
        draftSessionId,
        executionProjectPath: project.path,
        turnId,
        codexMessage,
        displayMessage,
        visibleMessage,
        attachments,
        selectedSkills,
        fileMentions,
        model: modelForTurn,
        reasoningEffort: reasoningEffortForTurn,
        serviceTier: serviceTierForTurn,
        permissionMode: permissionModeForTurn,
        collaborationMode
      }, { forceQueued: true, autoStart: false });
      return {
        accepted: true,
        queued,
        sessionId: selectedSessionId,
        draftSessionId,
        turnId,
        delivery: 'queued',
        desktopBridge: bridge
      };
    }

    if (bridge?.mode === 'desktop-ipc' && !imagePrompt) {
      if (!selectedSessionId && desktopIpcCanUseBackgroundFallback(bridge)) {
        bridge = backgroundFallbackBridge(bridge, '桌面端还不能从手机新建真实桌面线程，已改用后台 Codex 新建。');
      } else {
        try {
          const result = await sendViaDesktopIpc({
            bridge,
            project,
            selectedSessionId,
            draftSessionId,
            turnId,
            sendMode,
            codexMessage,
            visibleMessage,
            attachments,
            selectedSkills,
            model: modelForTurn,
            reasoningEffort: reasoningEffortForTurn,
            serviceTier: serviceTierForTurn,
            permissionMode: permissionModeForTurn,
            collaborationMode,
            getSession,
            rememberTurn,
            broadcast,
            setDesktopFollowerModelAndReasoning,
            setDesktopFollowerCollaborationMode,
            steerDesktopFollowerTurn,
            startDesktopFollowerTurn,
            interruptDesktopFollowerTurn,
            desktopOwnerRetryDelays
          });
          desktopTurnMonitor.startRun({
            projectId: project.id,
            sessionId: result.sessionId,
            previousSessionId: draftSessionId || selectedSessionId || null,
            draftSessionId,
            turnId: result.turnId,
            clientTurnId: result.clientTurnId || turnId,
            userMessage: visibleMessage,
            startedAt: new Date().toISOString()
          });
          return result;
        } catch (error) {
          const canFallBackToBackground =
            error?.code === 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE' &&
            desktopIpcCanUseBackgroundFallback(bridge);
          if (!canFallBackToBackground) {
            throw error;
          }
          bridge = backgroundFallbackBridge(
            bridge,
            selectedSessionResolvedFromBackgroundAlias
              ? undefined
              : '桌面端当前没有接管这个线程，已改用后台 Codex 继续执行。'
          );
        }
      }
    }

    if (sendMode === 'steer') {
      if (!selectedSessionId) {
        const error = new Error('新对话还没有桌面端线程，不能发送到当前任务。');
        error.statusCode = 409;
        throw error;
      }
      const result = await steerCodexTurn(selectedSessionId, {
        message: codexMessage,
        attachments,
        selectedSkills
      });
      rememberTurn(turnId, {
        projectId: project.id,
        projectPath: project.path,
        sessionId: result.sessionId || selectedSessionId,
        previousSessionId: selectedSessionId,
        status: 'running',
        label: '已发送到当前任务'
      });
      broadcast({
        type: 'user-message',
        sessionId: result.sessionId || selectedSessionId,
        projectId: project.id,
        message: {
          id: `local-${Date.now()}`,
          role: 'user',
          content: visibleMessage,
          timestamp: new Date().toISOString()
        }
      });
      broadcast({
        type: 'status-update',
        projectId: project.id,
        sessionId: result.sessionId || selectedSessionId,
        turnId,
        kind: 'turn',
        status: 'running',
        label: '已发送到当前任务',
        detail: '',
        timestamp: new Date().toISOString()
      });
      return {
        accepted: true,
        queued: false,
        delivery: 'steered',
        sessionId: result.sessionId || selectedSessionId,
        draftSessionId,
        turnId: result.turnId || turnId,
        clientTurnId: turnId,
        desktopBridge: bridge
      };
    }

    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: conversationSessionId,
      previousSessionId: draftSessionId || selectedSessionId || null,
      draftSessionId,
      status: 'accepted',
      label: '正在思考',
      hadAssistantText: false,
      startedAt: new Date().toISOString()
    });

    broadcast({
      type: 'user-message',
      sessionId: conversationSessionId,
      projectId: project.id,
      message: {
        id: `local-${Date.now()}`,
        role: 'user',
        content: visibleMessage,
        timestamp: new Date().toISOString()
      }
    });

    if (imagePrompt) {
      return chatImage.startImageChat({
        project,
        selectedSessionId,
        conversationSessionId,
        draftSessionId,
        turnId,
        imagePrompt,
        attachments,
        config,
        bridge
      });
    }

    console.log(`[chat] accepted codex turn=${turnId} session=${selectedSessionId || draftSessionId || ''} project=${project.name}`);
    if (sendMode === 'interrupt' && selectedSessionId) {
      abortCodexTurn(selectedSessionId);
    }
    const executionProjectPath = project.projectless && draftSessionId && !selectedSessionId
      ? await projectlessThreadWorkingDirectory(project, displayMessage)
      : project.path;
    const queued = enqueueChatJob({
      queueKey,
      project,
      selectedSessionId,
      draftSessionId,
      executionProjectPath,
      turnId,
      codexMessage,
      displayMessage,
      visibleMessage,
      attachments,
      selectedSkills,
      fileMentions,
      model: modelForTurn,
      reasoningEffort: reasoningEffortForTurn,
      serviceTier: serviceTierForTurn,
      permissionMode: permissionModeForTurn,
      collaborationMode
    });

    return {
      accepted: true,
      queued,
      sessionId: selectedSessionId,
      draftSessionId,
      turnId,
      delivery: sendMode === 'interrupt' ? 'interrupted-started' : (queued ? 'queued' : 'started'),
      desktopBridge: bridge
    };
  }

  async function abortChat(body = {}, { remoteAddress = '' } = {}) {
    const turnId = String(body.turnId || '').trim();
    const sessionId = String(body.sessionId || '').trim();
    const previousSessionId = String(body.previousSessionId || '').trim();
    console.log(`[chat] abort request remote=${remoteAddress} turn=${turnId} session=${sessionId}`);
    const localRun = activeLocalRunForAbort({ turnId, sessionId, previousSessionId });
    if (localRun) {
      const aborted = abortCodexTurn(localRun.turnId || turnId || sessionId);
      const completedAt = new Date().toISOString();
      const payload = {
        type: 'chat-aborted',
        source: 'headless-local',
        projectId: body.projectId || undefined,
        sessionId: sessionId || localRun.sessionId || undefined,
        previousSessionId: previousSessionId || localRun.previousSessionId || undefined,
        turnId: turnId || localRun.turnId || sessionId,
        completedAt,
        timestamp: completedAt
      };
      rememberTurn(payload.turnId, {
        projectId: payload.projectId,
        sessionId: payload.sessionId,
        previousSessionId: payload.previousSessionId,
        source: 'headless-local',
        status: 'aborted',
        label: '已中止',
        completedAt
      });
      broadcast(payload);
      return Boolean(aborted || turnId || sessionId);
    }
    const desktopRun = desktopTurnMonitor.getRun(turnId) || desktopTurnMonitor.getRun(sessionId);
    if (desktopRun) {
      if (!interruptDesktopFollowerTurn) {
        const error = new Error('桌面端中止能力不可用，请在电脑端手动停止。');
        error.statusCode = 502;
        throw error;
      }
      try {
        await interruptDesktopFollowerTurn(desktopRun.sessionId);
      } catch (error) {
        const wrapped = new Error(`桌面端中止失败：${error.message || '请在电脑端手动停止。'}`);
        wrapped.statusCode = error.statusCode || 502;
        throw wrapped;
      }
      return desktopTurnMonitor.abortRun(turnId) || desktopTurnMonitor.abortRun(sessionId);
    }

    const aborted = abortCodexTurn(turnId || sessionId);
    if (!aborted && sessionId && interruptDesktopFollowerTurn) {
      const bridge = await getDesktopBridgeStatus().catch(() => null);
      if (bridge?.connected && bridge.mode === 'desktop-ipc') {
        try {
          await interruptDesktopFollowerTurn(sessionId);
        } catch (error) {
          const wrapped = new Error(`桌面端中止失败：${error.message || '请在电脑端手动停止。'}`);
          wrapped.statusCode = error.statusCode || 502;
          throw wrapped;
        }
        const completedAt = new Date().toISOString();
        const payload = {
          type: 'chat-aborted',
          source: 'desktop-thread',
          projectId: body.projectId || undefined,
          sessionId,
          previousSessionId: previousSessionId || undefined,
          turnId: turnId || sessionId,
          completedAt,
          timestamp: completedAt
        };
        rememberTurn(payload.turnId, {
          projectId: payload.projectId,
          sessionId: payload.sessionId,
          previousSessionId: payload.previousSessionId,
          source: 'desktop-thread',
          status: 'aborted',
          label: '已中止',
          completedAt
        });
        broadcast(payload);
        return true;
      }
    }
    if (!turnId && !aborted) {
      return false;
    }

    const completedAt = new Date().toISOString();
    const payload = {
      type: 'chat-aborted',
      projectId: body.projectId || undefined,
      sessionId: sessionId || undefined,
      previousSessionId: previousSessionId || undefined,
      turnId: turnId || sessionId,
      completedAt,
      timestamp: completedAt
    };
    rememberTurn(payload.turnId, {
      projectId: payload.projectId,
      sessionId: payload.sessionId,
      previousSessionId: payload.previousSessionId,
      status: 'aborted',
      label: '已中止',
      completedAt
    });
    broadcast(payload);
    return true;
  }

  return {
    abortChat,
    getActiveDesktopIpcRuns: desktopTurnMonitor.getActiveRuns,
    getActiveImageRuns: chatImage.getActiveImageRuns,
    getTurn(turnId) {
      return chatQueue.getTurn(turnId);
    },
    loadRecentImagePrompts: chatImage.loadRecentImagePrompts,
    listQueue: chatQueue.listQueue,
    removeQueuedDraft: chatQueue.removeQueuedDraft,
    restoreQueuedDraft: chatQueue.restoreQueuedDraft,
    sendChat,
    sessionHasActiveWork,
    steerQueuedDraft
  };
}
