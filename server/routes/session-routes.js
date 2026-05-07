import { sendJson } from '../http-utils.js';

export function registerSessionRoutes(router) {
  router.get('/api/projects/:projectId/sessions', async ({ res, params, services }) => {
    sendJson(res, 200, { sessions: services.listProjectSessions(params.projectId) });
  });

  router.patch('/api/projects/:projectId/sessions/:sessionId', async ({ res, params, body, services }) => {
    const project = services.getProject(params.projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const session = services.getSession(params.sessionId);
    if (!session || session.projectId !== project.id) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const title = String(body.title || '').trim().slice(0, 52);
    if (!title) {
      sendJson(res, 400, { error: 'Title is required' });
      return;
    }

    try {
      const renamed = await services.renameSession(session.id, project.id, title, { auto: Boolean(body.auto) });
      services.broadcast({
        type: 'session-renamed',
        projectId: project.id,
        sessionId: renamed.id,
        title: renamed.title,
        titleLocked: renamed.titleLocked,
        updatedAt: renamed.updatedAt,
        session: renamed
      });
      const snapshot = await services.refreshCodexCache();
      services.broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, session: renamed });
    } catch (error) {
      services.warn?.(`[sessions] rename failed session=${params.sessionId} project=${params.projectId}: ${error.message}`);
      sendJson(res, 500, { error: 'Failed to rename session' });
    }
  });

  router.delete('/api/projects/:projectId/sessions/:sessionId', async ({ res, params, services }) => {
    const project = services.getProject(params.projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const session = services.getSession(params.sessionId);
    if (!session || session.projectId !== project.id) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    if (services.chatService.sessionHasActiveWork(params.sessionId)) {
      sendJson(res, 409, { error: 'Session is running' });
      return;
    }
    try {
      const deleted = await services.deleteSession(params.sessionId, project.id);
      const snapshot = await services.refreshCodexCache();
      services.broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...deleted });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      services.warn?.(`[sessions] archive failed session=${params.sessionId} project=${params.projectId}: ${error.message}`);
      sendJson(res, statusCode, { error: statusCode === 409 ? error.message : 'Failed to archive session' });
    }
  });

  router.delete('/api/sessions/:sessionId/messages/:messageId', async ({ res, params, services }) => {
    try {
      const deleted = await services.hideSessionMessage(params.sessionId, params.messageId);
      services.broadcast({ type: 'message-deleted', ...deleted });
      sendJson(res, 200, { success: true, ...deleted });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      services.warn?.(`[sessions] message delete failed session=${params.sessionId} message=${params.messageId}: ${error.message}`);
      sendJson(res, statusCode, { error: statusCode === 400 ? error.message : 'Failed to delete message' });
    }
  });

  router.get('/api/sessions/:sessionId/messages', async ({ res, params, url, services }) => {
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
    const result = await services.readSessionMessages(params.sessionId, {
      limit: limit ? Number(limit) : 120,
      offset: offset !== null ? Number(offset) : null,
      latest: offset === null || url.searchParams.get('latest') === '1',
      includeActivity: url.searchParams.get('activity') === '1'
    });
    sendJson(res, 200, result);
  });
}
