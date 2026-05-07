import assert from 'node:assert/strict';
import test from 'node:test';
import {
  markUserInputMessageResolved,
  mergePendingUserInputMessages,
  notificationFromPayload,
  payloadNeedsUserInput,
  shouldUseWebNotification,
  upsertUserInputMessage
} from './notification-events.js';

test('notificationFromPayload creates completion and failure toasts', () => {
  assert.deepEqual(notificationFromPayload({ type: 'chat-complete' }), {
    level: 'success',
    title: '任务已完成',
    body: 'Codex 已处理完当前任务。'
  });
  assert.deepEqual(notificationFromPayload({ type: 'chat-error', error: 'boom' }), {
    level: 'error',
    title: '任务失败',
    body: 'boom'
  });
});

test('payloadNeedsUserInput detects approval style status without matching normal streaming', () => {
  assert.equal(payloadNeedsUserInput({ type: 'status-update', label: '需要你确认权限' }), true);
  assert.equal(payloadNeedsUserInput({ type: 'activity-update', detail: 'waiting for user input' }), true);
  assert.equal(payloadNeedsUserInput({ type: 'status-update', label: '正在同步回复', status: 'running' }), false);
});

test('shouldUseWebNotification only fires when permission and context allow it', () => {
  assert.equal(shouldUseWebNotification({ enabled: true, permission: 'granted', visibilityState: 'hidden' }), true);
  assert.equal(shouldUseWebNotification({ enabled: true, permission: 'granted', visibilityState: 'visible', standalone: true }), true);
  assert.equal(shouldUseWebNotification({ enabled: true, permission: 'default', visibilityState: 'hidden' }), false);
  assert.equal(shouldUseWebNotification({ enabled: false, permission: 'granted', visibilityState: 'hidden' }), false);
});

test('notificationFromPayload warns for explicit user input requests', () => {
  const notification = notificationFromPayload({
    type: 'user-input-request',
    questions: [{ question: '选择方案' }]
  });

  assert.equal(notification.level, 'warning');
  assert.equal(notification.title, '需要处理');
});

test('mergePendingUserInputMessages injects pending cards for the selected session', () => {
  const messages = [{ id: 'assistant-1', role: 'assistant', content: '先前回复' }];
  const pending = {
    'thread-2:turn-2:item-2': {
      type: 'user-input-request',
      threadId: 'thread-2',
      turnId: 'turn-2',
      itemId: 'item-2',
      questions: [{ id: 'choice', question: '选择方案' }]
    },
    'thread-1:turn-1:item-1': {
      type: 'user-input-request',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{ id: 'approval', question: '继续吗' }]
    }
  };

  const merged = mergePendingUserInputMessages(messages, pending, { id: 'thread-1' });

  assert.deepEqual(merged.map((message) => message.id), [
    'assistant-1',
    'user-input-thread-1-turn-1-item-1'
  ]);
  assert.equal(merged[1].role, 'user_input_request');
  assert.equal(merged[1].status, 'pending');
});

test('upsertUserInputMessage preserves explicit desktop metadata', () => {
  const next = upsertUserInputMessage([], {
    type: 'user-input-request',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    conversationId: 'conversation-1',
    transport: 'desktop-ipc',
    delivery: 'desktop-ipc',
    questions: [{ id: 'choice', question: '选择方案' }]
  });

  assert.equal(next[0].conversationId, 'conversation-1');
  assert.equal(next[0].transport, 'desktop-ipc');
  assert.equal(next[0].delivery, 'desktop-ipc');
});

test('markUserInputMessageResolved marks a submitted card answered locally', () => {
  const messages = [
    {
      id: 'user-input-thread-1-turn-1-item-1',
      role: 'user_input_request',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      status: 'pending',
      error: 'old'
    }
  ];

  const next = markUserInputMessageResolved(messages, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1'
  });

  assert.equal(next[0].status, 'answered');
  assert.equal(next[0].error, '');
});
