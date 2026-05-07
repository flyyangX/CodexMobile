import { sendJson } from '../http-utils.js';

export function registerSystemRoutes(router) {
  router.post('/api/sync', async ({ res, services }) => {
    const result = await services.refreshCodexCacheForSyncResponse();
    const { snapshot, timedOut } = result;
    if (!timedOut) {
      services.broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    }
    sendJson(res, 200, { success: !timedOut && !result.error, pending: timedOut, error: result.error?.message || null, ...snapshot });
  });

  router.get('/api/projects', async ({ res, services }) => {
    sendJson(res, 200, { projects: services.listProjects() });
  });

  router.get('/api/quotas/codex', async ({ req, res, services }) => {
    try {
      sendJson(res, 200, await services.getCodexQuota());
    } catch (error) {
      services.warn?.(`[quota] codex quota failed remote=${services.remoteAddress(req)} message=${error.message || 'unknown'}`);
      sendJson(res, 500, { error: 'Failed to query Codex quota' });
    }
  });

  router.get('/api/local-image', async ({ req, res, url, services }) => {
    await services.staticService.sendLocalImage(req, res, url);
  });
}
