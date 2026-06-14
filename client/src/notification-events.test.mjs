/**
 * 测试 notification-events.js：通知载荷解析与是否走系统通知判定。
 * Keywords: notifications, payload, tests
 * Exports: 无导出 / 内含用例
 * Inward: notification-events.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notificationFromPayload,
  payloadNeedsUserInput,
  shouldUseWebNotification
} from './notification-events.js';

test('notificationFromPayload creates completion and failure toasts', () => {
  assert.deepEqual(notificationFromPayload({ type: 'sync-event', event: { eventType: 'turn.completed' } }), {
    level: 'success',
    title: '任务已完成',
    body: 'Codex 已处理完当前任务。'
  });
  assert.deepEqual(notificationFromPayload({ type: 'sync-event', event: { eventType: 'turn.failed', detail: 'boom' } }), {
    level: 'error',
    title: '任务失败',
    body: 'boom'
  });
});

test('payloadNeedsUserInput detects approval style status without matching normal streaming', () => {
  assert.equal(payloadNeedsUserInput({ type: 'sync-event', event: { eventType: 'interaction.requested', label: '需要你确认权限' } }), true);
  assert.equal(payloadNeedsUserInput({ type: 'sync-event', event: { eventType: 'activity.updated', detail: 'waiting for user input' } }), true);
  assert.equal(payloadNeedsUserInput({ type: 'sync-event', event: { eventType: 'activity.updated', label: '正在同步回复', status: 'running' } }), false);
});

test('shouldUseWebNotification only fires when permission and context allow it', () => {
  assert.equal(shouldUseWebNotification({ enabled: true, permission: 'granted', visibilityState: 'hidden' }), true);
  assert.equal(shouldUseWebNotification({ enabled: true, permission: 'granted', visibilityState: 'visible', standalone: true }), true);
  assert.equal(shouldUseWebNotification({ enabled: true, permission: 'default', visibilityState: 'hidden' }), false);
  assert.equal(shouldUseWebNotification({ enabled: false, permission: 'granted', visibilityState: 'hidden' }), false);
});
