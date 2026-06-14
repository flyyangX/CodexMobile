/**
 * Web Push：订阅持久化、VAPID 配置与向客户端推送「需要输入」类通知。
 *
 * Keywords: web-push, vapid, notification, subscription
 *
 * Exports:
 * - notificationFromServerPayload — 规范推送展示字段。
 * - createPushService — 工厂，封装 web-push。
 *
 * Inward（本模块依赖/组装的关键符号）: web-push 包、本地 state 文件路径。
 *
 * Outward（谁在用/调用场景）: notification-routes、chat/codex 事件广播。
 *
 * 不负责: APNs/FCM 原生推送。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import webPushDefault from 'web-push';

const NEEDS_INPUT_PATTERN = /(需要.*(输入|确认|授权|允许|处理)|等待.*(用户|确认)|approval|permission|confirm|blocked|needs.*input|user.*input)/i;
const GONE_STATUS_CODES = new Set([404, 410]);

function normalizeSubscription(subscription = {}) {
  const endpoint = String(subscription?.endpoint || '').trim();
  const keys = subscription?.keys && typeof subscription.keys === 'object' ? subscription.keys : {};
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) {
    const error = new Error('Invalid push subscription');
    error.statusCode = 400;
    throw error;
  }
  return {
    endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: { p256dh, auth }
  };
}

function needsUserInput(payload = {}) {
  const event = payload.type === 'sync-event' ? payload.event || {} : payload;
  const activity = event.activity || {};
  const interaction = event.interaction || {};
  const text = [
    payload.type,
    event.eventType,
    event.status,
    event.itemType,
    event.label,
    event.detail,
    event.message?.content,
    event.error,
    activity.kind,
    activity.label,
    activity.detail,
    interaction.title,
    interaction.prompt
  ].filter(Boolean).join(' ');
  return NEEDS_INPUT_PATTERN.test(text);
}

export function notificationFromServerPayload(payload = {}) {
  const event = payload.type === 'sync-event' ? payload.event || {} : {};
  if (event.eventType === 'turn.completed') {
    return {
      level: 'success',
      title: '任务已完成',
      body: event.detail || 'Codex 已处理完当前任务。'
    };
  }
  if (event.eventType === 'turn.failed') {
    return {
      level: 'error',
      title: '任务失败',
      body: event.error || event.detail || 'Codex 执行时遇到错误。'
    };
  }
  if (event.eventType === 'turn.aborted') {
    return {
      level: 'info',
      title: '任务已中止',
      body: event.detail || '当前任务已经停下。'
    };
  }
  if ((event.eventType === 'interaction.requested' || needsUserInput(payload)) && event.eventType !== 'message.assistant.delta') {
    return {
      level: 'warning',
      title: '需要处理',
      body: event.label || event.detail || event.interaction?.title || 'Codex 正在等待你的确认或输入。'
    };
  }
  return null;
}

export function createPushService({
  statePath,
  subject = 'mailto:codexmobile@localhost',
  webPush = webPushDefault,
  now = () => new Date().toISOString()
} = {}) {
  if (!statePath) {
    throw new Error('statePath is required');
  }

  let statePromise = null;
  let state = null;

  async function saveState() {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async function loadState() {
    if (state) {
      return state;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
      state = {
        publicKey: String(parsed?.publicKey || ''),
        privateKey: String(parsed?.privateKey || ''),
        subscriptions: Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[push] Failed to read push state:', error.message);
      }
      state = { publicKey: '', privateKey: '', subscriptions: [] };
    }
    if (!state.publicKey || !state.privateKey) {
      const keys = webPush.generateVAPIDKeys();
      state.publicKey = keys.publicKey;
      state.privateKey = keys.privateKey;
      await saveState();
    }
    webPush.setVapidDetails(subject, state.publicKey, state.privateKey);
    return state;
  }

  function ensureState() {
    if (!statePromise) {
      statePromise = loadState();
    }
    return statePromise;
  }

  async function publicStatus() {
    const current = await ensureState();
    return {
      supported: true,
      publicKey: current.publicKey,
      subscriptions: current.subscriptions.length
    };
  }

  async function subscribe(subscription) {
    const normalized = normalizeSubscription(subscription);
    const current = await ensureState();
    const index = current.subscriptions.findIndex((item) => item.endpoint === normalized.endpoint);
    const saved = {
      ...normalized,
      createdAt: index >= 0 ? current.subscriptions[index].createdAt : now(),
      updatedAt: now()
    };
    if (index >= 0) {
      current.subscriptions[index] = saved;
    } else {
      current.subscriptions.push(saved);
    }
    await saveState();
    return { subscriptions: current.subscriptions.length };
  }

  async function unsubscribe(endpoint) {
    const value = String(endpoint || '').trim();
    const current = await ensureState();
    const before = current.subscriptions.length;
    current.subscriptions = current.subscriptions.filter((item) => item.endpoint !== value);
    if (current.subscriptions.length !== before) {
      await saveState();
    }
    return { subscriptions: current.subscriptions.length, removed: before - current.subscriptions.length };
  }

  async function sendNotification(notification = {}) {
    const current = await ensureState();
    const subscriptions = [...current.subscriptions];
    if (!subscriptions.length) {
      return { attempted: 0, sent: 0, failed: 0, removed: 0 };
    }
    const payload = JSON.stringify({
      title: notification.title || 'CodexMobile',
      body: notification.body || '',
      level: notification.level || 'info',
      tag: notification.tag || `codexmobile-${notification.title || 'notification'}`,
      url: notification.url || '/'
    });
    let sent = 0;
    let failed = 0;
    const gone = new Set();
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, payload);
        sent += 1;
      } catch (error) {
        failed += 1;
        if (GONE_STATUS_CODES.has(Number(error?.statusCode))) {
          gone.add(subscription.endpoint);
        } else {
          console.warn('[push] Failed to send notification:', error.message);
        }
      }
    }));
    if (gone.size) {
      current.subscriptions = current.subscriptions.filter((item) => !gone.has(item.endpoint));
      await saveState();
    }
    return {
      attempted: subscriptions.length,
      sent,
      failed,
      removed: gone.size
    };
  }

  async function notifyForPayload(payload) {
    const notification = notificationFromServerPayload(payload);
    if (!notification) {
      return null;
    }
    return sendNotification({
      ...notification,
      tag: `codexmobile-${payload.type || notification.title}`,
      url: '/'
    });
  }

  return {
    publicStatus,
    subscribe,
    unsubscribe,
    sendNotification,
    notifyForPayload
  };
}
