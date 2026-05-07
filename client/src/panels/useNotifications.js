import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api.js';
import {
  browserNotificationPermission,
  isStandalonePwa,
  notificationFromPayload,
  notificationPreferenceEnabled,
  setNotificationPreferenceEnabled,
  shouldUseWebNotification
} from '../notification-events.js';
import {
  browserPushSupported,
  notificationEnablementMessage,
  registerWebPush
} from '../web-push-client.js';

export function useNotifications() {
  const toastTimersRef = useRef(new Map());
  const [toasts, setToasts] = useState([]);
  const [notificationPermission, setNotificationPermission] = useState(() => browserNotificationPermission());
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => notificationPreferenceEnabled());

  useEffect(
    () => () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    },
    []
  );

  const dismissToast = useCallback((id) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast) => {
    const id = toast.id || `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const nextToast = {
      id,
      level: toast.level || 'info',
      title: toast.title || '提醒',
      body: toast.body || ''
    };
    setToasts((current) => [nextToast, ...current.filter((item) => item.id !== id)].slice(0, 4));
    if (toastTimersRef.current.has(id)) {
      window.clearTimeout(toastTimersRef.current.get(id));
    }
    const timer = window.setTimeout(() => dismissToast(id), toast.durationMs || 5200);
    toastTimersRef.current.set(id, timer);
    return id;
  }, [dismissToast]);

  const maybeSendWebNotification = useCallback((notification) => {
    if (!notification || browserPushSupported()) {
      return;
    }
    if (!shouldUseWebNotification({
      enabled: notificationsEnabled,
      permission: notificationPermission,
      visibilityState: document.visibilityState,
      standalone: isStandalonePwa()
    })) {
      return;
    }
    try {
      new Notification(notification.title, {
        body: notification.body,
        tag: `codexmobile-${notification.title}`,
        silent: false
      });
    } catch {
      // Browser notification support varies across mobile browsers.
    }
  }, [notificationPermission, notificationsEnabled]);

  const notifyFromPayload = useCallback((payload) => {
    const notification = notificationFromPayload(payload);
    if (!notification) {
      return;
    }
    showToast(notification);
    maybeSendWebNotification(notification);
  }, [maybeSendWebNotification, showToast]);

  const enableNotifications = useCallback(async () => {
    const pushSupported = browserPushSupported();
    const standalone = isStandalonePwa();
    const secureContext = Boolean(window.isSecureContext);
    if (!pushSupported || !secureContext || !standalone) {
      showToast({
        level: 'warning',
        title: '通知不可用',
        body: notificationEnablementMessage({ supported: pushSupported, secureContext, standalone }),
        durationMs: 7000
      });
      return;
    }
    try {
      const result = await registerWebPush({ apiFetch });
      setNotificationPermission(result.permission);
      setNotificationsEnabled(true);
      setNotificationPreferenceEnabled(true);
      showToast({
        level: 'success',
        title: '完成通知已开启',
        body: notificationEnablementMessage({ supported: true, secureContext: true, standalone: true })
      });
    } catch (error) {
      setNotificationPermission(browserNotificationPermission());
      setNotificationsEnabled(false);
      setNotificationPreferenceEnabled(false);
      showToast({
        level: error.code === 'permission-denied' ? 'warning' : 'error',
        title: error.code === 'permission-denied' ? '未开启通知' : '通知开启失败',
        body: error.message || '无法请求 Web Push 通知权限。',
        durationMs: 7000
      });
    }
  }, [showToast]);

  return {
    toasts,
    notificationSupported: browserPushSupported(),
    notificationEnabled: notificationsEnabled && notificationPermission === 'granted',
    dismissToast,
    showToast,
    notifyFromPayload,
    enableNotifications
  };
}
