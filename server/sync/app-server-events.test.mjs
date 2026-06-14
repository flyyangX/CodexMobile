/**
 * 测试 server/sync/app-server-events.js：官方 app-server v2 消息到 SyncEvent 的映射。
 *
 * Keywords: app-server-v2, sync-event, thread, turn, item
 *
 * Exports: 无导出 / 内含用例。
 *
 * Inward: app-server-events.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppServerMessageToSyncEvents } from './app-server-events.js';

const context = {
  source: 'headless-local',
  sessionId: 'thread-1',
  previousSessionId: 'draft-1',
  draftSessionId: 'draft-1',
  turnId: 'client-turn-1',
  clientTurnId: 'client-turn-1',
  appTurnId: 'app-turn-1',
  agentMessages: new Map(),
  items: new Map()
};

test('thread and turn notifications become protocol-marked runtime events', () => {
  const [threadStarted] = normalizeAppServerMessageToSyncEvents({
    method: 'thread/started',
    params: { thread: { id: 'thread-2', title: '新线程' } }
  }, context);
  assert.equal(threadStarted.eventType, 'thread.started');
  assert.equal(threadStarted.protocol, 'app-server-v2');
  assert.equal(threadStarted.appMethod, 'thread/started');
  assert.equal(threadStarted.sessionId, 'thread-2');
  assert.equal(threadStarted.previousSessionId, 'draft-1');

  const [turnStarted] = normalizeAppServerMessageToSyncEvents({
    method: 'turn/started',
    params: { threadId: 'thread-2', turn: { id: 'app-turn-2' } }
  }, { ...context, sessionId: 'thread-2' });
  assert.equal(turnStarted.eventType, 'turn.running');
  assert.equal(turnStarted.turnId, 'client-turn-1');
  assert.equal(turnStarted.appTurnId, 'app-turn-2');
  assert.equal(turnStarted.status, 'running');
});

test('agent message deltas and completed items preserve item identity and phase', () => {
  const state = {
    ...context,
    agentMessages: new Map([['msg-1', '你好']]),
    items: new Map([['msg-1', { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' }]])
  };
  const [delta] = normalizeAppServerMessageToSyncEvents({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', itemId: 'msg-1', delta: '，世界' }
  }, state);

  assert.equal(delta.eventType, 'message.assistant.delta');
  assert.equal(delta.itemId, 'msg-1');
  assert.equal(delta.itemType, 'agentMessage');
  assert.equal(delta.message.content, '你好，世界');
  assert.equal(delta.message.phase, 'final_answer');
  assert.equal(delta.message.done, false);

  const [completed] = normalizeAppServerMessageToSyncEvents({
    method: 'item/completed',
    params: { threadId: 'thread-1', item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: '你好，世界' } }
  }, state);
  assert.equal(completed.eventType, 'message.assistant.completed');
  assert.equal(completed.message.done, true);
});

test('tool items become activity events and terminal turns clear app turn keys', () => {
  const [activity] = normalizeAppServerMessageToSyncEvents({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        status: 'completed',
        command: 'npm test',
        aggregatedOutput: 'ok'
      }
    }
  }, context);
  assert.equal(activity.eventType, 'activity.completed');
  assert.equal(activity.itemId, 'cmd-1');
  assert.equal(activity.itemType, 'commandExecution');
  assert.equal(activity.activity.kind, 'command_execution');
  assert.equal(activity.activity.detail, 'npm test');
  assert.equal(activity.activity.output, 'ok');

  const [completed] = normalizeAppServerMessageToSyncEvents({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'app-turn-1', status: 'completed' } }
  }, context);
  assert.equal(completed.eventType, 'turn.completed');
  assert.equal(completed.turnId, 'client-turn-1');
  assert.equal(completed.appTurnId, 'app-turn-1');
});

test('approval and user input requests become interaction events with stable ids', () => {
  const [interaction] = normalizeAppServerMessageToSyncEvents({
    id: 42,
    method: 'item/tool/requestUserInput',
    params: {
      title: '选择检查方式',
      questions: [{ id: 'check_method', question: '怎么检查？' }]
    }
  }, context);

  assert.equal(interaction.eventType, 'interaction.requested');
  assert.equal(interaction.protocol, 'app-server-v2');
  assert.equal(interaction.interaction.id, 'interaction-42');
  assert.equal(interaction.interaction.appRequestId, '42');
  assert.equal(interaction.interaction.kind, 'user_input');
  assert.equal(interaction.interaction.params.questions[0].id, 'check_method');
});
