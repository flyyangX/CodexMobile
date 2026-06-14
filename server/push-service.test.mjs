/**
 * 测试 server/push-service.js：订阅校验、落盘与 notification 载荷。
 *
 * Keywords: push-service, test, web-push
 *
 * Exports: 无导出，内含用例
 *
 * Inward: push-service.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPushService, notificationFromServerPayload } from './push-service.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-push-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeWebPush(overrides = {}) {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys() {
      return { publicKey: 'public-key', privateKey: 'private-key' };
    },
    setVapidDetails(subject, publicKey, privateKey) {
      this.vapid = { subject, publicKey, privateKey };
    },
    async sendNotification(subscription, payload) {
      sent.push({ subscription, payload: JSON.parse(payload) });
      if (overrides.failGone) {
        const error = new Error('gone');
        error.statusCode = 410;
        throw error;
      }
      return { statusCode: 201 };
    }
  };
}

test('push service creates VAPID keys and persists unique subscriptions', async () => {
  await withTempDir(async (dir) => {
    const webPush = fakeWebPush();
    const service = createPushService({
      statePath: path.join(dir, 'push.json'),
      subject: 'mailto:test@example.com',
      webPush
    });

    assert.equal((await service.publicStatus()).publicKey, 'public-key');
    await service.subscribe({
      endpoint: 'https://push.example/one',
      keys: { p256dh: 'p256dh', auth: 'auth' }
    });
    await service.subscribe({
      endpoint: 'https://push.example/one',
      keys: { p256dh: 'new', auth: 'new' }
    });

    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'push.json'), 'utf8'));
    assert.equal(persisted.publicKey, 'public-key');
    assert.equal(persisted.subscriptions.length, 1);
    assert.equal(persisted.subscriptions[0].keys.p256dh, 'new');
    assert.deepEqual(webPush.vapid, {
      subject: 'mailto:test@example.com',
      publicKey: 'public-key',
      privateKey: 'private-key'
    });
  });
});

test('push service sends notifications and removes gone subscriptions', async () => {
  await withTempDir(async (dir) => {
    const webPush = fakeWebPush({ failGone: true });
    const service = createPushService({
      statePath: path.join(dir, 'push.json'),
      webPush
    });
    await service.subscribe({
      endpoint: 'https://push.example/gone',
      keys: { p256dh: 'p256dh', auth: 'auth' }
    });

    const result = await service.sendNotification({ title: '任务已完成', body: 'Codex 已完成任务。' });

    assert.equal(result.attempted, 1);
    assert.equal(result.sent, 0);
    assert.equal(result.removed, 1);
    assert.equal((await service.publicStatus()).subscriptions, 0);
  });
});

test('notificationFromServerPayload maps completion, failure, and user-input events', () => {
  assert.deepEqual(notificationFromServerPayload({ type: 'sync-event', event: { eventType: 'turn.completed' } }), {
    level: 'success',
    title: '任务已完成',
    body: 'Codex 已处理完当前任务。'
  });
  assert.equal(
    notificationFromServerPayload({
      type: 'sync-event',
      event: { eventType: 'interaction.requested', label: '等待用户确认权限' }
    }).title,
    '需要处理'
  );
  assert.equal(
    notificationFromServerPayload({
      type: 'sync-event',
      event: { eventType: 'activity.updated', activity: { label: '正在同步回复' } }
    }),
    null
  );
  assert.equal(notificationFromServerPayload({ type: 'sync-event', event: { eventType: 'turn.failed', detail: 'boom' } }).body, 'boom');
});
