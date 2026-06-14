/**
 * 测试 server/chat-auto-title.js：自动命名刷新、广播与会话锁定位。
 *
 * Keywords: chat-auto-title, test
 *
 * Exports: 无导出，内含用例
 *
 * Inward: chat-auto-title.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatAutoNamer } from './chat-auto-title.js';

test('chat auto namer refreshes, renames unlocked sessions, and broadcasts sessions synced', async () => {
  const calls = [];
  const broadcasts = [];
  const namer = createChatAutoNamer({
    getTurn: (turnId) => {
      calls.push(['getTurn', turnId]);
      return { assistantPreview: '解释了这条线程的自动命名流程。' };
    },
    refreshCodexCache: async () => {
      calls.push(['refresh']);
      return { syncedAt: `sync-${calls.filter((call) => call[0] === 'refresh').length}`, projects: [{ id: 'project-1' }] };
    },
    getSession: (sessionId) => {
      calls.push(['getSession', sessionId]);
      return { id: sessionId, projectId: 'project-1', title: '旧标题', titleLocked: false };
    },
    maybeAutoNameSession: async ({ session, userMessage, assistantMessage, renameSessionImpl }) => {
      calls.push(['maybeAutoNameSession', session.id, userMessage, assistantMessage, typeof renameSessionImpl]);
      return { ...session, title: '自动命名标题' };
    },
    renameSession: async () => {
      throw new Error('rename is delegated to maybeAutoNameSession in this test');
    },
    broadcast: (payload) => broadcasts.push(payload)
  });

  await namer.autoNameCompletedSession({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    userMessage: '帮我看一下线程自动命名怎么实现'
  });

  assert.deepEqual(calls, [
    ['getTurn', 'turn-1'],
    ['refresh'],
    ['getSession', 'thread-1'],
    ['maybeAutoNameSession', 'thread-1', '帮我看一下线程自动命名怎么实现', '解释了这条线程的自动命名流程。', 'function'],
    ['refresh']
  ]);
  assert.equal(broadcasts[0].type, 'sync-event');
  assert.equal(broadcasts[0].event.eventType, 'sessions.synced');
  assert.equal(broadcasts[0].event.syncedAt, 'sync-2');
  assert.deepEqual(broadcasts[0].event.projects, [{ id: 'project-1' }]);
});

test('chat auto namer skips missing content and locked sessions without renaming', async () => {
  const noContentCalls = [];
  const noContentNamer = createChatAutoNamer({
    getTurn: () => {
      noContentCalls.push('getTurn');
      return { assistantPreview: '' };
    },
    refreshCodexCache: async () => noContentCalls.push('refresh'),
    getSession: () => noContentCalls.push('getSession'),
    maybeAutoNameSession: async () => noContentCalls.push('maybeAutoNameSession'),
    renameSession: async () => null,
    broadcast: () => noContentCalls.push('broadcast')
  });

  await noContentNamer.autoNameCompletedSession({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    userMessage: ''
  });
  assert.deepEqual(noContentCalls, ['getTurn']);

  const lockedCalls = [];
  const lockedNamer = createChatAutoNamer({
    getTurn: () => ({ assistantPreview: '有回答内容' }),
    refreshCodexCache: async () => {
      lockedCalls.push('refresh');
      return { syncedAt: 'sync-1', projects: [] };
    },
    getSession: () => {
      lockedCalls.push('getSession');
      return { id: 'thread-1', titleLocked: true };
    },
    maybeAutoNameSession: async () => lockedCalls.push('maybeAutoNameSession'),
    renameSession: async () => null,
    broadcast: () => lockedCalls.push('broadcast')
  });

  await lockedNamer.autoNameCompletedSession({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    userMessage: '用户消息'
  });
  assert.deepEqual(lockedCalls, ['refresh', 'getSession']);
});

test('chat auto namer schedule catches failures and logs them', async () => {
  const warnings = [];
  const namer = createChatAutoNamer({
    getTurn: () => ({ assistantPreview: 'assistant' }),
    refreshCodexCache: async () => {
      throw new Error('refresh failed');
    },
    getSession: () => ({ id: 'thread-1', titleLocked: false }),
    maybeAutoNameSession: async () => null,
    renameSession: async () => null,
    broadcast: () => null,
    logger: { warn: (...args) => warnings.push(args) }
  });

  namer.scheduleAutoNameCompletedSession({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    userMessage: 'hello'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[title] auto naming failed:');
  assert.equal(warnings[0][1], 'refresh failed');
});
