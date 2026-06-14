/**
 * 会话与消息 REST API：列表、归档箱、取消归档、重命名、删除、读消息、刷新缓存等。
 *
 * Keywords: session-routes, rest-api, archive-box, codex-data
 *
 * Exports:
 * - createSessionRouteHandler — 注入 codex-data 与 chatService 依赖。
 *
 * Inward（本模块依赖/组装的关键符号）: http-utils。
 *
 * Outward（谁在用/调用场景）: server/index。
 *
 * 不负责: ChatService 发包实现。
 */
import { readBody, sendJson } from './http-utils.js';
import { createSyncEventPayload } from './sync/sync-events.js';

export function createSessionRouteHandler({
  listProjects,
  getProject,
  getSession,
  listProjectSessions,
  renameSession,
  deleteSession,
  unarchiveSession,
  listArchivedSessions,
  hideSessionMessage,
  readSessionMessages,
  refreshCodexCache,
  broadcast,
  chatService
}) {
  if (!getProject || !getSession || !chatService) {
    throw new Error('createSessionRouteHandler requires session dependencies');
  }

  return async function handleSessionApi(req, res, url) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    const parts = pathname.split('/').filter(Boolean);

    if (method === 'GET' && pathname === '/api/projects') {
      sendJson(res, 200, { projects: listProjects() });
      return true;
    }

    if (method === 'GET' && pathname === '/api/sessions/archived') {
      try {
        const limit = url.searchParams.get('limit');
        const result = await (listArchivedSessions || (async () => ({ sessions: [], syncedAt: new Date().toISOString(), source: 'none' })))({
          limit: limit ? Number(limit) : 200
        });
        sendJson(res, 200, result);
      } catch (error) {
        console.warn(`[sessions] archived list failed: ${error.message}`);
        sendJson(res, 500, { error: 'Failed to list archived sessions' });
      }
      return true;
    }

    if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'unarchive') {
      const sessionId = decodeURIComponent(parts[2]);
      try {
        const result = await (unarchiveSession || (async () => {
          const error = new Error('Unarchive is not available');
          error.statusCode = 501;
          throw error;
        }))(sessionId);
        const snapshot = await refreshCodexCache();
        broadcast(createSyncEventPayload('sessions.synced', {
          source: 'session-routes',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }, {
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }));
        sendJson(res, 200, { success: true, ...result });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        console.warn(`[sessions] unarchive failed session=${sessionId}: ${error.message}`);
        sendJson(res, statusCode, { error: error.message || 'Failed to unarchive session' });
      }
      return true;
    }

    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
      const projectId = decodeURIComponent(parts[2]);
      sendJson(res, 200, { sessions: listProjectSessions(projectId) });
      return true;
    }

    if (method === 'PATCH' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
      const projectId = decodeURIComponent(parts[2]);
      const sessionId = decodeURIComponent(parts[4]);
      const project = getProject(projectId);
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      const session = getSession(sessionId);
      if (!session || session.projectId !== project.id) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }

      const body = await readBody(req);
      const title = String(body.title || '').trim().slice(0, 52);
      if (!title) {
        sendJson(res, 400, { error: 'Title is required' });
        return true;
      }

      try {
        const renamed = await renameSession(session.id, project.id, title, { auto: Boolean(body.auto) });
        broadcast(createSyncEventPayload('thread.renamed', {
          projectId: project.id,
          sessionId: renamed.id,
          title: renamed.title,
          titleLocked: renamed.titleLocked,
          updatedAt: renamed.updatedAt,
          session: renamed
        }, {
          title: renamed.title,
          titleLocked: renamed.titleLocked,
          session: renamed
        }));
        const snapshot = await refreshCodexCache();
        broadcast(createSyncEventPayload('sessions.synced', {
          source: 'session-routes',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }, {
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }));
        sendJson(res, 200, { success: true, session: renamed });
      } catch (error) {
        console.warn(`[sessions] rename failed session=${sessionId} project=${projectId}: ${error.message}`);
        sendJson(res, 500, { error: 'Failed to rename session' });
      }
      return true;
    }

    if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
      const projectId = decodeURIComponent(parts[2]);
      const sessionId = decodeURIComponent(parts[4]);
      const project = getProject(projectId);
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      const session = getSession(sessionId);
      if (!session || session.projectId !== project.id) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (chatService.sessionHasActiveWork(sessionId)) {
        sendJson(res, 409, { error: 'Session is running' });
        return true;
      }
      try {
        const deleted = await deleteSession(sessionId, project.id);
        const snapshot = await refreshCodexCache();
        broadcast(createSyncEventPayload('sessions.synced', {
          source: 'session-routes',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }, {
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }));
        sendJson(res, 200, { success: true, ...deleted });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        console.warn(`[sessions] archive failed session=${sessionId} project=${projectId}: ${error.message}`);
        sendJson(res, statusCode, { error: statusCode === 409 ? error.message : 'Failed to archive session' });
      }
      return true;
    }

    if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
      const sessionId = decodeURIComponent(parts[2]);
      const messageId = decodeURIComponent(parts[4]);
      try {
        const deleted = await hideSessionMessage(sessionId, messageId);
        broadcast(createSyncEventPayload('message.deleted', {
          source: 'session-routes',
          ...deleted
        }, {
          messageId: deleted.messageId || deleted.id || messageId
        }));
        sendJson(res, 200, { success: true, ...deleted });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        console.warn(`[sessions] message delete failed session=${sessionId} message=${messageId}: ${error.message}`);
        sendJson(res, statusCode, { error: statusCode === 400 ? error.message : 'Failed to delete message' });
      }
      return true;
    }

    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
      const sessionId = decodeURIComponent(parts[2]);
      const limit = url.searchParams.get('limit');
      const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
      const result = await readSessionMessages(sessionId, {
        limit: limit ? Number(limit) : 120,
        offset: offset !== null ? Number(offset) : null,
        latest: offset === null || url.searchParams.get('latest') === '1',
        includeActivity: url.searchParams.get('activity') === '1'
      });
      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
