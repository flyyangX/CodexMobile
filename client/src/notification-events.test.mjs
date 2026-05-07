import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notificationFromPayload,
  payloadNeedsUserInput,
  shouldUseWebNotification
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
