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
  const text = [
    payload.type,
    payload.status,
    payload.kind,
    payload.label,
    payload.detail,
    payload.content,
    payload.error
  ].filter(Boolean).join(' ');
  return NEEDS_INPUT_PATTERN.test(text);
}

export function userInputMessageId(payload = {}) {
  return `user-input-${[payload.threadId || payload.sessionId, payload.turnId, payload.itemId].filter(Boolean).join('-')}`;
}

export function userInputKey(payload = {}) {
  return [payload.threadId || payload.sessionId, payload.turnId, payload.itemId].filter(Boolean).join(':');
}

export function upsertUserInputMessage(current = [], payload = {}) {
  const id = userInputMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const nextMessage = {
    id,
    role: 'user_input_request',
    sessionId: payload.threadId || payload.sessionId || null,
    threadId: payload.threadId || payload.sessionId || null,
    turnId: payload.turnId || null,
    itemId: payload.itemId || null,
    questions: Array.isArray(payload.questions) ? payload.questions : [],
    status: payload.status || 'pending',
    timestamp: payload.timestamp || new Date().toISOString(),
    error: payload.error || ''
  };
  if (payload.conversationId) {
    nextMessage.conversationId = payload.conversationId;
  }
  if (payload.transport) {
    nextMessage.transport = payload.transport;
  }
  if (payload.delivery) {
    nextMessage.delivery = payload.delivery;
  }
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = { ...current[existingIndex], ...nextMessage };
    return next;
  }
  return [...current, nextMessage];
}

export function markUserInputMessageResolved(current = [], payload = {}) {
  const id = userInputMessageId(payload);
  return current.map((message) =>
    message.id === id
      ? { ...message, status: 'answered', error: '' }
      : message
  );
}

export function mergePendingUserInputMessages(messages = [], pendingUserInputs = {}, session = {}) {
  const sessionId = session?.id || session?.sessionId || session?.threadId;
  if (!sessionId) {
    return messages;
  }
  return Object.values(pendingUserInputs || {})
    .filter((payload) => (payload.threadId || payload.sessionId) === sessionId)
    .reduce((nextMessages, payload) => upsertUserInputMessage(nextMessages, payload), messages);
}

export function notificationFromPayload(payload = {}) {
  if (payload.type === 'chat-complete') {
    return {
      level: 'success',
      title: '任务已完成',
      body: payload.detail || 'Codex 已处理完当前任务。'
    };
  }
  if (payload.type === 'chat-error') {
    return {
      level: 'error',
      title: '任务失败',
      body: payload.error || payload.detail || 'Codex 执行时遇到错误。'
    };
  }
  if (payload.type === 'chat-aborted') {
    return {
      level: 'info',
      title: '任务已中止',
      body: payload.detail || '当前任务已经停下。'
    };
  }
  if (payload.type === 'user-input-request') {
    return {
      level: 'warning',
      title: '需要处理',
      body: payload.questions?.[0]?.question || 'Codex 正在等待你的选择。'
    };
  }
  if ((payload.type === 'status-update' || payload.type === 'activity-update') && payloadNeedsUserInput(payload)) {
    return {
      level: 'warning',
      title: '需要处理',
      body: payload.label || payload.detail || 'Codex 正在等待你的确认或输入。'
    };
  }
  return null;
}
