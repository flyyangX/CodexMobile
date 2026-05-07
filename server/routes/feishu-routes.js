import { sendJson } from '../http-utils.js';

export function registerFeishuRoutes(router) {
  router.get('/api/feishu/status', async ({ res, services }) => {
    sendJson(res, 200, await services.feishuService.publicDocsStatus(true));
  });

  router.post('/api/feishu/cli/auth/start', async ({ req, res, services }) => {
    try {
      const auth = await services.feishuService.startCliAuth();
      sendJson(res, 200, {
        success: true,
        ...auth,
        docs: await services.feishuService.publicDocsStatus(true)
      });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      services.warn?.(`[lark-cli] auth start failed remote=${services.remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '飞书 CLI 授权失败' });
    }
  });

  router.post('/api/feishu/cli/auth/logout', async ({ req, res, services }) => {
    try {
      await services.feishuService.logoutCli();
      sendJson(res, 200, {
        success: true,
        docs: await services.feishuService.publicDocsStatus(true)
      });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      services.warn?.(`[lark-cli] auth logout failed remote=${services.remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '断开飞书 CLI 授权失败' });
    }
  });

  router.post('/api/feishu/auth/start', async ({ req, res, services }) => {
    try {
      sendJson(res, 200, await services.feishuService.startOAuth(req));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Feishu auth start failed' });
    }
  });

  router.post('/api/feishu/auth/logout', async ({ res, services }) => {
    await services.feishuService.logoutOAuth();
    sendJson(res, 200, { success: true, ...(await services.feishuService.publicDocsStatus(true)) });
  });
}
