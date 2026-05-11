import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createChatRouteHandler } from './chat-routes.js';
import { createFeishuIntegration } from './feishu-routes.js';
import { createFileRouteHandler } from './file-routes.js';
import { createNotificationRouteHandler } from './notification-routes.js';
import { createSessionRouteHandler } from './session-routes.js';
import { createVoiceRouteHandler } from './voice-routes.js';

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    }
  };
}

function createRequest(method = 'GET', body = null) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = () => {};
  req.sendBody = () => {
    if (body !== null) {
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.emit('end');
  };
  return req;
}

async function callWithBody(handler, req, res, url) {
  const promise = handler(req, res, url);
  req.sendBody();
  return promise;
}

test('notification route handler keeps public key and subscribe response shapes', async () => {
  const sentNotifications = [];
  const handler = createNotificationRouteHandler({
    pushService: {
      async publicStatus() {
        return { publicKey: 'public-key', subscriptions: 1 };
      },
      async subscribe(subscription) {
        assert.equal(subscription.endpoint, 'https://push.example/one');
        return { subscriptions: 2 };
      },
      async sendNotification(payload) {
        sentNotifications.push(payload);
        return { sent: 1 };
      }
    },
    remoteAddress: () => '127.0.0.1'
  });

  const publicRes = createResponse();
  assert.equal(await handler(createRequest('GET'), publicRes, new URL('http://local/api/notifications/public-key')), true);
  assert.deepEqual(JSON.parse(publicRes.body), { publicKey: 'public-key', subscriptions: 1 });

  const subscribeReq = createRequest('POST', { endpoint: 'https://push.example/one' });
  const subscribeRes = createResponse();
  assert.equal(await callWithBody(handler, subscribeReq, subscribeRes, new URL('http://local/api/notifications/subscribe')), true);
  assert.equal(subscribeRes.statusCode, 200);
  assert.deepEqual(JSON.parse(subscribeRes.body), { success: true, subscriptions: 2 });
  assert.equal(sentNotifications.at(-1).title, '完成通知已开启');
});

test('chat route handler routes send and abort through chat service', async () => {
  const calls = [];
  const handler = createChatRouteHandler({
    chatService: {
      async sendChat(body, options) {
        calls.push({ name: 'send', body, options });
        return { accepted: true, turnId: 'turn-1' };
      },
      abortChat(body, options) {
        calls.push({ name: 'abort', body, options });
        return true;
      }
    },
    remoteAddress: () => '127.0.0.1'
  });

  const sendReq = createRequest('POST', { projectId: 'project-1', message: 'hi' });
  const sendRes = createResponse();
  assert.equal(await callWithBody(handler, sendReq, sendRes, new URL('http://local/api/chat/send')), true);
  assert.equal(sendRes.statusCode, 202);
  assert.deepEqual(JSON.parse(sendRes.body), { accepted: true, turnId: 'turn-1' });

  const abortReq = createRequest('POST', { turnId: 'turn-1' });
  const abortRes = createResponse();
  assert.equal(await callWithBody(handler, abortReq, abortRes, new URL('http://local/api/chat/abort')), true);
  assert.deepEqual(JSON.parse(abortRes.body), { aborted: true });
  assert.deepEqual(calls.map((call) => call.name), ['send', 'abort']);
});

test('chat route handler preserves structured send errors', async () => {
  const handler = createChatRouteHandler({
    chatService: {
      async sendChat() {
        const error = new Error('danger-full-access is disabled on this server');
        error.statusCode = 403;
        error.code = 'CODEXMOBILE_DANGER_FULL_ACCESS_DISABLED';
        throw error;
      }
    }
  });

  const sendReq = createRequest('POST', { projectId: 'project-1', message: 'hi', permissionMode: 'bypassPermissions' });
  const sendRes = createResponse();
  assert.equal(await callWithBody(handler, sendReq, sendRes, new URL('http://local/api/chat/send')), true);
  assert.equal(sendRes.statusCode, 403);
  assert.deepEqual(JSON.parse(sendRes.body), {
    error: 'danger-full-access is disabled on this server',
    code: 'CODEXMOBILE_DANGER_FULL_ACCESS_DISABLED'
  });
});

test('file route handler searches project files and preserves project not found response', async () => {
  const handler = createFileRouteHandler({
    getProject(projectId) {
      return projectId === 'project-1' ? { id: 'project-1', path: '/tmp/project' } : null;
    },
    searchProjectFiles: async (project, query) => {
      assert.equal(project.id, 'project-1');
      assert.equal(query, 'app');
      return [{ path: 'client/src/App.jsx' }];
    },
    staticService: {
      async sendLocalImage() {
        throw new Error('unexpected');
      }
    },
    saveUpload: async () => ({ name: 'file.txt' }),
    uploadRoot: '/tmp/uploads',
    maxUploadBytes: 100
  });

  const okRes = createResponse();
  assert.equal(await handler(createRequest('GET'), okRes, new URL('http://local/api/files/search?projectId=project-1&q=app')), true);
  assert.deepEqual(JSON.parse(okRes.body), { files: [{ path: 'client/src/App.jsx' }] });

  const missingRes = createResponse();
  assert.equal(await handler(createRequest('GET'), missingRes, new URL('http://local/api/files/search?projectId=missing&q=app')), true);
  assert.equal(missingRes.statusCode, 404);
  assert.deepEqual(JSON.parse(missingRes.body), { error: 'Project not found' });
});

test('file route handler accepts local file URLs with source filename path segment', async () => {
  const calls = [];
  const handler = createFileRouteHandler({
    getProject: () => null,
    staticService: {
      async sendLocalImage() {
        throw new Error('unexpected');
      },
      async sendLocalFile(req, res, url) {
        calls.push(url.pathname);
        res.writeHead(200, {});
        res.end('ok');
      }
    },
    saveUpload: async () => ({ name: 'file.txt' }),
    uploadRoot: '/tmp/uploads',
    maxUploadBytes: 100
  });

  const res = createResponse();
  assert.equal(
    await handler(
      createRequest('GET'),
      res,
      new URL('http://local/api/local-file/%E9%9D%92%E7%94%9C.pdf?path=%2Ftmp%2F%E9%9D%92%E7%94%9C.pdf')
    ),
    true
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['/api/local-file/%E9%9D%92%E7%94%9C.pdf']);
});

test('session route handler renames sessions and broadcasts refresh events', async () => {
  const broadcasts = [];
  const handler = createSessionRouteHandler({
    getProject: () => ({ id: 'project-1' }),
    getSession: () => ({ id: 'session-1', projectId: 'project-1' }),
    listProjectSessions: () => [],
    renameSession: async () => ({ id: 'session-1', title: 'New name', titleLocked: true, updatedAt: 'now' }),
    deleteSession: async () => ({}),
    hideSessionMessage: async () => ({}),
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => ({ syncedAt: 'sync-1', projects: [] }),
    broadcast: (payload) => broadcasts.push(payload),
    chatService: { sessionHasActiveWork: () => false }
  });

  const req = createRequest('PATCH', { title: 'New name' });
  const res = createResponse();
  assert.equal(await callWithBody(handler, req, res, new URL('http://local/api/projects/project-1/sessions/session-1')), true);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).session.title, 'New name');
  assert.deepEqual(broadcasts.map((payload) => payload.type), ['session-renamed', 'sync-complete']);
});

test('voice route handler redacts API keys from speech failures', async () => {
  const handler = createVoiceRouteHandler({
    getCacheSnapshot: () => ({ config: {} }),
    transcribeAudio: async () => ({ text: 'hello' }),
    synthesizeSpeech: async () => {
      throw new Error('bad key sk-secret123');
    },
    readVoiceUpload: async () => ({ data: Buffer.from('audio'), mimeType: 'audio/webm' }),
    maxVoiceBytes: 100,
    remoteAddress: () => '127.0.0.1'
  });

  const req = createRequest('POST', { text: 'hello' });
  const res = createResponse();
  assert.equal(await callWithBody(handler, req, res, new URL('http://local/api/voice/speech')), true);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'bad key sk-[hidden]' });
});

test('feishu integration reports CLI auth status through its route handler', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-feishu-routes-'));
  try {
    const integration = createFeishuIntegration({
      statePath: path.join(dir, 'feishu.json'),
      appId: '',
      appSecret: '',
      docsHomeUrl: 'https://docs.feishu.cn/',
      getLarkDocsStatus: async ({ authenticated }) => ({ connected: authenticated, provider: 'feishu' }),
      startLarkCliAuth: async () => ({ url: 'https://auth.example/start' }),
      logoutLarkCli: async () => {},
      requestOrigin: () => 'http://local',
      remoteAddress: () => '127.0.0.1'
    });

    const req = createRequest('POST');
    const res = createResponse();
    assert.equal(await integration.handleApi(req, res, new URL('http://local/api/feishu/cli/auth/start')), true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      success: true,
      url: 'https://auth.example/start',
      docs: { connected: true, provider: 'feishu' }
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('feishu integration keeps OAuth start guarded when app credentials are missing', async () => {
  const integration = createFeishuIntegration({
    statePath: path.join(os.tmpdir(), 'missing-feishu-state.json'),
    appId: '',
    appSecret: '',
    getLarkDocsStatus: async () => ({}),
    requestOrigin: () => 'http://local',
    remoteAddress: () => '127.0.0.1'
  });

  const req = createRequest('POST');
  const res = createResponse();
  assert.equal(await integration.handleApi(req, res, new URL('http://local/api/feishu/auth/start')), true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'Feishu app credentials are not configured' });
});
