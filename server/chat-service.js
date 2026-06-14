/**
 * 组装聊天业务：桌面 IPC 优先投递、后台 Codex 兜底、队列、图片与自动标题等子能力。
 *
 * Keywords: chat-service, desktop-ipc, headless-fallback, codex-turn, queue
 *
 * Exports:
 * - createChatService — 创建可注入依赖的聊天服务实例。
 * - normalizeSelectedSkills — 再导出自 chat-request-prep。
 *
 * Inward（本模块依赖/组装的关键符号）: chat-queue、chat-delivery、chat-request-prep、chat-image-handler、interaction-requests、desktop-ipc、runtime-debug。
 *
 * Outward（谁在用/调用场景）: HTTP 聊天路由或上层服务装配。
 *
 * 不负责: Codex CLI 进程细节（由 codex-runner 等承担）。
 */
import {
  registerProjectlessThread as registerProjectlessThreadInCodexState
} from './codex-config.js';
import {
  notifyDesktopThreadListChanged as notifyDesktopThreadListChangedInCodexApp
} from './codex-app-server.js';
import {
  triggerDesktopRefreshForThread as triggerDesktopRefreshForThreadInCodexApp
} from './desktop-refresh.js';
import { registerMobileSession as registerMobileSessionInIndex } from './mobile-session-index.js';
import { createChatQueue } from './chat-queue.js';
import {
  readDesktopBridgeStatus,
  runQueuedHeadlessChatJob
} from './chat-delivery.js';
import {
  prepareChatRequest,
  projectlessThreadWorkingDirectory
} from './chat-request-prep.js';
import { buildCodexTurnInput } from './codex-native-images.js';
import { createChatImageHandler } from './chat-image-handler.js';
import { createChatAutoNamer } from './chat-auto-title.js';
import {
  compactActiveRuns,
  runtimeDebugLine
} from './runtime-debug.js';
import {
  compactDesktopFollowerThread,
  interruptDesktopFollowerTurn as interruptDesktopFollowerTurnInCodexApp,
  setDesktopFollowerCollaborationMode as setDesktopFollowerCollaborationModeInCodexApp,
  startDesktopFollowerTurn as startDesktopFollowerTurnInCodexApp,
  steerDesktopFollowerTurn as steerDesktopFollowerTurnInCodexApp
} from './desktop-ipc-client.js';
import { createInteractionBroker } from './interaction-requests.js';
import { createSyncEventPayload } from './sync/sync-events.js';

export { normalizeSelectedSkills } from './chat-request-prep.js';

const IMPLEMENT_PLAN_MESSAGE_RE = /^(?:implement\s+plan\.?|执行计划)$/iu;

function planImplementationHeadlessMessage({ codexMessage, visibleMessage, collaborationMode, planImplementation }) {
  const codexText = String(codexMessage || '').trim();
  const visibleText = String(visibleMessage || '').trim();
  const isPlanImplementation = collaborationMode?.mode === 'default' &&
    (IMPLEMENT_PLAN_MESSAGE_RE.test(codexText) || IMPLEMENT_PLAN_MESSAGE_RE.test(visibleText));
  if (!isPlanImplementation) {
    return codexMessage;
  }
  const planContent = String(planImplementation?.planContent || '').trim();
  return planContent ? `PLEASE IMPLEMENT THIS PLAN:\n${planContent}` : codexMessage;
}

export function createChatService({
  imagePromptState,
  defaultReasoningEffort = 'xhigh',
  uploadRoot = '',
  getProject,
  getSession,
  getCacheSnapshot,
  getDesktopBridgeStatus,
  listProjectSessions,
  refreshCodexCache,
  renameSession,
  broadcast,
  runCodexTurn,
  steerCodexTurn,
  abortCodexTurn,
  getActiveRuns,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession,
  compactCodexThread = compactDesktopFollowerThread,
  startDesktopFollowerTurn = startDesktopFollowerTurnInCodexApp,
  steerDesktopFollowerTurn = steerDesktopFollowerTurnInCodexApp,
  interruptDesktopFollowerTurn = interruptDesktopFollowerTurnInCodexApp,
  setDesktopFollowerCollaborationMode = setDesktopFollowerCollaborationModeInCodexApp,
  registerProjectlessThread = registerProjectlessThreadInCodexState,
  registerMobileSession = registerMobileSessionInIndex,
  rememberLiveSession = () => null,
  notifyDesktopThreadListChanged = notifyDesktopThreadListChangedInCodexApp,
  triggerDesktopRefreshForThread = triggerDesktopRefreshForThreadInCodexApp
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
  function sessionHasActiveWork(sessionId) {
    return chatQueue.sessionHasActiveWork(sessionId, [
      ...getActiveRuns(),
      ...chatImage.getActiveImageRuns()
    ]);
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

  function headlessDeliveryBridge(bridge) {
    return {
      ...(bridge || {}),
      connected: true,
      strict: false,
      mode: 'headless-local',
      reason: '桌面端 IPC 不可用或未接管当前线程，本次已改用后台 Codex 执行。',
      capabilities: {
        ...(bridge?.capabilities || {}),
        createThread: true,
        sendToOpenDesktopThread: false,
        headless: true,
        backgroundCodex: true
      }
    };
  }

  function desktopIpcUnavailableError(message = '桌面端 Codex 已连接，但当前线程没有可接管的桌面窗口。') {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
    return error;
  }

  async function sendViaDesktopIpc({
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
    model,
    reasoningEffort,
    permissionMode,
    collaborationMode
  }) {
    if (!selectedSessionId) {
      throw desktopIpcUnavailableError('桌面端 IPC 还不能从手机直接新建桌面线程。');
    }

    const input = buildCodexTurnInput({
      message: codexMessage,
      attachments,
      selectedSkills
    });
    const now = new Date().toISOString();
    const lastSession = getSession(selectedSessionId);
    const cwd = lastSession?.cwd || lastSession?.projectPath || project.path || null;
    const baseTurnStartParams = {
      input,
      cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: permissionMode === 'bypassPermissions'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', networkAccess: false },
      model: model || null,
      effort: reasoningEffort || null,
      collaborationMode: collaborationMode || null,
      attachments: []
    };

    let result;
    try {
      if (sendMode === 'steer') {
        if (collaborationMode) {
          await setDesktopFollowerCollaborationMode(selectedSessionId, collaborationMode, { timeoutMs: 2500 });
        }
        result = await steerDesktopFollowerTurn(selectedSessionId, {
          input,
          attachments: [],
          restoreMessage: {
            text: codexMessage,
            cwd,
            context: {
              workspaceRoots: project.path ? [project.path] : [],
              collaborationMode: collaborationMode || null
            },
            responsesapiClientMetadata: null
          }
        }, { timeoutMs: 2500 });
      } else {
        if (sendMode === 'interrupt') {
          await interruptDesktopFollowerTurn(selectedSessionId, { timeoutMs: 2500 });
        }
        if (collaborationMode) {
          await setDesktopFollowerCollaborationMode(selectedSessionId, collaborationMode, { timeoutMs: 2500 });
        }
        result = await startDesktopFollowerTurn(selectedSessionId, baseTurnStartParams, { timeoutMs: 2500 });
      }
    } catch (error) {
      if (error?.message === 'no-client-found' || error?.statusCode === 409) {
        throw desktopIpcUnavailableError();
      }
      throw error;
    }

    const appTurnId = result?.result?.turn?.id || result?.turn?.id || turnId;
    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: selectedSessionId,
      previousSessionId: selectedSessionId,
      draftSessionId,
      source: 'desktop-ipc',
      status: 'running',
      label: sendMode === 'steer' ? '已发送到当前任务' : '已交给电脑端处理',
      startedAt: now
    });
    broadcast(createSyncEventPayload('message.user', {
      source: 'desktop-ipc',
      sessionId: selectedSessionId,
      projectId: project.id,
      turnId,
      clientTurnId: turnId,
      itemId: `local-${Date.now()}`,
      message: {
        id: `local-${Date.now()}`,
        role: 'user',
        content: visibleMessage,
        turnId,
        deliveryState: 'confirmed',
        timestamp: now
      }
    }));
    broadcast(createSyncEventPayload('turn.running', {
      source: 'desktop-ipc',
      projectId: project.id,
      sessionId: selectedSessionId,
      turnId,
      kind: 'turn',
      status: 'running',
      label: sendMode === 'steer' ? '已发送到当前任务' : '已交给电脑端处理',
      detail: '',
      timestamp: new Date().toISOString()
    }, {
      suppressedInChat: true
    }));
    return {
      accepted: true,
      queued: false,
      sessionId: selectedSessionId,
      draftSessionId,
      turnId: appTurnId,
      clientTurnId: turnId,
      delivery: sendMode === 'steer' ? 'steered' : (sendMode === 'interrupt' ? 'interrupted-started' : 'started'),
      desktopBridge: bridge
    };
  }

  function emitJobEvent(job, payload) {
    const enriched = payload?.type === 'sync-event'
      ? {
        ...payload,
        event: {
          ...payload.event,
          projectId: payload.event?.projectId || job.project.id
        }
      }
      : payload?.type === 'app-server-message'
        ? {
          ...payload,
          context: {
            ...(payload.context || {}),
            projectId: payload.context?.projectId || job.project.id
          }
        }
        : { projectId: job.project.id, ...payload };
    rememberTurnEvent(enriched);
    broadcast(enriched);
  }

  const interactionBroker = createInteractionBroker({
    broadcast: (payload) => broadcast(payload)
  });

  function requestCodexInteraction(job, appMessage, context = {}) {
    return interactionBroker.requestFromAppServer(appMessage, {
      projectId: job.project.id,
      sessionId: context.sessionId || job.selectedSessionId || job.draftSessionId || '',
      turnId: context.turnId || job.turnId || ''
    });
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
        source: 'headless-local',
        status: 'queued',
        label: '已加入队列',
        sessionId: sessionId || null
      });
      broadcast(createSyncEventPayload('turn.queued', {
        projectId: job.project.id,
        sessionId,
        turnId: job.turnId,
        source: 'headless-local',
        kind: 'turn',
        status: 'queued',
        label: '已加入队列',
        detail: '',
        timestamp: new Date().toISOString()
      }));
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
      notifyDesktopThreadListChanged,
      triggerDesktopRefreshForThread,
      requestCodexInteraction,
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
    let selectedSessionId = prepared.selectedSessionId;
    let conversationSessionId = prepared.conversationSessionId;
    const bridge = await readDesktopBridgeStatus(getDesktopBridgeStatus);

    const imagePrompt = chatImage.resolveImagePrompt({
      enabled: useLegacyImageGenerator(),
      projectId: project.id,
      displayMessage,
      attachments
    });
    const queueKey = resolveConversationKey(selectedSessionId, draftSessionId, requestedSessionId);
    const existingConversationState = getConversationQueue(queueKey);
    if (!selectedSessionId && draftSessionId && existingConversationState.sessionId) {
      selectedSessionId = existingConversationState.sessionId;
      conversationSessionId = selectedSessionId;
    }
    const shouldHoldInLocalQueue =
      sendMode === 'queue' &&
      conversationSessionId &&
      sessionHasActiveWork(conversationSessionId);

    runtimeDebugLine('sendChat.enter', {
      remoteAddress,
      sendMode,
      imagePrompt: Boolean(imagePrompt),
      bridgeMode: bridge?.mode,
      bridgeConnected: bridge?.connected,
      selectedSessionId,
      draftSessionId,
      conversationSessionId,
      turnId,
      queueKey,
      shouldHoldInLocalQueue,
      headlessRuns: compactActiveRuns(getActiveRuns()),
      imageRuns: compactActiveRuns(chatImage.getActiveImageRuns())
    });

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
        permissionMode: body.permissionMode || 'default',
        collaborationMode: collaborationMode || null
      }, { forceQueued: true, autoStart: false });
      runtimeDebugLine('sendChat.exit', { branch: 'hold-local-queue', delivery: 'queued', turnId });
      return {
        accepted: true,
        queued,
        sessionId: selectedSessionId,
        draftSessionId,
        turnId,
        delivery: 'queued',
        desktopBridge: headlessDeliveryBridge(bridge)
      };
    }

    if (bridge?.mode === 'desktop-ipc' && bridge?.connected && bridge?.capabilities?.sendToOpenDesktopThread && !imagePrompt) {
      if (selectedSessionId) {
        try {
          runtimeDebugLine('sendChat.branch', {
            branch: 'desktop-ipc',
            bridgeMode: bridge?.mode,
            selectedSessionId,
            sendMode
          });
          return await sendViaDesktopIpc({
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
            permissionMode: body.permissionMode || 'default',
            collaborationMode: collaborationMode || null
          });
        } catch (error) {
          runtimeDebugLine('sendChat.branch', {
            branch: 'desktop-ipc-fallback',
            selectedSessionId,
            reason: error?.code || error?.message || 'desktop-ipc-failed'
          });
          console.log('[desktop-ipc] send unavailable, using headless fallback:', error.message);
        }
      } else {
        runtimeDebugLine('sendChat.branch', {
          branch: 'desktop-ipc-draft-fallback',
          bridgeMode: bridge?.mode,
          draftSessionId
        });
      }
    }

    if (sendMode === 'steer') {
      if (!selectedSessionId) {
        const error = new Error('新对话还没有桌面端线程，不能发送到当前任务。');
        error.statusCode = 409;
        throw error;
      }
      runtimeDebugLine('sendChat.branch', {
        branch: 'steer-headless',
        bridgeMode: bridge?.mode,
        selectedSessionId
      });
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
      broadcast(createSyncEventPayload('message.user', {
        sessionId: result.sessionId || selectedSessionId,
        projectId: project.id,
        turnId: result.turnId || turnId,
        clientTurnId: turnId,
        itemId: `local-${Date.now()}`,
        message: {
          id: `local-${Date.now()}`,
          role: 'user',
          content: visibleMessage,
          turnId: result.turnId || turnId,
          deliveryState: 'confirmed',
          timestamp: new Date().toISOString()
        }
      }));
      broadcast(createSyncEventPayload('turn.running', {
        projectId: project.id,
        sessionId: result.sessionId || selectedSessionId,
        turnId,
        kind: 'turn',
        status: 'running',
        label: '已发送到当前任务',
        detail: '',
        timestamp: new Date().toISOString()
      }));
      runtimeDebugLine('sendChat.exit', {
        branch: 'steer',
        delivery: 'steered',
        sessionId: result.sessionId || selectedSessionId,
        turnId: result.turnId || turnId
      });
      return {
        accepted: true,
        queued: false,
        delivery: 'steered',
        sessionId: result.sessionId || selectedSessionId,
        draftSessionId,
        turnId: result.turnId || turnId,
        clientTurnId: turnId,
        desktopBridge: headlessDeliveryBridge(bridge)
      };
    }

    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: conversationSessionId,
      previousSessionId: draftSessionId || selectedSessionId || null,
      draftSessionId,
      source: 'headless-local',
      status: 'accepted',
      label: '正在思考',
      hadAssistantText: false,
      startedAt: new Date().toISOString()
    });

    broadcast(createSyncEventPayload('message.user', {
      sessionId: conversationSessionId,
      projectId: project.id,
      turnId,
      clientTurnId: turnId,
      itemId: `local-${Date.now()}`,
      message: {
        id: `local-${Date.now()}`,
        role: 'user',
        content: visibleMessage,
        turnId,
        deliveryState: 'confirmed',
        timestamp: new Date().toISOString()
      }
    }));
    const headlessCodexMessage = planImplementationHeadlessMessage({
      codexMessage,
      visibleMessage,
      collaborationMode,
      planImplementation: body.planImplementation
    });

    if (imagePrompt) {
      runtimeDebugLine('sendChat.branch', { branch: 'image-chat' });
      const imageResult = await chatImage.startImageChat({
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
      runtimeDebugLine('sendChat.exit', {
        branch: 'image-chat',
        delivery: imageResult?.delivery || 'image',
        sessionId: imageResult?.sessionId ?? selectedSessionId ?? conversationSessionId,
        turnId: imageResult?.turnId ?? turnId
      });
      return imageResult;
    }

    runtimeDebugLine('sendChat.branch', {
      branch: 'headless',
      bridgeMode: bridge?.mode,
      sendMode,
      interrupt: sendMode === 'interrupt'
    });
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
      codexMessage: headlessCodexMessage,
      displayMessage,
      visibleMessage,
      attachments,
      selectedSkills,
      fileMentions,
      model: modelForTurn,
      reasoningEffort: reasoningEffortForTurn,
      serviceTier: serviceTierForTurn,
      permissionMode: body.permissionMode || 'default',
      collaborationMode: collaborationMode || null
    });

    const delivery =
      sendMode === 'interrupt' ? 'interrupted-started' : (queued ? 'queued' : 'started');
    runtimeDebugLine('sendChat.exit', {
      branch: 'headless',
      delivery,
      sessionId: selectedSessionId || draftSessionId || conversationSessionId,
      turnId,
      queued
    });
    return {
      accepted: true,
      queued,
      sessionId: selectedSessionId,
      draftSessionId,
      turnId,
      delivery,
      desktopBridge: headlessDeliveryBridge(bridge)
    };
  }

  async function abortChat(body = {}, { remoteAddress = '' } = {}) {
    const turnId = String(body.turnId || '').trim();
    const sessionId = String(body.sessionId || '').trim();
    const previousSessionId = String(body.previousSessionId || '').trim();
    console.log(`[chat] abort request remote=${remoteAddress} turn=${turnId} session=${sessionId}`);
    interactionBroker.cancelInteractionsForRun({ turnId, sessionId });
    runtimeDebugLine('abortChat.enter', {
      remoteAddress,
      turnId,
      sessionId,
      previousSessionId,
      headlessRuns: compactActiveRuns(getActiveRuns())
    });
    const localRun = activeLocalRunForAbort({ turnId, sessionId, previousSessionId });
    if (localRun) {
      const aborted = abortCodexTurn(localRun.turnId || turnId || sessionId);
      const completedAt = new Date().toISOString();
      const payload = createSyncEventPayload('turn.aborted', {
        source: 'headless-local',
        projectId: body.projectId || undefined,
        sessionId: sessionId || localRun.sessionId || undefined,
        previousSessionId: previousSessionId || localRun.previousSessionId || undefined,
        turnId: turnId || localRun.turnId || sessionId,
        completedAt,
        timestamp: completedAt
      });
      rememberTurn(payload.event.turnId, {
        projectId: payload.event.projectId,
        sessionId: payload.event.sessionId,
        previousSessionId: payload.event.previousSessionId,
        source: 'headless-local',
        status: 'aborted',
        label: '已中止',
        completedAt
      });
      broadcast(payload);
      runtimeDebugLine('abortChat.exit', { branch: 'headless-local', aborted: Boolean(aborted || turnId || sessionId) });
      return Boolean(aborted || turnId || sessionId);
    }

    const activeTurn = chatQueue.findActiveTurnForSession(sessionId, { source: 'headless-local' });
    if (activeTurn) {
      const abortIdentifier = activeTurn.turnId || turnId || sessionId;
      const aborted = abortCodexTurn(abortIdentifier);
      const completedAt = new Date().toISOString();
      const payload = createSyncEventPayload('turn.aborted', {
        source: 'headless-local',
        projectId: body.projectId || activeTurn.projectId || undefined,
        sessionId: sessionId || activeTurn.sessionId || undefined,
        previousSessionId: previousSessionId || activeTurn.previousSessionId || undefined,
        turnId: abortIdentifier,
        completedAt,
        timestamp: completedAt
      });
      rememberTurn(payload.event.turnId, {
        projectId: payload.event.projectId,
        sessionId: payload.event.sessionId,
        previousSessionId: payload.event.previousSessionId,
        source: 'headless-local',
        status: 'aborted',
        label: '已中止',
        completedAt
      });
      broadcast(payload);
      runtimeDebugLine('abortChat.exit', { branch: 'headless-recent-turn', aborted: Boolean(aborted || abortIdentifier) });
      return true;
    }

    const aborted = abortCodexTurn(turnId || sessionId);
    if (!turnId && !aborted) {
      runtimeDebugLine('abortChat.exit', { branch: 'noop', aborted: false });
      return false;
    }

    const completedAt = new Date().toISOString();
    const payload = createSyncEventPayload('turn.aborted', {
      projectId: body.projectId || undefined,
      sessionId: sessionId || undefined,
      previousSessionId: previousSessionId || undefined,
      turnId: turnId || sessionId,
      completedAt,
      timestamp: completedAt
    });
    rememberTurn(payload.event.turnId, {
      projectId: payload.event.projectId,
      sessionId: payload.event.sessionId,
      previousSessionId: payload.event.previousSessionId,
      status: 'aborted',
      label: '已中止',
      completedAt
    });
    broadcast(payload);
    runtimeDebugLine('abortChat.exit', { branch: 'generic-broadcast', aborted: true });
    return true;
  }

  async function compactChat(body = {}, { remoteAddress = '' } = {}) {
    const project = getProject(body.projectId);
    if (!project) {
      const error = new Error('Project not found');
      error.statusCode = 404;
      throw error;
    }
    const sessionId = String(body.sessionId || body.conversationId || '').trim();
    if (!sessionId || sessionId.startsWith('draft-')) {
      const error = new Error('请选择已有桌面线程后再压缩上下文。');
      error.statusCode = 409;
      throw error;
    }
    runtimeDebugLine('compactChat.enter', {
      remoteAddress,
      projectId: project.id,
      sessionId
    });
    const messageId = String(body.clientActionId || '').trim() || `manual-context-compaction-${sessionId}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    broadcast(createSyncEventPayload('activity.updated', {
      projectId: project.id,
      sessionId,
      messageId,
      kind: 'context_compaction',
      label: '正在压缩上下文',
      status: 'running',
      detail: '',
      startedAt,
      timestamp: startedAt
    }, {
      activity: {
        kind: 'context_compaction',
        label: '正在压缩上下文',
        status: 'running',
        detail: ''
      }
    }));
    let result;
    try {
      result = await compactCodexThread(sessionId, { timeoutMs: 30_000 });
    } catch (error) {
      const failedAt = new Date().toISOString();
      broadcast(createSyncEventPayload('activity.failed', {
        projectId: project.id,
        sessionId,
        messageId,
        kind: 'context_compaction',
        label: '上下文压缩失败',
        status: 'failed',
        detail: error.message || '桌面端没有完成上下文压缩。',
        startedAt,
        completedAt: failedAt,
        timestamp: failedAt
      }, {
        activity: {
          kind: 'context_compaction',
          label: '上下文压缩失败',
          status: 'failed',
          detail: error.message || '桌面端没有完成上下文压缩。'
        }
      }));
      throw error;
    }
    const timestamp = new Date().toISOString();
    broadcast(createSyncEventPayload('activity.completed', {
      projectId: project.id,
      sessionId,
      messageId,
      kind: 'context_compaction',
      label: '上下文已压缩',
      status: 'completed',
      detail: '',
      startedAt,
      completedAt: timestamp,
      timestamp
    }, {
      activity: {
        kind: 'context_compaction',
        label: '上下文已压缩',
        status: 'completed',
        detail: ''
      }
    }));
    broadcast(createSyncEventPayload('context.updated', {
      projectId: project.id,
      sessionId,
      autoCompact: {
        detected: true,
        status: 'detected',
        lastCompactedAt: timestamp,
        reason: '手动压缩上下文'
      },
      updatedAt: timestamp,
      timestamp
    }, {
      context: {
        autoCompact: {
          detected: true,
          status: 'detected',
          lastCompactedAt: timestamp,
          reason: '手动压缩上下文'
        },
        updatedAt: timestamp
      }
    }));
    runtimeDebugLine('compactChat.exit', {
      projectId: project.id,
      sessionId,
      result: Boolean(result)
    });
    return { accepted: true, sessionId, result: result || null };
  }

  return {
    abortChat,
    compactChat,
    getActiveImageRuns: chatImage.getActiveImageRuns,
    getTurn(turnId) {
      return chatQueue.getTurn(turnId);
    },
    listPendingInteractions: interactionBroker.listPendingInteractions,
    respondInteraction: interactionBroker.respondInteraction,
    cancelInteraction: interactionBroker.cancelInteraction,
    loadRecentImagePrompts: chatImage.loadRecentImagePrompts,
    listQueue: chatQueue.listQueue,
    removeQueuedDraft: chatQueue.removeQueuedDraft,
    restoreQueuedDraft: chatQueue.restoreQueuedDraft,
    sendChat,
    sessionHasActiveWork,
    steerQueuedDraft
  };
}
