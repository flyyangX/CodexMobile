/**
 * 浏览器通知偏好、PWA 判定、载荷是否需要用户介入及 Toast/通知正文映射。
 *
 * Keywords: notifications, preferences, PWA, payload, user-input
 *
 * Exports:
 * - NOTIFICATION_PREF_KEY — localStorage 键。
 * - browserNotificationPermission / browserNotificationsSupported — 能力探测。
 * - notificationPreferenceEnabled / setNotificationPreferenceEnabled — 用户开关持久化。
 * - isStandalonePwa / shouldUseWebNotification — 环境判断。
 * - payloadNeedsUserInput / notificationFromPayload — 服务端事件到 UI 文案。
 *
 * Inward: 无外部模块。
 *
 * Outward: useNotifications、WebSocket 聊天完成/错误处理。
 */

export const NOTIFICATION_PREF_KEY = 'codexmobile.notificationsEnabled';

const NEEDS_INPUT_PATTERN = /(需要.*(输入|确认|授权|允许|处理)|等待.*(用户|确认)|approval|permission|confirm|blocked|needs.*input|user.*input)/i;

export function browserNotificationPermission(win = globalThis.window) {
  const notification = win?.Notification || globalThis.Notification;
  return notification?.permission || 'unsupported';
}

export function browserNotificationsSupported(win = globalThis.window) {
  const notification = win?.Notification || globalThis.Notification;
  return typeof notification === 'function' && typeof notification.requestPermission === 'function';
}

export function notificationPreferenceEnabled(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(NOTIFICATION_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function setNotificationPreferenceEnabled(enabled, storage = globalThis.localStorage) {
  try {
    storage?.setItem(NOTIFICATION_PREF_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage failures in private browsing.
  }
}

export function isStandalonePwa(win = globalThis.window) {
  return Boolean(
    win?.matchMedia?.('(display-mode: standalone)')?.matches ||
    win?.navigator?.standalone
  );
}

export function shouldUseWebNotification({
  permission = 'default',
  enabled = false,
  visibilityState = 'visible',
  standalone = false
} = {}) {
  return enabled && permission === 'granted' && (visibilityState === 'hidden' || standalone);
}

export function payloadNeedsUserInput(payload = {}) {
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

export function notificationFromPayload(payload = {}) {
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
  if ((event.eventType === 'interaction.requested' || payloadNeedsUserInput(payload)) && event.eventType !== 'message.assistant.delta') {
    return {
      level: 'warning',
      title: '需要处理',
      body: event.label || event.detail || event.interaction?.title || 'Codex 正在等待你的确认或输入。'
    };
  }
  return null;
}
