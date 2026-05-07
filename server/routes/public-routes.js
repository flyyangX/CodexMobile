import { sendJson } from '../http-utils.js';

export function registerPublicRoutes(router) {
  router.get('/api/status', async ({ req, res, services }) => {
    sendJson(res, 200, await services.publicStatus(await services.isAuthenticated(req)));
  });

  router.post('/api/pair', async ({ req, res, body, services }) => {
    const paired = await services.pairDevice({
      code: body.code,
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'],
      remoteAddress: services.remoteAddress(req)
    });
    if (!paired) {
      sendJson(res, 403, { error: 'Invalid pairing code' });
      return;
    }
    sendJson(res, 200, paired);
  });

  router.get('/api/feishu/auth/callback', async ({ req, res, url, services }) => {
    await services.feishuService.handleCallback(req, res, url, {
      remoteAddress: services.remoteAddress,
      warn: services.warn
    });
  });
}
