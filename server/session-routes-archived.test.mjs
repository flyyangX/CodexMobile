/**
 * 测试 server/session-routes.js：归档箱只读 API。
 * Keywords: session-routes, archive-box, tests
 * Exports: 无导出，内含用例
 * Inward: session-routes.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRouteHandler } from './session-routes.js';

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

test('GET /api/sessions/archived returns archived sessions from injected data source', async () => {
  const handler = createSessionRouteHandler({
    listProjects: () => [],
    getProject: () => null,
    getSession: () => null,
    listProjectSessions: () => [],
    renameSession: async () => null,
    deleteSession: async () => null,
    listArchivedSessions: async ({ limit }) => ({
      sessions: [
        {
          id: 'archived-1',
          title: '归档线程',
          summary: '已归档',
          projectPath: '/tmp/project',
          updatedAt: '2026-05-14T10:00:00.000Z',
          archivedAt: '2026-05-14T10:10:00.000Z',
          model: 'gpt-5.5',
          modelShort: '5.5 中'
        }
      ],
      syncedAt: '2026-05-14T10:11:00.000Z',
      source: `limit-${limit}`
    }),
    hideSessionMessage: async () => null,
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => ({ syncedAt: '', projects: [] }),
    broadcast: () => null,
    chatService: { sessionHasActiveWork: () => false }
  });
  const res = createResponse();
  const handled = await handler({ method: 'GET' }, res, new URL('http://codexmobile.test/api/sessions/archived?limit=1'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    sessions: [
      {
        id: 'archived-1',
        title: '归档线程',
        summary: '已归档',
        projectPath: '/tmp/project',
        updatedAt: '2026-05-14T10:00:00.000Z',
        archivedAt: '2026-05-14T10:10:00.000Z',
        model: 'gpt-5.5',
        modelShort: '5.5 中'
      }
    ],
    syncedAt: '2026-05-14T10:11:00.000Z',
    source: 'limit-1'
  });
});

test('POST /api/sessions/:id/unarchive restores archived session and broadcasts sync', async () => {
  const calls = [];
  const handler = createSessionRouteHandler({
    listProjects: () => [],
    getProject: () => null,
    getSession: () => null,
    listProjectSessions: () => [],
    renameSession: async () => null,
    deleteSession: async () => null,
    unarchiveSession: async (sessionId) => {
      calls.push(['unarchive', sessionId]);
      return { sessionId, unarchivedDesktopThread: true, unhidden: false };
    },
    listArchivedSessions: async () => ({ sessions: [], syncedAt: '', source: 'desktop' }),
    hideSessionMessage: async () => null,
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => {
      calls.push(['refresh']);
      return { syncedAt: 'sync-2', projects: [{ id: 'project-1' }] };
    },
    broadcast: (payload) => calls.push(['broadcast', payload]),
    chatService: { sessionHasActiveWork: () => false }
  });
  const res = createResponse();
  const handled = await handler({ method: 'POST' }, res, new URL('http://codexmobile.test/api/sessions/archived-1/unarchive'));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    success: true,
    sessionId: 'archived-1',
    unarchivedDesktopThread: true,
    unhidden: false
  });
  assert.deepEqual(calls, [
    ['unarchive', 'archived-1'],
    ['refresh'],
    ['broadcast', {
      type: 'sync-event',
      event: {
        id: calls[2][1].event.id,
        eventType: 'sessions.synced',
        protocol: 'codexmobile-sync',
        appMethod: null,
        source: 'session-routes',
        projectId: null,
        sessionId: null,
        previousSessionId: null,
        draftSessionId: null,
        turnId: null,
        clientTurnId: null,
        appTurnId: null,
        itemId: null,
        itemType: null,
        status: null,
        label: null,
        detail: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        timestamp: calls[2][1].event.timestamp,
        syncedAt: 'sync-2',
        projects: [{ id: 'project-1' }]
      }
    }]
  ]);
});
