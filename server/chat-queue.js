/**
 * 聊天发送侧回合队列：去重、限深与挂起 Codex 运行时的 session 关联。
 *
 * Keywords: chat-queue, turn-queue, recent-turns, session-binding
 *
 * Exports:
 * - createChatQueue — 工厂，维护内存队列与泄漏防护。
 *
 * Inward（本模块依赖/组装的关键符号）: Node crypto（job id）、纯内存结构。
 *
 * Outward（谁在用/调用场景）: chat-service。
 *
 * 不负责: 持久化队列。
 */
import crypto from 'node:crypto';

const DEFAULT_MAX_RECENT_TURNS = 80;

function payloadReferencesSession(payload, sessionId) {
  return [
    payload?.sessionId,
    payload?.previousSessionId,
    payload?.draftSessionId,
    payload?.selectedSessionId
  ].some((value) => value && value === sessionId);
}

function serializeQueueJob(job) {
  return {
    id: job.draftId || job.turnId,
    turnId: job.turnId,
    projectId: job.project?.id || job.projectId || null,
    text: job.displayMessage,
    attachments: Array.isArray(job.attachments) ? job.attachments : [],
    selectedSkills: Array.isArray(job.selectedSkills) ? job.selectedSkills : [],
    fileMentions: Array.isArray(job.fileMentions) ? job.fileMentions : [],
    collaborationMode: job.collaborationMode?.mode || null,
    createdAt: job.createdAt || new Date().toISOString(),
    sessionId: job.selectedSessionId || null,
    draftSessionId: job.draftSessionId || null
  };
}

export function createChatQueue({ maxRecentTurns = DEFAULT_MAX_RECENT_TURNS } = {}) {
  const recentTurns = new Map();
  const conversationQueues = new Map();
  const sessionQueueKeys = new Map();

  function rememberTurn(turnId, patch) {
    if (!turnId) {
      return null;
    }
    const existing = recentTurns.get(turnId) || { turnId, createdAt: new Date().toISOString() };
    const next = {
      ...existing,
      ...patch,
      turnId,
      updatedAt: new Date().toISOString()
    };
    recentTurns.set(turnId, next);

    if (recentTurns.size > maxRecentTurns) {
      const oldest = [...recentTurns.entries()].sort(
        (a, b) => new Date(a[1].updatedAt || a[1].createdAt || 0) - new Date(b[1].updatedAt || b[1].createdAt || 0)
      )[0]?.[0];
      if (oldest) {
        recentTurns.delete(oldest);
      }
    }
    return next;
  }

  function rememberTurnEvent(payload) {
    const event = payload?.type === 'sync-event' ? payload.event : null;
    const normalized = event
      ? {
        type: event.eventType,
        projectId: event.projectId,
        sessionId: event.sessionId,
        previousSessionId: event.previousSessionId,
        draftSessionId: event.draftSessionId,
        turnId: event.turnId || event.clientTurnId,
        clientTurnId: event.clientTurnId,
        status: event.status,
        kind: event.itemType || event.activity?.kind,
        label: event.label,
        detail: event.detail,
        content: event.message?.content,
        messageId: event.message?.id || event.itemId,
        startedAt: event.startedAt,
        completedAt: event.completedAt,
        durationMs: event.durationMs,
        usage: event.usage || null,
        context: event.context || null,
        hadAssistantText: event.hadAssistantText
      }
      : payload;
    if (!normalized?.turnId) {
      return;
    }

    const patch = {
      projectId: normalized.projectId,
      sessionId: normalized.sessionId || undefined,
      previousSessionId: normalized.previousSessionId || undefined
    };

    if (normalized.type === 'turn.running') {
      patch.status = 'running';
      patch.startedAt = normalized.startedAt || new Date().toISOString();
      patch.label = normalized.label || '正在思考';
    } else if (normalized.type === 'thread.started') {
      patch.status = 'running';
      patch.label = '正在思考';
    } else if (normalized.type === 'turn.queued') {
      patch.status = 'queued';
      patch.label = normalized.label || '已加入队列';
    } else if (normalized.type === 'message.assistant.delta' || normalized.type === 'message.assistant.completed') {
      patch.status = 'running';
      patch.hadAssistantText = true;
      patch.assistantPreview = normalized.content || '';
      patch.messageId = normalized.messageId || undefined;
      patch.label = '正在回复';
    } else if (normalized.type === 'context.updated') {
      patch.status = normalized.status || 'running';
      patch.context = normalized.context;
      patch.label = normalized.label || '背景信息已同步';
    } else if (normalized.type === 'turn.completed') {
      patch.status = 'completed';
      patch.completedAt = normalized.completedAt || new Date().toISOString();
      patch.hadAssistantText = Boolean(normalized.hadAssistantText);
      patch.usage = normalized.usage || null;
      patch.context = normalized.context || null;
      patch.label = normalized.label || '任务已完成';
    } else if (normalized.type === 'turn.failed') {
      patch.status = 'failed';
      patch.error = normalized.detail || '任务失败';
      patch.label = normalized.label || '任务失败';
    } else if (normalized.type === 'turn.aborted') {
      patch.status = 'aborted';
      patch.label = normalized.label || '已中止';
    } else {
      return;
    }

    if (normalized.startedAt) {
      patch.startedAt = normalized.startedAt;
    }
    if (normalized.completedAt) {
      patch.completedAt = normalized.completedAt;
    }
    if (normalized.durationMs) {
      patch.durationMs = normalized.durationMs;
    }

    rememberTurn(normalized.turnId, patch);
  }

  function rememberConversationAlias(queueKey, sessionId) {
    if (queueKey && sessionId) {
      sessionQueueKeys.set(sessionId, queueKey);
    }
  }

  function resolveConversationKey(...ids) {
    for (const id of ids) {
      if (id && sessionQueueKeys.has(id)) {
        return sessionQueueKeys.get(id);
      }
    }
    const queueKey = ids.find(Boolean) || crypto.randomUUID();
    for (const id of ids) {
      rememberConversationAlias(queueKey, id);
    }
    return queueKey;
  }

  function getConversationQueue(queueKey) {
    if (!conversationQueues.has(queueKey)) {
      conversationQueues.set(queueKey, {
        sessionId: null,
        running: false,
        jobs: []
      });
    }
    return conversationQueues.get(queueKey);
  }

  function queueForRequest({ sessionId = '', draftSessionId = '' } = {}) {
    const queueKey = resolveConversationKey(
      String(sessionId || '').trim() || null,
      String(draftSessionId || '').trim() || null
    );
    return { queueKey, state: getConversationQueue(queueKey) };
  }

  function listQueue(query = {}) {
    const { state } = queueForRequest(query);
    return {
      drafts: state.jobs.map(serializeQueueJob),
      running: state.running
    };
  }

  function removeQueuedDraft(query = {}) {
    const draftId = String(query.draftId || '').trim();
    if (!draftId) {
      return null;
    }
    const { state } = queueForRequest(query);
    const index = state.jobs.findIndex((job) => (job.draftId || job.turnId) === draftId);
    if (index < 0) {
      return null;
    }
    const [removed] = state.jobs.splice(index, 1);
    return serializeQueueJob(removed);
  }

  function restoreQueuedDraft(query = {}) {
    return removeQueuedDraft(query);
  }

  function enqueueJob(job, { forceQueued = false } = {}) {
    const state = getConversationQueue(job.queueKey);
    rememberConversationAlias(job.queueKey, job.selectedSessionId);
    rememberConversationAlias(job.queueKey, job.draftSessionId);

    const queued = forceQueued || state.running || state.jobs.length > 0;
    state.jobs.push({
      ...job,
      draftId: job.draftId || job.turnId,
      createdAt: job.createdAt || new Date().toISOString()
    });
    return { queued, state };
  }

  function sessionHasActiveWork(sessionId, activeRuns = []) {
    if (!sessionId) {
      return false;
    }
    if (activeRuns.some((run) => payloadReferencesSession(run, sessionId))) {
      return true;
    }

    for (const turn of recentTurns.values()) {
      if (
        (turn.status === 'accepted' || turn.status === 'queued' || turn.status === 'running') &&
        payloadReferencesSession(turn, sessionId)
      ) {
        return true;
      }
    }

    for (const state of conversationQueues.values()) {
      if (state.running && state.sessionId === sessionId) {
        return true;
      }
      if (state.jobs.some((job) => payloadReferencesSession(job, sessionId))) {
        return true;
      }
    }

    return false;
  }

  function findActiveTurnForSession(sessionId, { source } = {}) {
    if (!sessionId) {
      return null;
    }
    const activeStatuses = new Set(['accepted', 'queued', 'running']);
    const turns = [...recentTurns.values()].reverse();
    return turns.find((turn) => (
      activeStatuses.has(turn.status) &&
      (!source || turn.source === source) &&
      payloadReferencesSession(turn, sessionId)
    )) || null;
  }

  return {
    enqueueJob,
    findActiveTurnForSession,
    getConversationQueue,
    getTurn(turnId) {
      return recentTurns.get(turnId) || null;
    },
    listQueue,
    rememberConversationAlias,
    rememberTurn,
    rememberTurnEvent,
    removeQueuedDraft,
    resolveConversationKey,
    restoreQueuedDraft,
    sessionHasActiveWork
  };
}
