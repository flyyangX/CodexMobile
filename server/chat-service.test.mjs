import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatService } from './chat-service.js';

function makeChatService(overrides = {}) {
  const broadcasts = [];
  const service = createChatService({
    imagePromptState: '/tmp/codexmobile-chat-service-test.json',
    getProject: () => ({ id: 'project-1', name: 'Project', path: '/tmp/project', projectless: false }),
    getSession: () => ({ id: 'thread-1', projectId: 'project-1' }),
    getCacheSnapshot: () => ({ config: { skills: [], model: 'gpt-5.5' } }),
    getDesktopBridgeStatus: async () => ({ strict: true, connected: true, mode: 'desktop-proxy', reason: null }),
    listProjectSessions: () => [],
    refreshCodexCache: async () => ({ syncedAt: 'now', projects: [] }),
    renameSession: async () => null,
    broadcast: (payload) => broadcasts.push(payload),
    runCodexTurn: async () => 'thread-1',
    steerCodexTurn: async () => ({ accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' }),
    abortCodexTurn: () => true,
    getActiveRuns: () => [],
    runImageTurn: async () => 'thread-1',
    isImageRequest: () => false,
    useLegacyImageGenerator: () => false,
    maybeAutoNameSession: async () => false,
    ...overrides
  });
  return { service, broadcasts };
}

async function flushQueuedWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('chat service stores and answers pending user input requests', async () => {
  const { service, broadcasts } = makeChatService();
  const requestMessage = {
    id: 9,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [{
        id: 'choice',
        header: '方案',
        question: '选哪个？',
        isOther: false,
        isSecret: false,
        options: [{ label: 'A', description: '推荐' }]
      }]
    }
  };

  let resolved = null;
  const pending = service.handleUserInputRequest(requestMessage, (answer) => {
    resolved = answer;
  });

  assert.equal(pending.key, 'thread-1:turn-1:input-1');
  const requestBroadcast = broadcasts.find((payload) => payload.type === 'user-input-request');
  assert.equal(requestBroadcast.itemId, 'input-1');
  assert.equal(requestBroadcast.questions[0].question, '选哪个？');
  assert.equal(broadcasts.some((payload) => payload.type === 'status-update' && payload.label === '等待你的选择'), true);

  const result = service.respondToUserInput({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    answers: { choice: { answers: ['A'] } }
  });

  assert.equal(result.ok, true);
  assert.equal(result.request.itemId, 'input-1');
  assert.equal(result.itemId, undefined);
  assert.deepEqual(resolved, { answers: { choice: { answers: ['A'] } } });
  assert.equal(broadcasts.some((payload) => payload.type === 'user-input-resolved'), true);
});

test('chat service reports missing pending user input requests', () => {
  const { service } = makeChatService();

  const result = service.respondToUserInput({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'missing',
    answers: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
});

test('chat service clears pending user input requests when turn cleanup runs', async () => {
  let cleanupType = null;
  let resolved = null;
  const requestMessage = {
    id: 10,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [{
        id: 'choice',
        header: '方案',
        question: '继续吗？',
        isOther: false,
        isSecret: false,
        options: [{ label: '继续', description: '' }]
      }]
    }
  };
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      cleanupType = typeof payload.onUserInputCleanup;
      payload.onUserInputRequest(requestMessage, (answer) => {
        resolved = answer;
      });
      if (typeof payload.onUserInputCleanup === 'function') {
        payload.onUserInputCleanup({ threadId: 'thread-1', turnId: 'turn-1' });
      }
      emit({ type: 'chat-error', sessionId: 'thread-1', turnId: 'turn-1', error: 'cancelled' });
      return 'thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'turn-1',
    message: '需要选择'
  });
  await flushQueuedWork();

  const late = service.respondToUserInput({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    answers: { choice: { answers: ['继续'] } }
  });

  assert.equal(cleanupType, 'function');
  assert.deepEqual(
    broadcasts.filter((payload) => payload.type === 'user-input-resolved').map((payload) => ({
      threadId: payload.threadId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      status: payload.status,
      reason: payload.reason
    })),
    [{
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'input-1',
      status: 'cancelled',
      reason: 'turn-cleanup'
    }]
  );
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'not-found');
  assert.equal(resolved, null);
});

test('sendChat routes running input through desktop turn/steer', async () => {
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
  assert.equal(broadcasts.some((payload) => payload.type === 'user-message'), true);
});

test('sendChat rejects when strict desktop bridge is unavailable', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: false,
      mode: 'unavailable',
      reason: '桌面端未连接'
    })
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-1',
      sessionId: 'thread-1',
      message: 'hello'
    }),
    /桌面端未连接/
  );
  assert.equal(broadcasts.length, 0);
});

test('sendChat rejects desktop-ipc draft sends with a create-thread specific error', async () => {
  const { service, broadcasts } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    })
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-1',
      draftSessionId: 'draft-project-1-1',
      message: '手机新建一个同源对话'
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'CODEXMOBILE_DESKTOP_CREATE_THREAD_UNAVAILABLE');
      assert.match(error.message, /不能从手机直接新建桌面端对话/);
      return true;
    }
  );
  assert.equal(broadcasts.length, 0);
});

test('sendChat sends existing desktop-ipc threads through the desktop follower bridge', async () => {
  let started = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '从手机发到桌面已有线程'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.turnId, 'desktop-turn-1');
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(started.params.input[0].type, 'text');
  assert.equal(started.params.input[0].text, '从手机发到桌面已有线程');
});

test('sendChat desktop follower start omits collaboration mode by default', async () => {
  let started = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-default' } } };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '正常发送到桌面'
  });

  assert.equal(Object.hasOwn(started.params, 'collaborationMode'), false);
});

test('sendChat falls back to headless local when desktop-ipc has no thread owner', async () => {
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
    startDesktopFollowerTurn: async () => {
      const error = new Error('桌面端 Codex 已连接，但当前线程没有可接管的桌面窗口。');
      error.statusCode = 409;
      error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
      throw error;
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'client-turn',
    message: '桌面窗口不在时继续执行'
  });

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.sessionId, 'thread-1');
  assert.match(runPayload.message, /桌面窗口不在时继续执行/);
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
      emit({ type: 'thread-started', sessionId: 'background-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      emit({ type: 'chat-complete', sessionId: 'background-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
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
      emit({
        type: 'thread-started',
        sessionId: 'projectless-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId,
        startedAt: '2026-05-07T08:00:00.000Z'
      });
      emit({
        type: 'chat-complete',
        sessionId: 'projectless-thread-1',
        previousSessionId: payload.draftSessionId,
        turnId: payload.turnId
      });
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
    message: '你好呀'
  });
  await flushQueuedWork();

  assert.equal(result.accepted, true);
  assert.equal(runPayload.draftSessionId, 'draft-projectless-1');
  assert.match(runPayload.projectPath, /\/tmp\/codex-projectless\/\d{4}-\d{2}-\d{2}\/mobile-chat-/);
  assert.deepEqual(desktopRegistration, {
    threadId: 'projectless-thread-1',
    workspaceRoot: '/tmp/codex-projectless'
  });
  assert.equal(mobileRegistration.id, 'projectless-thread-1');
  assert.equal(mobileRegistration.projectless, true);
  assert.equal(mobileRegistration.summary, '你好呀');
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
      emit({ type: 'thread-started', sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      emit({ type: 'chat-complete', sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
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
  assert.equal(broadcasts.some((payload) => payload.type === 'user-message'), true);
});

test('sendChat forwards plan collaboration mode to headless Codex turns', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'turn-plan-1',
    message: '先做计划',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    collaborationMode: { mode: 'plan', settings: {} }
  });

  assert.deepEqual(runPayload.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      developer_instructions: null
    }
  });
});

test('sendChat forwards plan collaboration mode to desktop follower starts', async () => {
  let started = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-plan' } } };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '桌面先做计划',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    collaborationMode: { mode: 'plan', settings: {} }
  });

  assert.equal(started.conversationId, 'thread-1');
  assert.deepEqual(started.params.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
});

test('sendChat does not forward plan collaboration mode for steer', async () => {
  let steerPayload = null;
  const { service } = makeChatService({
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '这个补充发到当前任务',
    sendMode: 'steer',
    collaborationMode: { mode: 'plan', settings: {} }
  });

  assert.equal(steerPayload.payload.collaborationMode, undefined);
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
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
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
