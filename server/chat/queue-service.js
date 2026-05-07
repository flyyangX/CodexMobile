import crypto from 'node:crypto';

function serializeQueueJob(job) {
  return {
    id: job.draftId || job.turnId,
    turnId: job.turnId,
    projectId: job.project?.id || job.projectId || null,
    text: job.displayMessage,
    attachments: Array.isArray(job.attachments) ? job.attachments : [],
    selectedSkills: Array.isArray(job.selectedSkills) ? job.selectedSkills : [],
    fileMentions: Array.isArray(job.fileMentions) ? job.fileMentions : [],
    createdAt: job.createdAt || new Date().toISOString(),
    sessionId: job.selectedSessionId || null,
    draftSessionId: job.draftSessionId || null
  };
}

export function createQueueService() {
  const conversationQueues = new Map();
  const sessionQueueKeys = new Map();

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

  function addJob(job, { forceQueued = false } = {}) {
    const state = getConversationQueue(job.queueKey);
    rememberConversationAlias(job.queueKey, job.selectedSessionId);
    rememberConversationAlias(job.queueKey, job.draftSessionId);
    const queued = forceQueued || state.running || state.jobs.length > 0;
    state.jobs.push({
      ...job,
      draftId: job.draftId || job.turnId,
      createdAt: job.createdAt || new Date().toISOString()
    });
    return {
      queued,
      sessionId: state.sessionId || job.selectedSessionId || job.draftSessionId,
      state
    };
  }

  return {
    addJob,
    getConversationQueue,
    listQueue,
    queueStates: () => conversationQueues.values(),
    rememberConversationAlias,
    removeQueuedDraft,
    restoreQueuedDraft: removeQueuedDraft,
    resolveConversationKey
  };
}
