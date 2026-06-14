/**
 * 测试 app/useAppWebSocket.js：各类 WS 载荷是否应刷新线程或渲染本地消息。
 * Keywords: websocket, payload-guards, tests
 * Exports: 无导出 / 内含用例
 * Inward: app/useAppWebSocket.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldCompleteLocalTurnBeforeRefresh,
  shouldRefreshDesktopThreadForPayload,
  shouldRefreshCurrentSessionAfterReconnect,
  shouldRenderActivityMessageForPayload,
  shouldRenderAssistantMessageForPayload,
  shouldRenderStatusMessageForPayload
} from './app/useAppWebSocket.js';

test('desktop IPC sync events render through the unified sync path', () => {
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'sync-event',
      event: {
        eventType: 'turn.running',
        source: 'desktop-ipc',
        status: 'running'
      }
    }),
    false
  );
});

test('sync status events never render directly outside the sync reducer', () => {
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'sync-event',
      event: { eventType: 'turn.completed', source: 'desktop-ipc', status: 'completed' }
    }),
    false
  );
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'sync-event',
      event: { eventType: 'turn.running', source: 'headless-local', status: 'running' }
    }),
    false
  );
  assert.equal(
    shouldRenderStatusMessageForPayload({
      type: 'sync-event',
      event: { eventType: 'activity.updated', source: 'headless-local', itemType: 'reasoning' }
    }),
    false
  );
});

test('terminal events no longer trigger desktop-thread refresh path', () => {
  assert.equal(
    shouldRefreshDesktopThreadForPayload({
      type: 'sync-event',
      event: { eventType: 'turn.completed', source: 'desktop-ipc' }
    }),
    false
  );
  assert.equal(
    shouldRefreshDesktopThreadForPayload({
      type: 'sync-event',
      event: { eventType: 'turn.completed', source: 'desktop-ipc' }
    }),
    false
  );
  assert.equal(
    shouldRefreshDesktopThreadForPayload({
      type: 'sync-event',
      event: { eventType: 'turn.completed', source: 'headless-local' }
    }),
    false
  );
  assert.equal(
    shouldCompleteLocalTurnBeforeRefresh({
      type: 'sync-event',
      event: { eventType: 'turn.completed', source: 'desktop-ipc' }
    }),
    false
  );
  assert.equal(
    shouldCompleteLocalTurnBeforeRefresh({
      type: 'sync-event',
      event: { eventType: 'turn.completed', source: 'desktop-ipc' }
    }),
    false
  );
  assert.equal(
    shouldCompleteLocalTurnBeforeRefresh({
      type: 'sync-event',
      event: { eventType: 'turn.failed', source: 'desktop-ipc' }
    }),
    false
  );
});

test('activity and assistant sync events no longer render directly', () => {
  assert.equal(
    shouldRenderActivityMessageForPayload({
      type: 'sync-event',
      event: { eventType: 'activity.updated', source: 'headless-local', status: 'running' }
    }),
    false
  );
  assert.equal(
    shouldRenderAssistantMessageForPayload({
      type: 'sync-event',
      event: { eventType: 'message.assistant.completed', source: 'headless-local', message: { content: '完成' } }
    }),
    false
  );
  assert.equal(
    shouldRenderActivityMessageForPayload({
      type: 'sync-event',
      event: { eventType: 'activity.updated', status: 'running' }
    }),
    false
  );
});

test('websocket reconnect refresh skips drafts and restores real selected sessions', () => {
  assert.equal(shouldRefreshCurrentSessionAfterReconnect({ id: 'thread-1' }), true);
  assert.equal(shouldRefreshCurrentSessionAfterReconnect({ id: 'draft-project-1' }), false);
  assert.equal(shouldRefreshCurrentSessionAfterReconnect(null), false);
});
