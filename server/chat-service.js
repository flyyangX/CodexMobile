import crypto from 'node:crypto';
import { buildCodexTurnInput } from './codex-native-images.js';
import { registerProjectlessThread as registerProjectlessThreadInCodexState } from './codex-config.js';
import { registerMobileSession as registerMobileSessionInIndex } from './mobile-session-index.js';
import { createImagePromptStore } from './chat/image-prompt-store.js';
import { buildChatMessageParts } from './chat/message-builders.js';
import { projectlessThreadWorkingDirectory } from './chat/projectless-workspace.js';
import { createQueueService } from './chat/queue-service.js';
import { createTurnRegistry } from './chat/turn-registry.js';

const MAX_RECENT_TURNS = 80;

export { normalizeSelectedSkills } from './chat/message-builders.js';

export function createChatService({
  imagePromptState,
  defaultReasoningEffort = 'xhigh',
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
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  abortCodexTurn,
  getActiveRuns,
  runImageTurn,
  isImageRequest,
  useLegacyImageGenerator,
  maybeAutoNameSession,
  registerProjectlessThread = registerProjectlessThreadInCodexState,
  registerMobileSession = registerMobileSessionInIndex
}) {
  const turnRegistry = createTurnRegistry({ maxRecentTurns: MAX_RECENT_TURNS });
  const { rememberTurn, rememberTurnEvent, getTurn } = turnRegistry;
  const activeImageRuns = new Map();
  const queueService = createQueueService();
  const imagePromptStore = createImagePromptStore({
    statePath: imagePromptState,
    isImageRequest,
    listProjectSessions
  });

  function getActiveImageRuns() {
    return [...activeImageRuns.values()].map((run) => ({
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId,
      startedAt: run.startedAt,
      status: run.status,
      turnId: run.turnId,
      kind: 'image_generation_call',
      label: run.label
    }));
  }

  function payloadReferencesSession(payload, sessionId) {
    return [
      payload?.sessionId,
      payload?.previousSessionId,
      payload?.draftSessionId,
      payload?.selectedSessionId
    ].some((value) => value && value === sessionId);
  }

  function sessionHasActiveWork(sessionId) {
    if (!sessionId) {
      return false;
    }
    const activeCodexRuns = [...getActiveRuns(), ...getActiveImageRuns()];
    if (activeCodexRuns.some((run) => payloadReferencesSession(run, sessionId))) {
      return true;
    }

    for (const turn of turnRegistry.values()) {
      if (
        (turn.status === 'accepted' || turn.status === 'queued' || turn.status === 'running') &&
        payloadReferencesSession(turn, sessionId)
      ) {
        return true;
      }
    }

    for (const state of queueService.queueStates()) {
      if (state.running && state.sessionId === sessionId) {
        return true;
      }
      if (state.jobs.some((job) => payloadReferencesSession(job, sessionId))) {
        return true;
      }
    }

    return false;
  }

  function emitJobEvent(job, payload) {
    const enriched = { projectId: job.project.id, ...payload };
    rememberTurnEvent(enriched);
    broadcast(enriched);
  }

  async function autoNameCompletedSession({ sessionId, turnId, userMessage }) {
    if (!sessionId || !turnId) {
      return;
    }
    const turn = getTurn(turnId) || {};
    const assistantMessage = turn.assistantPreview || '';
    if (!String(userMessage || assistantMessage || '').trim()) {
      return;
    }

    await refreshCodexCache();
    const session = getSession(sessionId);
    if (!session || session.titleLocked) {
      return;
    }

    const renamed = await maybeAutoNameSession({
      session,
      userMessage,
      assistantMessage,
      renameSessionImpl: renameSession
    });
    if (renamed) {
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    }
  }

  function scheduleAutoNameCompletedSession(payload) {
    autoNameCompletedSession(payload).catch((error) => {
      console.warn('[title] auto naming failed:', error.message);
    });
  }

  function listQueue(query = {}) {
    return queueService.listQueue(query);
  }

  function removeQueuedDraft(query = {}) {
    return queueService.removeQueuedDraft(query);
  }

  function restoreQueuedDraft(query = {}) {
    return queueService.restoreQueuedDraft(query);
  }

  async function steerQueuedDraft(query = {}) {
    const draft = removeQueuedDraft(query);
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
      sendMode: 'steer'
    });
  }

  function enqueueChatJob(job, { forceQueued = false, autoStart = true } = {}) {
    const { queued, sessionId } = queueService.addJob(job, { forceQueued });

    if (queued) {
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
    const state = queueService.getConversationQueue(queueKey);
    if (state.running) {
      return;
    }

    const job = state.jobs.shift();
    if (!job) {
      return;
    }

    state.running = true;
    const sessionId = state.sessionId || job.selectedSessionId;
    const metadataUpdates = [];

    function rememberCreatedProjectlessThread(payload) {
      if (!job.project?.projectless || !payload?.sessionId || !job.draftSessionId) {
        return;
      }
      const updatedAt = payload.startedAt || new Date().toISOString();
      metadataUpdates.push(
        Promise.all([
          registerProjectlessThread(payload.sessionId, job.project.path),
          registerMobileSession({
            id: payload.sessionId,
            projectPath: job.executionProjectPath || job.project.path,
            projectless: true,
            title: job.displayMessage,
            summary: job.displayMessage,
            updatedAt,
            messages: [
              {
                id: `${payload.sessionId}-user-${job.turnId}`,
                role: 'user',
                content: job.displayMessage,
                timestamp: updatedAt
              }
            ]
          })
        ]).catch((error) => {
          console.warn('[sessions] Failed to register projectless thread:', error.message);
        })
      );
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
        permissionMode: job.permissionMode,
        turnId: job.turnId
      },
      (payload) => {
        if (payload.sessionId) {
        state.sessionId = payload.sessionId;
          queueService.rememberConversationAlias(queueKey, payload.sessionId);
        }
        if (payload.previousSessionId) {
          queueService.rememberConversationAlias(queueKey, payload.previousSessionId);
        }
        if (payload.type === 'thread-started') {
          rememberCreatedProjectlessThread(payload);
        }
        emitJobEvent(job, payload);
      }
    ).then(async (finalSessionId) => {
      if (finalSessionId) {
        state.sessionId = finalSessionId;
        queueService.rememberConversationAlias(queueKey, finalSessionId);
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
    }).finally(async () => {
      try {
        if (metadataUpdates.length) {
          await Promise.allSettled(metadataUpdates);
        }
        const snapshot = await refreshCodexCache();
        broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      } catch (error) {
        console.warn('[sync] Failed to refresh after chat:', error.message);
      } finally {
        state.running = false;
        if (state.jobs.length) {
          setTimeout(() => runNextQueuedChat(queueKey), 0);
        }
      }
    });
  }

  async function assertDesktopBridgeAvailable() {
    const bridge = getDesktopBridgeStatus ? await getDesktopBridgeStatus({ force: true }) : null;
    if (bridge && !bridge.connected) {
      const error = new Error(bridge.reason || '桌面端 Codex 未连接，无法发送消息。');
      error.statusCode = 503;
      error.code = 'CODEXMOBILE_DESKTOP_BRIDGE_UNAVAILABLE';
      throw error;
    }
    return bridge;
  }

  function desktopIpcUnavailableError(message = '桌面端 Codex 已连接，但当前线程没有可接管的桌面窗口。') {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
    return error;
  }

  function desktopCreateThreadUnavailableError() {
    const error = new Error('当前桌面端 Codex 只开放了接管已有对话，不能从手机直接新建桌面端对话。请先在桌面端新建或打开一个对话，再从手机继续发送。');
    error.statusCode = 409;
    error.code = 'CODEXMOBILE_DESKTOP_CREATE_THREAD_UNAVAILABLE';
    return error;
  }

  function desktopIpcCanUseBackgroundFallback(bridge) {
    return Boolean(
      bridge?.capabilities?.backgroundCodex ||
      bridge?.capabilities?.headless ||
      bridge?.capabilities?.createThreadViaBackground
    );
  }

  function backgroundFallbackBridge(bridge, reason = '桌面端当前没有接管这个线程，已改用后台 Codex 执行。') {
    return {
      ...(bridge || {}),
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason,
      capabilities: {
        ...(bridge?.capabilities || {}),
        read: true,
        sendToOpenDesktopThread: false,
        createThread: true,
        headless: true,
        backgroundCodex: true
      }
    };
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
    permissionMode
  }) {
    if (!selectedSessionId) {
      throw desktopCreateThreadUnavailableError();
    }

    const input = buildCodexTurnInput({
      message: codexMessage,
      attachments,
      selectedSkills
    });
    const now = new Date().toISOString();
    const lastSession = getSession(selectedSessionId);
    const baseTurnStartParams = {
      input,
      cwd: lastSession?.cwd || project.path || null,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: permissionMode === 'bypassPermissions'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', networkAccess: false },
      model: model || null,
      effort: reasoningEffort || null,
      attachments: []
    };

    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: selectedSessionId,
      previousSessionId: selectedSessionId,
      draftSessionId,
      status: 'running',
      label: sendMode === 'steer' ? '已发送到当前任务' : '已交给桌面端处理',
      startedAt: now
    });
    broadcast({
      type: 'user-message',
      sessionId: selectedSessionId,
      projectId: project.id,
      message: {
        id: `local-${Date.now()}`,
        role: 'user',
        content: visibleMessage,
        timestamp: now
      }
    });

    let result;
    try {
      if (sendMode === 'steer') {
        result = await steerDesktopFollowerTurn(selectedSessionId, {
          input,
          attachments: [],
          restoreMessage: {
            text: codexMessage,
            cwd: lastSession?.cwd || project.path || null,
            context: {
              workspaceRoots: project.path ? [project.path] : [],
              collaborationMode: null
            },
            responsesapiClientMetadata: null
          }
        });
      } else {
        if (sendMode === 'interrupt') {
          await interruptDesktopFollowerTurn(selectedSessionId);
        }
        result = await startDesktopFollowerTurn(selectedSessionId, baseTurnStartParams);
      }
    } catch (error) {
      if (error?.message === 'no-client-found' || error?.statusCode === 409) {
        throw desktopIpcUnavailableError();
      }
      throw error;
    }

    const appTurnId = result?.result?.turn?.id || result?.turn?.id || turnId;
    broadcast({
      type: 'status-update',
      projectId: project.id,
      sessionId: selectedSessionId,
      turnId,
      kind: 'turn',
      status: 'running',
      label: sendMode === 'steer' ? '已发送到当前任务' : '已交给桌面端处理',
      detail: '',
      timestamp: new Date().toISOString()
    });
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
    const {
      attachments,
      codexMessage,
      displayMessage,
      fileMentions,
      message,
      selectedSkills,
      visibleMessage
    } = buildChatMessageParts(body, config);
    if (!message && !attachments.length) {
      const error = new Error('message or attachments are required');
      error.statusCode = 400;
      throw error;
    }
    let bridge = await assertDesktopBridgeAvailable();

    const requestedSessionId = String(body.sessionId || '').trim();
    const isDraftSession = requestedSessionId.startsWith('draft-');
    const session = requestedSessionId && !isDraftSession ? getSession(requestedSessionId) : null;
    const draftSessionId = String(body.draftSessionId || '').trim() || null;
    const selectedSessionId = session && !session.mobileOnly
      ? session.id
      : (requestedSessionId && !isDraftSession ? requestedSessionId : null);
    const turnId = String(body.clientTurnId || '').trim() || crypto.randomUUID();
    const sendMode = String(body.sendMode || body.mode || 'start').trim();
    const legacyImageRoute = useLegacyImageGenerator();
    const imagePrompt = legacyImageRoute
      ? (isImageRequest(displayMessage, attachments)
        ? displayMessage
        : imagePromptStore.resolveContinuation(project.id, displayMessage))
      : null;
    const conversationSessionId = selectedSessionId || draftSessionId || null;
    const queueKey = queueService.resolveConversationKey(selectedSessionId, draftSessionId, requestedSessionId);
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
        attachments,
        selectedSkills,
        fileMentions,
        model: session?.model || body.model || config.model || 'gpt-5.5',
        reasoningEffort: body.reasoningEffort || defaultReasoningEffort,
        permissionMode: body.permissionMode || 'bypassPermissions'
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
            model: session?.model || body.model || config.model || 'gpt-5.5',
            reasoningEffort: body.reasoningEffort || defaultReasoningEffort,
            permissionMode: body.permissionMode || 'bypassPermissions'
          });
        } catch (error) {
          if (error?.code !== 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE' || !desktopIpcCanUseBackgroundFallback(bridge)) {
            throw error;
          }
          bridge = backgroundFallbackBridge(bridge);
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
      imagePromptStore.remember(project.id, imagePrompt);
      const imageSessionId = selectedSessionId || `mobile-image-${crypto.randomUUID()}`;
      const previousSessionId = imageSessionId === conversationSessionId ? draftSessionId : conversationSessionId;
      const imageLabel = attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片';
      activeImageRuns.set(turnId, {
        turnId,
        sessionId: imageSessionId,
        previousSessionId,
        startedAt: new Date().toISOString(),
        status: 'running',
        label: imageLabel
      });
      console.log(`[chat] accepted image turn=${turnId} session=${imageSessionId} project=${project.name}`);
      rememberTurn(turnId, {
        projectId: project.id,
        projectPath: project.path,
        sessionId: imageSessionId,
        previousSessionId,
        status: 'running',
        kind: 'image_generation_call',
        label: imageLabel
      });
      runImageTurn(
        {
          sessionId: imageSessionId,
          previousSessionId,
          projectPath: project.path,
          projectless: project.projectless,
          message: imagePrompt,
          attachments,
          config,
          turnId,
          persistMobileSession: true
        },
        (payload) => {
          if (payload.turnId && activeImageRuns.has(payload.turnId)) {
            const existing = activeImageRuns.get(payload.turnId);
            if (payload.type === 'status-update' || payload.type === 'activity-update') {
              activeImageRuns.set(payload.turnId, {
                ...existing,
                sessionId: payload.sessionId || existing.sessionId,
                previousSessionId: payload.previousSessionId || existing.previousSessionId,
                status: payload.status || existing.status,
                label: payload.label || existing.label
              });
            }
          }
          emitJobEvent({ project }, payload);
        }
      ).then(async (finalSessionId) => {
        rememberTurn(turnId, {
          projectId: project.id,
          sessionId: finalSessionId,
          previousSessionId
        });
        try {
          const snapshot = await refreshCodexCache();
          broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
        } catch (error) {
          console.warn('[sync] Failed to refresh after image chat:', error.message);
        }
      }).catch((error) => {
        const errorMessage = error?.message || '图片生成失败';
        activeImageRuns.delete(turnId);
        rememberTurn(turnId, {
          projectId: project.id,
          sessionId: imageSessionId,
          previousSessionId,
          status: 'failed',
          error: errorMessage,
          label: '图片生成失败'
        });
        emitJobEvent({ project }, {
          type: 'chat-error',
          sessionId: imageSessionId,
          previousSessionId,
          turnId,
          error: errorMessage
        });
      }).finally(() => {
        activeImageRuns.delete(turnId);
      });
      return {
        accepted: true,
        queued: false,
        sessionId: imageSessionId,
        draftSessionId,
        turnId,
        mode: 'image',
        delivery: 'started',
        desktopBridge: bridge
      };
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
      attachments,
      selectedSkills,
      fileMentions,
      model: session?.model || body.model || config.model || 'gpt-5.5',
      reasoningEffort: body.reasoningEffort || defaultReasoningEffort,
      permissionMode: body.permissionMode || 'bypassPermissions'
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

  function abortChat(body, { remoteAddress = '' } = {}) {
    console.log(`[chat] abort request remote=${remoteAddress} turn=${body.turnId || ''} session=${body.sessionId || ''}`);
    return abortCodexTurn(body.turnId || body.sessionId);
  }

  return {
    abortChat,
    getActiveImageRuns,
    getTurn,
    loadRecentImagePrompts: imagePromptStore.load,
    listQueue,
    removeQueuedDraft,
    restoreQueuedDraft,
    sendChat,
    sessionHasActiveWork,
    steerQueuedDraft
  };
}
