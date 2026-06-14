/**
 * 测试 client/src/sync/sync-reducer.js：统一同步事件对前端 runtime map 的影响。
 *
 * Keywords: sync-reducer, runtime, terminal
 *
 * Exports: 无导出 / 内含用例。
 *
 * Inward: client/src/sync/sync-reducer.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySyncRuntimeEvent,
  mergeSyncStateRuntime,
  sessionMatchesSyncEvent,
  syncEventRunKeys
} from './sync-reducer.js';

test('completed turn clears every runtime key for a mobile submitted turn', () => {
  const running = applySyncRuntimeEvent({}, {
    eventType: 'turn.running',
    protocol: 'app-server-v2',
    source: 'desktop-ipc',
    sessionId: 'session-1',
    turnId: 'desktop-turn',
    clientTurnId: 'mobile-turn',
    appTurnId: 'app-turn',
    timestamp: '2026-05-13T01:00:00.000Z'
  });
  assert.equal(running['session-1'].status, 'running');
  assert.equal(running['mobile-turn'].source, 'desktop-ipc');
  assert.equal(running['app-turn'].protocol, 'app-server-v2');

  const completed = applySyncRuntimeEvent(running, {
    eventType: 'turn.completed',
    source: 'desktop-ipc',
    sessionId: 'session-1',
    turnId: 'desktop-turn',
    clientTurnId: 'mobile-turn',
    appTurnId: 'app-turn',
    timestamp: '2026-05-13T01:01:00.000Z'
  });
  assert.deepEqual(completed, {});
});

test('running runtime keeps one stable startedAt across process updates', () => {
  const initial = applySyncRuntimeEvent({}, {
    eventType: 'turn.running',
    source: 'headless-local',
    sessionId: 'session-1',
    turnId: 'turn-1',
    timestamp: '2026-05-13T01:00:00.000Z'
  });
  const updated = applySyncRuntimeEvent(initial, {
    eventType: 'turn.running',
    source: 'headless-local',
    sessionId: 'session-1',
    turnId: 'turn-1',
    label: '正在运行命令',
    timestamp: '2026-05-13T01:00:30.000Z'
  });

  assert.equal(updated['session-1'].startedAt, '2026-05-13T01:00:00.000Z');
  assert.equal(updated['session-1'].updatedAt, '2026-05-13T01:00:30.000Z');
});

test('running runtime propagates startedAt when later events add session keys', () => {
  const initial = applySyncRuntimeEvent({}, {
    eventType: 'turn.running',
    source: 'headless-local',
    clientTurnId: 'client-1',
    timestamp: '2026-05-13T01:00:00.000Z'
  });
  const expanded = applySyncRuntimeEvent(initial, {
    eventType: 'turn.running',
    source: 'headless-local',
    sessionId: 'session-1',
    turnId: 'turn-1',
    clientTurnId: 'client-1',
    timestamp: '2026-05-13T01:00:20.000Z'
  });

  assert.equal(expanded['session-1'].startedAt, '2026-05-13T01:00:00.000Z');
  assert.equal(expanded['turn-1'].startedAt, '2026-05-13T01:00:00.000Z');
  assert.equal(expanded['client-1'].startedAt, '2026-05-13T01:00:00.000Z');
});

test('queued send switches to running with a fresh execution startedAt', () => {
  const queued = applySyncRuntimeEvent({}, {
    eventType: 'turn.queued',
    status: 'queued',
    source: 'local-optimistic',
    sessionId: 'session-1',
    turnId: 'turn-1',
    label: '消息发送中',
    timestamp: '2026-05-13T01:00:00.000Z'
  });
  const running = applySyncRuntimeEvent(queued, {
    eventType: 'turn.running',
    source: 'headless-local',
    sessionId: 'session-1',
    turnId: 'turn-1',
    timestamp: '2026-05-13T01:00:02.000Z'
  });

  assert.equal(running['session-1'].status, 'running');
  assert.equal(running['session-1'].startedAt, '2026-05-13T01:00:02.000Z');
});

test('sync-state snapshots preserve active runtime startedAt', () => {
  const next = mergeSyncStateRuntime(
    {
      'client-1': {
        status: 'running',
        source: 'headless-local',
        startedAt: '2026-05-13T01:00:00.000Z',
        updatedAt: '2026-05-13T01:00:00.000Z'
      }
    },
    {
      runtimeById: {
        'session-1': {
          status: 'running',
          source: 'headless-local',
          startedAt: '2026-05-13T01:00:25.000Z',
          updatedAt: '2026-05-13T01:00:25.000Z'
        },
        'client-1': {
          status: 'running',
          source: 'headless-local',
          startedAt: '2026-05-13T01:00:25.000Z',
          updatedAt: '2026-05-13T01:00:25.000Z'
        }
      }
    }
  );

  assert.equal(next['session-1'].startedAt, '2026-05-13T01:00:00.000Z');
  assert.equal(next['client-1'].startedAt, '2026-05-13T01:00:00.000Z');
  assert.equal(next['session-1'].updatedAt, '2026-05-13T01:00:25.000Z');
});

test('sync-state replaces stale sync-owned runtime and removes local handoff runtime', () => {
  const next = mergeSyncStateRuntime(
    {
      stale: { status: 'running', source: 'desktop-ipc' },
      local: { status: 'running', source: 'local-handoff' }
    },
    {
      runtimeById: {
        fresh: { status: 'running', source: 'headless-local' }
      }
    }
  );
  assert.equal(next.stale, undefined);
  assert.equal(next.local, undefined);
  assert.equal(next.fresh.source, 'headless-local');
});

test('session matching accepts session, turn, client turn, previous, and draft ids', () => {
  const event = {
    eventType: 'turn.running',
    sessionId: 'session-1',
    turnId: 'turn-1',
    clientTurnId: 'client-1',
    appTurnId: 'app-1',
    previousSessionId: 'previous-1',
    draftSessionId: 'draft-1'
  };
  assert.deepEqual(syncEventRunKeys(event), ['turn-1', 'client-1', 'app-1', 'session-1', 'previous-1', 'draft-1']);
  assert.equal(sessionMatchesSyncEvent({ id: 'session-1' }, event), true);
  assert.equal(sessionMatchesSyncEvent({ turnId: 'client-1' }, event), true);
  assert.equal(sessionMatchesSyncEvent({ id: 'other' }, event), false);
});
