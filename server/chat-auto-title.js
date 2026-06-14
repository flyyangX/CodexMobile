/**
 * 在聊天回合中按需触发「自动会话标题」命名钩子。
 *
 * Keywords: chat-auto-title, hook, session-title
 *
 * Exports:
 * - createChatAutoNamer — 返回可注入依赖的命名器。
 *
 * Inward（本模块依赖/组装的关键符号）: 由调用方注入 getTurn、refreshCodexCache、会话标题生成器等。
 *
 * Outward（谁在用/调用场景）: chat-service 装配。
 *
 * 不负责: 直接调用 OpenAI（交给 session-title-generator）。
 */
import { createSyncEventPayload } from './sync/sync-events.js';

export function createChatAutoNamer({
  getTurn,
  refreshCodexCache,
  getSession,
  maybeAutoNameSession,
  renameSession,
  broadcast,
  logger = console
} = {}) {
  async function autoNameCompletedSession({ sessionId, turnId, userMessage } = {}) {
    if (!sessionId || !turnId) {
      return;
    }
    const turn = getTurn?.(turnId) || {};
    const assistantMessage = turn.assistantPreview || '';
    if (!String(userMessage || assistantMessage || '').trim()) {
      return;
    }

    await refreshCodexCache();
    const session = getSession(sessionId);
    if (!session || session.titleLocked) {
      return;
    }

    const renamed = await maybeAutoNameSession({
      session,
      userMessage,
      assistantMessage,
      renameSessionImpl: renameSession
    });
    if (renamed) {
      const snapshot = await refreshCodexCache();
      broadcast(createSyncEventPayload('sessions.synced', {
        source: 'auto-title',
        syncedAt: snapshot.syncedAt,
        projects: snapshot.projects
      }, {
        syncedAt: snapshot.syncedAt,
        projects: snapshot.projects
      }));
    }
  }

  function scheduleAutoNameCompletedSession(payload) {
    autoNameCompletedSession(payload).catch((error) => {
      logger?.warn?.('[title] auto naming failed:', error.message);
    });
  }

  return {
    autoNameCompletedSession,
    scheduleAutoNameCompletedSession
  };
}
