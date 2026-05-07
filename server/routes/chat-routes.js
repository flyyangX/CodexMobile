import { sendJson } from '../http-utils.js';

export function registerChatRoutes(router) {
  router.get('/api/chat/turns/:turnId', async ({ res, params, services }) => {
    sendJson(res, 200, { turn: services.chatService.getTurn(params.turnId) });
  });

  router.get('/api/chat/queue', async ({ res, url, services }) => {
    sendJson(res, 200, services.chatService.listQueue({
      sessionId: url.searchParams.get('sessionId') || '',
      draftSessionId: url.searchParams.get('draftSessionId') || ''
    }));
  });

  router.delete('/api/chat/queue', async ({ res, body, services }) => {
    const draft = services.chatService.removeQueuedDraft(body);
    sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
  });

  router.post('/api/chat/queue/restore', async ({ res, body, services }) => {
    const draft = services.chatService.restoreQueuedDraft(body);
    sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
  });

  router.post('/api/chat/queue/steer', async ({ res, body, services }) => {
    try {
      const result = await services.chatService.steerQueuedDraft(body);
      sendJson(res, result ? 202 : 404, result || { error: 'Queued draft not found' });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to steer queued draft' });
    }
  });

  router.post('/api/chat/send', async ({ req, res, body, services }) => {
    try {
      const result = await services.chatService.sendChat(body, { remoteAddress: services.remoteAddress(req) });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to send chat' });
    }
  });

  router.post('/api/chat/abort', async ({ req, res, body, services }) => {
    const aborted = services.chatService.abortChat(body, { remoteAddress: services.remoteAddress(req) });
    sendJson(res, aborted ? 200 : 404, { aborted });
  });
}
