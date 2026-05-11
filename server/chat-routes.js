import { readBody, sendJson } from './http-utils.js';

function errorPayload(error, fallback) {
  return {
    error: error.message || fallback,
    ...(error.code ? { code: error.code } : {})
  };
}

export function createChatRouteHandler({
  chatService,
  remoteAddress = () => ''
}) {
  if (!chatService) {
    throw new Error('createChatRouteHandler requires chatService');
  }

  return async function handleChatApi(req, res, url) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    const parts = pathname.split('/').filter(Boolean);

    if (!pathname.startsWith('/api/chat/')) {
      return false;
    }

    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'chat' && parts[2] === 'turns') {
      const turnId = decodeURIComponent(parts[3]);
      sendJson(res, 200, { turn: chatService.getTurn(turnId) });
      return true;
    }

    if (method === 'GET' && pathname === '/api/chat/queue') {
      sendJson(res, 200, chatService.listQueue({
        sessionId: url.searchParams.get('sessionId') || '',
        draftSessionId: url.searchParams.get('draftSessionId') || ''
      }));
      return true;
    }

    if (method === 'DELETE' && pathname === '/api/chat/queue') {
      const body = await readBody(req);
      const draft = chatService.removeQueuedDraft(body);
      sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/queue/restore') {
      const body = await readBody(req);
      const draft = chatService.restoreQueuedDraft(body);
      sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/queue/steer') {
      const body = await readBody(req);
      try {
        const result = await chatService.steerQueuedDraft(body);
        sendJson(res, result ? 202 : 404, result || { error: 'Queued draft not found' });
      } catch (error) {
        sendJson(res, error.statusCode || 500, errorPayload(error, 'Failed to steer queued draft'));
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/send') {
      const body = await readBody(req);
      try {
        const result = await chatService.sendChat(body, { remoteAddress: remoteAddress(req) });
        sendJson(res, 202, result);
      } catch (error) {
        sendJson(res, error.statusCode || 500, errorPayload(error, 'Failed to send chat'));
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/abort') {
      const body = await readBody(req);
      try {
        const aborted = await chatService.abortChat(body, { remoteAddress: remoteAddress(req) });
        sendJson(res, aborted ? 200 : 404, { aborted });
      } catch (error) {
        sendJson(res, error.statusCode || 500, errorPayload(error, 'Failed to abort chat'));
      }
      return true;
    }

    sendJson(res, 404, { error: 'Chat API route not found' });
    return true;
  };
}
