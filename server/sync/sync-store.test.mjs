/**
 * 测试 server/sync：SyncEvent 与 app-server v2 事件如何投影 runtime 与 session 快照。
 *
 * Keywords: sync-store, sync-event, runtime, app-server-v2
 *
 * Exports: 无导出 / 内含用例。
 *
 * Inward: server/sync/sync-events.js, server/sync/app-server-events.js, server/sync/sync-store.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppServerMessageToSyncEvents } from './app-server-events.js';
import { createSyncEvent } from './sync-events.js';
import { createSyncStore } from './sync-store.js';

test('desktop IPC running and completed update one runtime without chat activity semantics', () => {
  const store = createSyncStore();
  const running = createSyncEvent('turn.running', {
    source: 'desktop-ipc',
    status: 'running',
    sessionId: 'session-1',
    turnId: 'turn-1',
    label: '已交给桌面端处理'
  }, {
    suppressedInChat: true
  });

  assert.equal(running.eventType, 'turn.running');
  assert.equal(running.suppressedInChat, true);
  store.applyEvent(running);
  assert.equal(store.snapshot().runtimeById['session-1'].source, 'desktop-ipc');
  assert.equal(store.snapshot().runtimeById['turn-1'].status, 'running');

  const completed = createSyncEvent('turn.completed', {
    source: 'desktop-ipc',
    status: 'completed',
    sessionId: 'session-1',
    turnId: 'turn-1'
  });
  store.applyEvent(completed);
  assert.equal(store.snapshot().runtimeById['session-1'], undefined);
  assert.equal(store.snapshot().runtimeById['turn-1'], undefined);
  assert.equal(store.snapshot().terminalById['session-1'].status, 'completed');
});

test('desktop IPC terminal event clears client turn keys for the same session', () => {
  const store = createSyncStore();
  const running = createSyncEvent('turn.running', {
    source: 'desktop-ipc',
    status: 'running',
    sessionId: 'session-1',
    turnId: 'client-turn-1',
    label: '已交给桌面端处理'
  });
  store.applyEvent(running);
  assert.equal(store.snapshot().runtimeById['client-turn-1'].status, 'running');

  const completed = createSyncEvent('turn.completed', {
    source: 'desktop-ipc',
    status: 'completed',
    sessionId: 'session-1'
  });
  store.applyEvent(completed);

  assert.equal(store.snapshot().runtimeById['session-1'], undefined);
  assert.equal(store.snapshot().runtimeById['client-turn-1'], undefined);
  assert.equal(store.snapshot().terminalById['client-turn-1'].status, 'completed');
});

test('app-server v2 terminal event clears client and app turn runtime keys', () => {
  const store = createSyncStore();
  const [running] = normalizeAppServerMessageToSyncEvents({
    method: 'turn/started',
    params: { threadId: 'session-1', turn: { id: 'app-turn-1' } }
  }, {
    source: 'headless-local',
    sessionId: 'session-1',
    turnId: 'client-turn-1',
    clientTurnId: 'client-turn-1'
  });
  store.applyEvent(running);
  assert.equal(store.snapshot().runtimeById['session-1'].appTurnId, 'app-turn-1');
  assert.equal(store.snapshot().runtimeById['client-turn-1'].protocol, 'app-server-v2');
  assert.equal(store.snapshot().runtimeById['app-turn-1'].status, 'running');

  const [completed] = normalizeAppServerMessageToSyncEvents({
    method: 'turn/completed',
    params: { threadId: 'session-1', turn: { id: 'app-turn-1', status: 'completed' } }
  }, {
    source: 'headless-local',
    sessionId: 'session-1',
    turnId: 'client-turn-1',
    clientTurnId: 'client-turn-1',
    appTurnId: 'app-turn-1'
  });
  store.applyEvent(completed);

  assert.equal(store.snapshot().runtimeById['session-1'], undefined);
  assert.equal(store.snapshot().runtimeById['client-turn-1'], undefined);
  assert.equal(store.snapshot().runtimeById['app-turn-1'], undefined);
  assert.equal(store.snapshot().terminalById['app-turn-1'].protocol, 'app-server-v2');
});

test('headless and desktop running events share the same runtime projection shape', () => {
  const store = createSyncStore();
  for (const event of [
    createSyncEvent('turn.running', { source: 'desktop-ipc', status: 'running', sessionId: 'desktop-session', turnId: 'desktop-turn' }),
    createSyncEvent('turn.running', { source: 'headless-local', status: 'running', sessionId: 'headless-session', turnId: 'headless-turn' })
  ]) {
    store.applyEvent(event);
  }
  const snapshot = store.snapshot();
  assert.deepEqual(Object.keys(snapshot.runtimeById['desktop-session']).sort(), Object.keys(snapshot.runtimeById['headless-session']).sort());
  assert.equal(snapshot.runtimeById['desktop-session'].source, 'desktop-ipc');
  assert.equal(snapshot.runtimeById['headless-session'].source, 'headless-local');
});

test('assistant plan updates preserve plan implementation metadata', () => {
  const event = createSyncEvent('message.assistant.completed', {
    sessionId: 'session-1',
    turnId: 'turn-1',
    itemId: 'implement-plan:app-turn-1'
  }, {
    message: {
      id: 'implement-plan:app-turn-1',
      role: 'assistant',
      content: '<proposed_plan>\n# 修复计划\n</proposed_plan>',
      planImplementation: {
        requestId: 'implement-plan:app-turn-1',
        turnId: 'app-turn-1',
        planContent: '# 修复计划',
        completed: false
      }
    }
  });

  assert.equal(event.eventType, 'message.assistant.completed');
  assert.deepEqual(event.message.planImplementation, {
    requestId: 'implement-plan:app-turn-1',
    turnId: 'app-turn-1',
    planContent: '# 修复计划',
    completed: false
  });
});

test('interaction request sync events remain non-runtime and keep interaction details', () => {
  const requested = createSyncEvent('interaction.requested', {
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1'
  }, {
    interaction: {
      id: 'interaction-1',
      kind: 'user_input',
      title: '检查方式',
      questions: [{ id: 'check_method', question: '怎么检查？', options: [] }]
    }
  });

  assert.equal(requested.eventType, 'interaction.requested');
  assert.equal(requested.interaction.id, 'interaction-1');
  assert.equal(requested.interaction.questions[0].id, 'check_method');

  const store = createSyncStore();
  store.applyEvent(requested);
  assert.deepEqual(store.snapshot().runtimeById, {});

  const resolved = createSyncEvent('interaction.resolved', {
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'completed'
  }, {
    interactionId: 'interaction-1'
  });
  assert.equal(resolved.eventType, 'interaction.resolved');
  assert.equal(resolved.interactionId, 'interaction-1');
});

test('sessions synced and rename events update sidebar projection data', () => {
  const store = createSyncStore();
  const synced = createSyncEvent('sessions.synced', {
    syncedAt: '2026-05-13T01:00:00.000Z'
  }, {
    syncedAt: '2026-05-13T01:00:00.000Z',
    projects: [
      {
        id: 'project-1',
        name: '普通对话',
        sessions: [{ id: 'session-1', title: '旧标题' }]
      }
    ]
  });
  store.applyEvent(synced);
  const renamed = createSyncEvent('thread.renamed', {
    projectId: 'project-1',
    sessionId: 'session-1'
  }, {
    title: '新标题'
  });
  store.applyEvent(renamed);
  assert.equal(store.snapshot().projects[0].sessions[0].title, '新标题');
});

test('thread updates without an explicit runtime status do not create running state', () => {
  const store = createSyncStore();
  const event = createSyncEvent('thread.updated', {
    source: 'desktop-ipc',
    sessionId: 'session-1'
  });
  assert.equal(event.eventType, 'thread.updated');
  store.applyEvent(event);
  assert.deepEqual(store.snapshot().runtimeById, {});
});

test('model updates keep thread scope in sync state', () => {
  const store = createSyncStore();
  const event = createSyncEvent('model.updated', {
    source: 'desktop-thread',
    sessionId: 'session-1',
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    provider: 'openai'
  }, {
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    provider: 'openai'
  });

  store.applyEvent(event);

  assert.deepEqual(store.snapshot().modelSettings, {
    provider: 'openai',
    model: 'gpt-5.4',
    modelShort: null,
    reasoningEffort: 'medium',
    sessionId: 'session-1',
    updatedAt: event.timestamp,
    source: 'desktop-thread',
    desktopSync: null
  });
});
