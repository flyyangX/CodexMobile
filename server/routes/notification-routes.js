import { sendJson } from '../http-utils.js';

export function registerNotificationRoutes(router) {
  router.get('/api/notifications/public-key', async ({ res, services }) => {
    sendJson(res, 200, await services.pushService.publicStatus());
  });

  router.post('/api/notifications/subscribe', async ({ res, body, services }) => {
    try {
      const result = await services.pushService.subscribe(body.subscription || body);
      await services.pushService.sendNotification({
        level: 'success',
        title: '完成通知已开启',
        body: 'CodexMobile 后台通知已经接通。',
        tag: 'codexmobile-notifications-enabled'
      });
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      services.warn?.(`[push] subscribe failed message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || 'Failed to subscribe push notification' });
    }
  });

  router.post('/api/notifications/unsubscribe', async ({ res, body, services }) => {
    try {
      const endpoint = body.endpoint || body.subscription?.endpoint || '';
      sendJson(res, 200, { success: true, ...(await services.pushService.unsubscribe(endpoint)) });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, { error: error.message || 'Failed to unsubscribe push notification' });
    }
  });
}
