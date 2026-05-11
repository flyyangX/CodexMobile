import { buildCodexTurnInput } from './codex-native-images.js';
import { desktopTurnPermissionsForPermissionMode } from './permission-policy.js';

export async function assertDesktopBridgeAvailable(getDesktopBridgeStatus) {
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

function isDesktopFollowerPreflightTimeout(error) {
  if (error?.code !== 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT') {
    return false;
  }
  return /thread-follower-set-(?:model-and-reasoning|collaboration-mode)\b/.test(String(error.message || ''));
}

function isDesktopThreadOwnerUnavailable(error) {
  return (
    error?.message === 'no-client-found' ||
    error?.statusCode === 409 ||
    isDesktopFollowerPreflightTimeout(error)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelays(value) {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0)
    : [];
}

export function desktopIpcCanUseBackgroundFallback(bridge) {
  return Boolean(
    bridge?.capabilities?.backgroundCodex ||
    bridge?.capabilities?.headless ||
    bridge?.capabilities?.createThreadViaBackground
  );
}

export function backgroundFallbackBridge(bridge, reason = '桌面端当前没有接管这个线程，已改用后台 Codex 执行。') {
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

function userMessageMetadataForSendMode(sendMode = 'start') {
  return sendMode === 'steer'
    ? {
      guided: true,
      guideLabel: '已引导对话',
      kind: 'guided_user'
    }
    : {};
}

function desktopCollaborationModeForTurn(collaborationMode, { model = null, reasoningEffort = null } = {}) {
  if (collaborationMode?.mode) {
    return collaborationMode;
  }
  return {
    mode: 'default',
    settings: {
      model: String(model || '').trim(),
      reasoning_effort: reasoningEffort || null,
      developer_instructions: null
    }
  };
}

async function syncDesktopFollowerCollaborationMode({
  selectedSessionId,
  collaborationMode,
  setDesktopFollowerCollaborationMode
}) {
  if (!setDesktopFollowerCollaborationMode) {
    return;
  }
  await setDesktopFollowerCollaborationMode(selectedSessionId, collaborationMode);
}

export async function sendViaDesktopIpc({
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
  serviceTier,
  permissionMode,
  collaborationMode,
  getSession,
  rememberTurn,
  broadcast,
  setDesktopFollowerModelAndReasoning,
  setDesktopFollowerCollaborationMode,
  steerDesktopFollowerTurn,
  startDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  desktopOwnerRetryDelays = [],
  sleep = wait
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
  const cwd = lastSession?.cwd || project.path || null;
  const desktopPermissions = desktopTurnPermissionsForPermissionMode(permissionMode, {
    dangerFullAccessEnabled: true,
    writableRoots: cwd ? [cwd] : [],
    networkAccess: true
  });
  const desktopCollaborationMode = desktopCollaborationModeForTurn(collaborationMode, {
    model,
    reasoningEffort
  });
  const baseTurnStartParams = {
    input,
    cwd,
    ...desktopPermissions,
    model: model || null,
    effort: reasoningEffort || null,
    serviceTier: serviceTier || null,
    collaborationMode: desktopCollaborationMode,
    attachments: []
  };
  console.info(
    `[desktop-ipc] start-turn prepare session=${selectedSessionId} mode=${permissionMode || 'default'} approval=${baseTurnStartParams.approvalPolicy || ''} reviewer=${baseTurnStartParams.approvalsReviewer || ''} sandbox=${JSON.stringify(baseTurnStartParams.sandboxPolicy || null)}`
  );

  async function attemptDesktopFollowerTurn() {
    if (sendMode === 'steer') {
      if (setDesktopFollowerModelAndReasoning) {
        await setDesktopFollowerModelAndReasoning(selectedSessionId, model || null, reasoningEffort || null);
      }
      await syncDesktopFollowerCollaborationMode({
        selectedSessionId,
        collaborationMode: desktopCollaborationMode,
        setDesktopFollowerCollaborationMode
      });
      result = await steerDesktopFollowerTurn(selectedSessionId, {
        input,
        attachments: [],
        restoreMessage: {
          text: codexMessage,
          cwd,
          context: {
            workspaceRoots: project.path ? [project.path] : [],
            collaborationMode: desktopCollaborationMode
          },
          responsesapiClientMetadata: null
        }
      });
    } else {
      if (sendMode === 'interrupt') {
        await interruptDesktopFollowerTurn(selectedSessionId);
      }
      if (setDesktopFollowerModelAndReasoning) {
        await setDesktopFollowerModelAndReasoning(selectedSessionId, model || null, reasoningEffort || null);
      }
      await syncDesktopFollowerCollaborationMode({
        selectedSessionId,
        collaborationMode: desktopCollaborationMode,
        setDesktopFollowerCollaborationMode
      });
      result = await startDesktopFollowerTurn(selectedSessionId, baseTurnStartParams);
      console.info(
        `[desktop-ipc] start-turn accepted session=${selectedSessionId} mode=${permissionMode || 'default'} turn=${result?.result?.turn?.id || result?.turn?.id || ''}`
      );
    }
    return result;
  }

  let result;
  const ownerRetryDelays = retryDelays(desktopOwnerRetryDelays);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await attemptDesktopFollowerTurn();
        break;
      } catch (error) {
        if (!isDesktopThreadOwnerUnavailable(error) || attempt >= ownerRetryDelays.length) {
          throw error;
        }
        const delay = ownerRetryDelays[attempt] || 0;
        if (delay > 0) {
          await sleep(delay);
        }
      }
    }
  } catch (error) {
    console.warn(
      `[desktop-ipc] start-turn failed session=${selectedSessionId} mode=${permissionMode || 'default'} error=${error?.message || error}`
    );
    if (isDesktopThreadOwnerUnavailable(error)) {
      throw desktopIpcUnavailableError(error?.message || undefined);
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
      ...userMessageMetadataForSendMode(sendMode),
      timestamp: now
    }
  });
  broadcast({
    type: 'status-update',
    source: bridge?.mode || 'desktop-ipc',
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
  emitJobEvent,
  scheduleAutoNameCompletedSession,
  onQueueDrained
}) {
  const metadataUpdates = [];

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
    rememberLiveSession?.(sessionRecord);
    metadataUpdates.push(
      Promise.all([
        job.project?.projectless
          ? registerProjectlessThread(payload.sessionId, job.project.path)
          : Promise.resolve(null),
        registerMobileSession(sessionRecord)
      ]).catch((error) => {
        console.warn('[sessions] Failed to register background thread:', error.message);
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
      serviceTier: job.serviceTier,
      permissionMode: job.permissionMode,
      collaborationMode: job.collaborationMode,
      turnId: job.turnId
    },
    (payload) => {
      const eventPayload = {
        ...payload,
        source: payload?.source || 'headless-local'
      };
      if (eventPayload.sessionId) {
        state.sessionId = eventPayload.sessionId;
        rememberConversationAlias(queueKey, eventPayload.sessionId);
      }
      if (eventPayload.previousSessionId) {
        rememberConversationAlias(queueKey, eventPayload.previousSessionId);
      }
      if (eventPayload.type === 'thread-started') {
        rememberStartedBackgroundThread(eventPayload);
      } else if (eventPayload.type === 'chat-started') {
        rememberStartedBackgroundThread(eventPayload);
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
        onQueueDrained?.();
      }
    }
  });
}
