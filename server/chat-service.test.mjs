/**
 * 测试 server/chat-service.js：发送消息、队列与依赖注入路径。
 *
 * Keywords: chat-service, test, integration
 *
 * Exports: 无导出，内含用例
 *
 * Inward: chat-service.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatService } from './chat-service.js';

function syncEvent(eventType, payload = {}, extra = {}) {
  return {
    type: 'sync-event',
    event: {
      id: `${eventType}-${payload.turnId || payload.sessionId || 'event'}`,
      eventType,
      protocol: 'codexmobile-sync',
      source: payload.source || 'headless-local',
      timestamp: payload.timestamp || new Date().toISOString(),
      ...payload,
      ...extra
    }
  };
}

function turnCompletedEvent(payload = {}) {
  return syncEvent('turn.completed', { status: 'completed', ...payload });
}

function threadStartedEvent(payload = {}) {
  return syncEvent('thread.started', { status: 'running', ...payload }, {
    session: {
      id: payload.sessionId,
      cwd: payload.cwd || '/tmp/project'
    }
  });
}

function broadcastEvent(broadcasts, eventType) {
  return broadcasts.find((payload) => payload.type === 'sync-event' && payload.event?.eventType === eventType);
}

function broadcastEventCount(broadcasts, eventType) {
  return broadcasts.filter((payload) => payload.type === 'sync-event' && payload.event?.eventType === eventType).length;
}

function desktopOwnerUnavailableError() {
  const error = new Error('桌面端 Codex 已连接，但当前线程没有可接管的桌面窗口。');
  error.statusCode = 409;
  error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
  return error;
}

async function rejectDesktopFollowerTurn() {
  throw desktopOwnerUnavailableError();
}

function makeChatService(overrides = {}) {
  const broadcasts = [];
  const service = createChatService({
    imagePromptState: '/tmp/codexmobile-chat-service-test.json',
    getProject: () => ({ id: 'project-1', name: 'Project', path: '/tmp/project', projectless: false }),
    getSession: () => ({ id: 'thread-1', projectId: 'project-1' }),
    getCacheSnapshot: () => ({ config: { skills: [], model: 'gpt-5.5' } }),
    getDesktopBridgeStatus: async () => ({ strict: true, connected: true, mode: 'desktop-proxy', reason: null }),
    listProjectSessions: () => [],
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => ({ syncedAt: 'now', projects: [] }),
    renameSession: async () => null,
    broadcast: (payload) => broadcasts.push(payload),
    runCodexTurn: async () => 'thread-1',
    steerCodexTurn: async () => ({ accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' }),
    startDesktopFollowerTurn: rejectDesktopFollowerTurn,
    steerDesktopFollowerTurn: rejectDesktopFollowerTurn,
    interruptDesktopFollowerTurn: async () => ({ interrupted: true }),
    setDesktopFollowerCollaborationMode: async () => ({ ok: true }),
    abortCodexTurn: () => true,
    getActiveRuns: () => [],
    runImageTurn: async () => 'thread-1',
    isImageRequest: () => false,
    useLegacyImageGenerator: () => false,
    maybeAutoNameSession: async () => false,
    registerProjectlessThread: async () => null,
    registerMobileSession: async () => null,
    rememberLiveSession: () => null,
    ...overrides
  });
  return { service, broadcasts };
}

async function flushQueuedWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('sendChat routes running input through local headless steer', async () => {
  let steerPayload = null;
  const { service, broadcasts } = makeChatService({
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '补充这个方向',
    sendMode: 'steer'
  });

  assert.equal(result.delivery, 'steered');
  assert.equal(result.clientTurnId, 'client-turn');
  assert.equal(result.turnId, 'active-turn');
  assert.equal(steerPayload.identifier, 'thread-1');
  assert.match(steerPayload.payload.message, /补充这个方向/);
  assert.equal(broadcasts.some((payload) => payload.type === 'sync-event' && payload.event?.eventType === 'message.user'), true);
});

test('sendChat uses headless local even when the desktop bridge is unavailable', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: false,
      mode: 'unavailable',
      reason: '桌面端未连接'
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: 'hello'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(result.desktopBridge.connected, true);
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.equal(broadcasts.some((payload) => payload.type === 'sync-event' && payload.event?.eventType === 'message.user'), true);
});

test('abortChat records and broadcasts an aborted turn even after the backend run is gone', async () => {
  let abortedIdentifier = null;
  const { service, broadcasts } = makeChatService({
    abortCodexTurn: (identifier) => {
      abortedIdentifier = identifier;
      return false;
    }
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(abortedIdentifier, 'client-turn-1');
  assert.equal(service.getTurn('client-turn-1').status, 'aborted');
  assert.equal(service.getTurn('client-turn-1').sessionId, 'thread-1');
  assert.equal(broadcasts.at(-1).type, 'sync-event');
  assert.equal(broadcasts.at(-1).event.eventType, 'turn.aborted');
  assert.equal(broadcasts.at(-1).event.turnId, 'client-turn-1');
  assert.equal(broadcasts.at(-1).event.sessionId, 'thread-1');
});

test('compactChat calls desktop compact and broadcasts detected context state', async () => {
  let compactedSessionId = null;
  const { service, broadcasts } = makeChatService({
    compactCodexThread: async (sessionId) => {
      compactedSessionId = sessionId;
      return { compacted: true };
    }
  });

  const result = await service.compactChat({
    projectId: 'project-1',
    sessionId: 'thread-1'
  });

  assert.deepEqual(result, { accepted: true, sessionId: 'thread-1', result: { compacted: true } });
  assert.equal(compactedSessionId, 'thread-1');
  assert.equal(broadcasts.some((payload) =>
    payload.type === 'sync-event' &&
    payload.event?.eventType === 'context.updated' &&
    payload.event?.sessionId === 'thread-1' &&
    payload.event?.context?.autoCompact?.detected === true
  ), true);
});

test('compactChat broadcasts a running activity before desktop compact finishes', async () => {
  let resolveCompact;
  const compactPromise = new Promise((resolve) => {
    resolveCompact = resolve;
  });
  const { service, broadcasts } = makeChatService({
    compactCodexThread: async () => compactPromise
  });

  const pending = service.compactChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientActionId: 'compact-action-1'
  });
  await new Promise((resolve) => setImmediate(resolve));

  const running = broadcasts.find((payload) =>
    payload.type === 'sync-event' &&
    payload.event?.eventType === 'activity.updated' &&
    payload.event?.activity?.kind === 'context_compaction' &&
    payload.event?.status === 'running'
  );
  assert.equal(running?.event.label, '正在压缩上下文');
  assert.equal(running?.event.itemId, 'compact-action-1');

  resolveCompact({ compacted: true });
  await pending;
  assert.equal(broadcasts.some((payload) =>
    payload.type === 'sync-event' &&
    payload.event?.eventType === 'activity.completed' &&
    payload.event?.itemId === running.event.itemId &&
    payload.event?.status === 'completed' &&
    payload.event?.label === '上下文已压缩'
  ), true);
});

test('compactChat broadcasts a failed activity when desktop compact fails', async () => {
  const { service, broadcasts } = makeChatService({
    compactCodexThread: async () => {
      throw new Error('desktop compact failed');
    }
  });

  await assert.rejects(
    service.compactChat({
      projectId: 'project-1',
      sessionId: 'thread-1'
    }),
    /desktop compact failed/
  );

  assert.equal(broadcasts.some((payload) =>
    payload.type === 'sync-event' &&
    payload.event?.eventType === 'activity.failed' &&
    payload.event?.activity?.kind === 'context_compaction' &&
    payload.event?.status === 'failed' &&
    payload.event?.label === '上下文压缩失败' &&
    /desktop compact failed/.test(payload.event.detail)
  ), true);
});

test('sendChat creates draft threads through headless even when desktop IPC cannot create desktop threads', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(threadStartedEvent({ sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      emit(turnCompletedEvent({ sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      return 'headless-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    message: '手机新建一个同源对话'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.draftSessionId, 'draft-project-1-1');
  assert.equal(Boolean(broadcastEvent(broadcasts, 'message.user')), true);
});

test('sendChat prefers desktop IPC for existing desktop threads when the owner is available', async () => {
  let started = null;
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false, backgroundCodex: true }
    }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { turn: { id: 'desktop-turn-1' } };
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '从手机优先交给桌面 IPC'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.turnId, 'desktop-turn-1');
  assert.equal(result.clientTurnId, 'client-turn-1');
  assert.equal(result.desktopBridge.mode, 'desktop-ipc');
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(started.params.input.at(-1).text, '从手机优先交给桌面 IPC');
  assert.equal(runPayload, null);
  assert.equal(service.getTurn('client-turn-1')?.source, 'desktop-ipc');
  assert.equal(broadcasts.some((payload) => payload.event?.eventType === 'turn.running' && payload.event?.source === 'desktop-ipc'), true);
});

test('sendChat ignores desktop follower bridge for existing desktop-ipc threads', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '从手机发到已有线程'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.match(runPayload.message, /从手机发到已有线程/);
});

test('sendChat records headless runtime instead of desktop IPC handoff', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    },
    readSessionMessages: async () => ({ messages: [] })
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '从手机发到后台 headless 运行'
  });

  assert.equal(result.turnId, 'client-turn-1');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.notEqual(service.getTurn('client-turn-1')?.source, 'desktop-ipc');
  assert.equal(service.getTurn('desktop-turn-1'), null);
  assert.equal(broadcasts.some((payload) => payload.event?.eventType === 'turn.running' && payload.event?.source === 'desktop-ipc'), false);
});

test('abortChat does not interrupt desktop IPC after mobile sends', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    readSessionMessages: async () => ({ messages: [] }),
    abortCodexTurn: () => false
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '准备从手机中止桌面 IPC'
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(service.getTurn('client-turn-1').status, 'aborted');
  assert.equal(broadcasts.filter((payload) => payload.event?.eventType === 'turn.aborted' && payload.event?.source === 'desktop-ipc').length, 0);
});

test('abortChat no longer falls back to desktop IPC when turn id does not match', async () => {
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    readSessionMessages: async () => ({ messages: [] }),
    abortCodexTurn: () => false
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '准备用 session id 兜底中止'
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'stale-mobile-turn-id'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(service.getTurn('stale-mobile-turn-id').status, 'aborted');
});

test('abortChat aborts an active headless run before a desktop IPC monitor on the same session', async () => {
  let abortedIdentifier = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    readSessionMessages: async () => ({ messages: [] }),
    getActiveRuns: () => [{
      sessionId: 'thread-1',
      previousSessionId: 'thread-1',
      turnId: 'headless-turn-1',
      status: 'running',
      source: 'headless-local'
    }],
    abortCodexTurn: (identifier) => {
      abortedIdentifier = identifier;
      return true;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-1',
    message: '先创建一个桌面 monitor'
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'headless-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(abortedIdentifier, 'headless-turn-1');
  assert.equal(broadcasts.at(-1).type, 'sync-event');
  assert.equal(broadcasts.at(-1).event.eventType, 'turn.aborted');
  assert.equal(broadcasts.at(-1).event.source, 'headless-local');
  assert.equal(broadcasts.at(-1).event.turnId, 'headless-turn-1');
});

test('abortChat does not interrupt desktop-origin sessions from mobile', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    abortCodexTurn: () => false
  });

  const aborted = await service.abortChat({
    projectId: 'project-1',
    sessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, false);
  assert.equal(broadcasts.length, 0);
});

test('abortChat clears a headless turn by session when activeRuns has already dropped it', async () => {
  let abortedIdentifier = null;
  const { service, broadcasts } = makeChatService({
    runCodexTurn: async () => new Promise(() => {}),
    abortCodexTurn: (identifier) => {
      abortedIdentifier = identifier;
      return false;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-session-only',
    message: '这个任务会卡住'
  });
  await flushQueuedWork();

  const aborted = await service.abortChat({
    sessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(abortedIdentifier, 'client-turn-session-only');
  assert.equal(service.getTurn('client-turn-session-only').status, 'aborted');
  assert.equal(broadcasts.at(-1).type, 'sync-event');
  assert.equal(broadcasts.at(-1).event.eventType, 'turn.aborted');
  assert.equal(broadcasts.at(-1).event.turnId, 'client-turn-session-only');
});

test('headless runner rejection emits a terminal failure and frees the next send', async () => {
  let runCount = 0;
  const { service, broadcasts } = makeChatService({
    runCodexTurn: async (payload, emit) => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error('Request failed: 404');
      }
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-fail',
    message: '第一次失败'
  });
  await flushQueuedWork();

  const second = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-after-fail',
    message: '第二次应该直接启动'
  });
  await flushQueuedWork();

  assert.equal(first.delivery, 'started');
  assert.equal(service.getTurn('client-turn-fail').status, 'failed');
  assert.equal(broadcasts.some((payload) => payload.event?.eventType === 'turn.failed' && payload.event?.turnId === 'client-turn-fail'), true);
  assert.equal(second.delivery, 'started');
  assert.equal(service.getTurn('client-turn-after-fail').status, 'completed');
});

test('post-run cache refresh does not keep the conversation queue running', async () => {
  let runCount = 0;
  let refreshStarted = false;
  const routeBounces = [];
  const { service } = makeChatService({
    refreshCodexCache: async () => {
      refreshStarted = true;
      return new Promise(() => {});
    },
    runCodexTurn: async (payload, emit) => {
      runCount += 1;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    },
    triggerDesktopRefreshForThread: async (threadId, options) => {
      routeBounces.push({ threadId, options });
      return { triggered: true };
    }
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-refresh-1',
    message: '第一次完成但刷新很慢'
  });
  await flushQueuedWork();

  const second = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-refresh-2',
    message: '第二次不能被刷新阻塞'
  });
  await flushQueuedWork();

  assert.equal(first.delivery, 'started');
  assert.equal(refreshStarted, true);
  assert.equal(second.delivery, 'started');
  assert.equal(runCount, 2);
  assert.deepEqual(routeBounces, [
    {
      threadId: 'thread-1',
      options: { reason: 'headless-turn-done' }
    },
    {
      threadId: 'thread-1',
      options: { reason: 'headless-turn-done' }
    }
  ]);
});

test('sendChat asks desktop to refresh after an existing headless thread completes', async () => {
  const routeBounces = [];
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    },
    triggerDesktopRefreshForThread: async (threadId, options) => {
      routeBounces.push({ threadId, options });
      return { triggered: true };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn-existing-refresh',
    message: '手机端执行完以后桌面也刷新'
  });
  await flushQueuedWork();

  assert.equal(result.delivery, 'started');
  assert.deepEqual(routeBounces, [
    {
      threadId: 'thread-1',
      options: { reason: 'headless-turn-done' }
    }
  ]);
});

test('sendChat sends plan requests through headless without desktop collaboration IPC', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '先给我计划',
    collaborationMode: 'plan',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    serviceTier: 'fast'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.deepEqual(runPayload.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
  assert.equal(runPayload.serviceTier, 'fast');
});

test('sendChat leaves desktop collaboration mode untouched for normal headless follow-up turns', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '执行计划'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.collaborationMode, null);
});

test('sendChat exits plan mode explicitly before implementing a plan', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: 'Implement plan.',
    collaborationMode: 'default',
    model: 'gpt-5.5',
    reasoningEffort: 'high'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.deepEqual(runPayload.collaborationMode, {
    mode: 'default',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
});

test('sendChat implements proposed plans through headless with full plan content even when desktop IPC is available', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-plan-turn',
    message: 'Implement plan.',
    visibleMessage: '执行计划',
    collaborationMode: 'default',
    planImplementation: {
      planContent: '# 修复计划\n\n## Summary\n处理计划执行失败。'
    }
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(broadcastEventCount(broadcasts, 'message.user'), 1);
  assert.equal(broadcasts.some((payload) => payload.event?.eventType === 'turn.running' && payload.event?.source === 'desktop-ipc'), false);
  assert.match(runPayload.message, /^PLEASE IMPLEMENT THIS PLAN:/);
  assert.match(runPayload.message, /处理计划执行失败/);
});

test('sendChat uses headless local directly for existing desktop-ipc threads', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '移动端发送只走后台'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.match(runPayload.message, /移动端发送只走后台/);
  assert.equal(broadcastEventCount(broadcasts, 'message.user'), 1);
});

test('sendChat does not push mobile model settings into desktop IPC before start', async () => {
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '确认执行这个计划',
    model: 'gpt-5.5',
    reasoningEffort: 'medium'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
});

test('sendChat does not call desktop start turn when desktop IPC would time out', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '移动端发送不等待桌面 IPC'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.match(runPayload.message, /移动端发送不等待桌面 IPC/);
});

test('sendChat does not wait for a desktop-ipc owner before using headless local', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '等桌面 owner 绑定后再执行'
  });

  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(result.turnId, 'client-turn');
  assert.equal(runPayload.sessionId, 'thread-1');
});

test('sendChat can create a background thread when desktop-ipc cannot create desktop threads', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(threadStartedEvent({ sessionId: 'background-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      emit(turnCompletedEvent({ sessionId: 'background-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      return 'background-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn',
    message: '从手机后台新建'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.draftSessionId, 'draft-project-1-1');
  assert.match(runPayload.message, /从手机后台新建/);
});

test('sendChat asks desktop to hot-refresh after a background thread is created', async () => {
  const desktopRefreshes = [];
  const routeBounces = [];
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      emit(threadStartedEvent({
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        cwd: '/tmp/project'
      }));
      emit(turnCompletedEvent({
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      }));
      return 'background-thread-1';
    },
    notifyDesktopThreadListChanged: async (payload) => {
      desktopRefreshes.push(payload);
      return { sent: true };
    },
    triggerDesktopRefreshForThread: async (threadId, options) => {
      routeBounces.push({ threadId, options });
      return { triggered: true };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn',
    message: '从手机后台新建'
  });
  await flushQueuedWork();

  assert.deepEqual(desktopRefreshes, [
    {
      threadId: 'background-thread-1',
      cwd: '/tmp/project',
      reason: 'background-thread-created'
    },
    {
      threadId: 'background-thread-1',
      cwd: '/tmp/project',
      reason: 'background-thread-done'
    }
  ]);
  assert.deepEqual(routeBounces, [
    {
      threadId: 'background-thread-1',
      options: { reason: 'background-thread-done' }
    }
  ]);
});

test('sendChat reuses a background-created thread alias for later headless sends', async () => {
  const runPayloads = [];
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayloads.push(payload);
      emit(threadStartedEvent({
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      }));
      emit(turnCompletedEvent({
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      }));
      return 'background-thread-1';
    }
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn-1',
    message: '从手机后台新建'
  });
  await flushQueuedWork();

  const second = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn-2',
    message: '继续这条线程'
  });
  await flushQueuedWork();

  assert.equal(first.desktopBridge.mode, 'headless-local');
  assert.equal(second.desktopBridge.mode, 'headless-local');
  assert.equal(second.sessionId, 'background-thread-1');
  assert.ok(['started', 'queued'].includes(second.delivery));
  assert.equal(runPayloads.at(0).draftSessionId, 'draft-project-1-1');
});

test('sendChat registers new projectless background threads for mobile and desktop lists', async () => {
  let runPayload = null;
  let desktopRegistration = null;
  let mobileRegistration = null;
  const { service } = makeChatService({
    getProject: () => ({
      id: '__codexmobile_projectless__',
      name: '普通对话',
      path: '/tmp/codex-projectless',
      projectless: true
    }),
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(threadStartedEvent({
        sessionId: 'projectless-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        startedAt: '2026-05-07T08:00:00.000Z'
      }));
      emit(turnCompletedEvent({
        sessionId: 'projectless-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      }));
      return 'projectless-thread-1';
    },
    registerProjectlessThread: async (threadId, workspaceRoot) => {
      desktopRegistration = { threadId, workspaceRoot };
    },
    registerMobileSession: async (session) => {
      mobileRegistration = session;
    }
  });

  const result = await service.sendChat({
    projectId: '__codexmobile_projectless__',
    draftSessionId: 'draft-projectless-1',
    clientTurnId: 'client-turn',
    message: '你好呀',
    attachments: [
      { id: 'img-1', name: '午餐.png', path: '/tmp/lunch.png', mimeType: 'image/png', kind: 'image' }
    ]
  });
  await flushQueuedWork();

  assert.equal(result.accepted, true);
  assert.equal(runPayload.draftSessionId, 'draft-projectless-1');
  assert.match(runPayload.message, /图片: 午餐\.png \(\/tmp\/lunch\.png\)/);
  assert.match(runPayload.projectPath, /\/tmp\/codex-projectless\/\d{4}-\d{2}-\d{2}\/mobile-chat-/);
  assert.deepEqual(desktopRegistration, {
    threadId: 'projectless-thread-1',
    workspaceRoot: '/tmp/codex-projectless'
  });
  assert.equal(mobileRegistration.id, 'projectless-thread-1');
  assert.equal(mobileRegistration.projectless, true);
  assert.equal(mobileRegistration.summary, '你好呀');
  assert.match(mobileRegistration.messages[0].content, /!\[午餐\.png\]\(\/tmp\/lunch\.png\)/);
});

test('sendChat remembers a started background thread path before broadcasting it', async () => {
  const events = [];
  const { service } = makeChatService({
    broadcast: (payload) => events.push(`broadcast:${payload.event?.eventType || payload.type}`),
    rememberLiveSession: (session) => events.push(`remember:${session.id}:${session.filePath}`),
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: {
        sendToOpenDesktopThread: true,
        createThread: false,
        createThreadViaBackground: true,
        backgroundCodex: true
      }
    }),
    runCodexTurn: async (payload, emit) => {
      emit(threadStartedEvent({
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        filePath: '/tmp/background-rollout.jsonl',
        startedAt: '2026-05-07T08:00:00.000Z'
      }));
      emit(turnCompletedEvent({
        sessionId: 'background-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      }));
      return 'background-thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1',
    clientTurnId: 'client-turn',
    message: '后台新线程'
  });
  await flushQueuedWork();

  const rememberedIndex = events.findIndex((event) => event === 'remember:background-thread-1:/tmp/background-rollout.jsonl');
  const broadcastIndex = events.findIndex((event) => event === 'broadcast:thread.started');
  assert.ok(rememberedIndex >= 0);
  assert.ok(broadcastIndex > rememberedIndex);
});

test('sendChat starts project-bound draft threads in the selected project cwd', async () => {
  let runPayload = null;
  let projectlessRegistrationCount = 0;
  let mobileRegistration = null;
  const { service } = makeChatService({
    getProject: () => ({
      id: 'project-codexmobile',
      name: 'CodexMobile',
      path: '/Users/xiayanghui/Code/CodexMobile',
      projectless: false
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(threadStartedEvent({
        sessionId: 'project-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        cwd: payload.projectPath,
        startedAt: '2026-05-14T12:00:00.000Z'
      }));
      emit(turnCompletedEvent({
        sessionId: 'project-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      }));
      return 'project-thread-1';
    },
    registerProjectlessThread: async () => {
      projectlessRegistrationCount += 1;
    },
    registerMobileSession: async (session) => {
      mobileRegistration = session;
    }
  });

  await service.sendChat({
    projectId: 'project-codexmobile',
    draftSessionId: 'draft-project-codexmobile-1',
    clientTurnId: 'client-turn',
    message: '在项目里开新线程'
  });
  await flushQueuedWork();

  assert.equal(runPayload.projectPath, '/Users/xiayanghui/Code/CodexMobile');
  assert.equal(projectlessRegistrationCount, 0);
  assert.equal(mobileRegistration.projectPath, '/Users/xiayanghui/Code/CodexMobile');
  assert.equal(mobileRegistration.projectless, false);
});

test('sendChat starts a headless local Codex turn when desktop bridge is in headless mode', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason: '桌面端未打开，正在使用后台 Codex',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(threadStartedEvent({ sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      emit(turnCompletedEvent({ sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      return 'headless-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn',
    message: '桌面端没开也跑一下'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.draftSessionId, 'draft-project-1-1');
  assert.match(runPayload.message, /桌面端没开也跑一下/);
  assert.equal(Boolean(broadcastEvent(broadcasts, 'message.user')), true);
  assert.equal(broadcastEvent(broadcasts, 'thread.started')?.event.source, 'headless-local');
  assert.equal(broadcastEvent(broadcasts, 'turn.completed')?.event.source, 'headless-local');
});

test('sendChat passes plan collaboration mode to headless local Codex turns', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason: '桌面端未打开，正在使用后台 Codex',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(threadStartedEvent({ sessionId: 'headless-plan-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      emit(turnCompletedEvent({ sessionId: 'headless-plan-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId }));
      return 'headless-plan-thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    message: '先规划一下',
    collaborationMode: 'plan',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    serviceTier: 'fast'
  });

  assert.equal(runPayload.serviceTier, 'fast');
  assert.deepEqual(runPayload.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
});

test('queue drafts can be listed, deleted, and restored without auto starting during active work', async () => {
  const { service } = makeChatService({
    getActiveRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    getCacheSnapshot: () => ({
      config: {
        model: 'gpt-5.5',
        skills: [{ name: 'frontend-design', path: '/skills/frontend-design/SKILL.md' }]
      }
    })
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-turn-1',
    message: '排队草稿 1',
    sendMode: 'queue',
    selectedSkills: [{ path: '/skills/frontend-design/SKILL.md' }],
    fileMentions: [{ name: 'App.jsx', path: '/repo/client/src/App.jsx' }]
  });
  const second = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-turn-2',
    message: '排队草稿 2',
    sendMode: 'queue'
  });

  assert.equal(first.delivery, 'queued');
  assert.equal(second.delivery, 'queued');
  let queue = service.listQueue({ sessionId: 'thread-1' });
  assert.equal(queue.drafts.length, 2);
  assert.equal(queue.drafts[0].text, '排队草稿 1');
  assert.equal(queue.drafts[0].selectedSkills[0].path, '/skills/frontend-design/SKILL.md');
  assert.equal(queue.drafts[0].fileMentions[0].path, '/repo/client/src/App.jsx');

  const deleted = service.removeQueuedDraft({ sessionId: 'thread-1', draftId: 'queued-turn-2' });
  assert.equal(deleted.text, '排队草稿 2');
  queue = service.listQueue({ sessionId: 'thread-1' });
  assert.equal(queue.drafts.length, 1);

  const restored = service.restoreQueuedDraft({ sessionId: 'thread-1', draftId: 'queued-turn-1' });
  assert.equal(restored.text, '排队草稿 1');
  assert.equal(service.listQueue({ sessionId: 'thread-1' }).drafts.length, 0);
});

test('queued drafts can be steered into the current turn', async () => {
  let steerPayload = null;
  const { service } = makeChatService({
    getActiveRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { sessionId: 'thread-1', turnId: 'steered-turn' };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-steer-1',
    message: '马上补充这句',
    fileMentions: [{ name: 'server.js', path: '/repo/server/index.js' }],
    sendMode: 'queue'
  });

  const result = await service.steerQueuedDraft({
    projectId: 'project-1',
    sessionId: 'thread-1',
    draftId: 'queued-steer-1'
  });

  assert.equal(result.delivery, 'steered');
  assert.equal(steerPayload.identifier, 'thread-1');
  assert.match(steerPayload.payload.message, /马上补充这句/);
  assert.match(steerPayload.payload.message, /引用文件路径/);
  assert.match(steerPayload.payload.message, /\/repo\/server\/index\.js/);
  assert.equal(service.listQueue({ sessionId: 'thread-1' }).drafts.length, 0);
});

test('file mentions are appended to normal chat sends', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      reason: null,
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit(turnCompletedEvent({ sessionId: payload.sessionId, turnId: payload.turnId }));
      return payload.sessionId;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '看文件',
    fileMentions: [{ name: 'App.jsx', path: '/repo/client/src/App.jsx' }]
  });

  assert.match(runPayload.message, /看文件/);
  assert.match(runPayload.message, /引用文件路径/);
  assert.match(runPayload.message, /App\.jsx \(\/repo\/client\/src\/App\.jsx\)/);
});
