export function createTurnRegistry({ maxRecentTurns = 80 } = {}) {
  const recentTurns = new Map();

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
    if (!payload?.turnId) {
      return;
    }

    const patch = {
      projectId: payload.projectId,
      sessionId: payload.sessionId || undefined,
      previousSessionId: payload.previousSessionId || undefined
    };

    if (payload.type === 'chat-started') {
      patch.status = 'running';
      patch.startedAt = payload.startedAt || new Date().toISOString();
      patch.label = '正在思考';
    } else if (payload.type === 'thread-started') {
      patch.status = 'running';
      patch.label = '正在思考';
    } else if (payload.type === 'status-update') {
      patch.status = payload.status || 'running';
      patch.kind = payload.kind || undefined;
      patch.label = payload.label || undefined;
      patch.detail = payload.detail || undefined;
    } else if (payload.type === 'assistant-update') {
      patch.status = 'running';
      patch.hadAssistantText = true;
      patch.assistantPreview = payload.content || '';
      patch.messageId = payload.messageId || undefined;
      patch.label = '正在回复';
    } else if (payload.type === 'context-status-update') {
      patch.status = payload.status || 'running';
      patch.context = payload;
      patch.label = '背景信息已同步';
    } else if (payload.type === 'chat-complete') {
      patch.status = 'completed';
      patch.completedAt = payload.completedAt || new Date().toISOString();
      patch.hadAssistantText = Boolean(payload.hadAssistantText);
      patch.usage = payload.usage || null;
      patch.context = payload.context || null;
      patch.label = '任务已完成';
    } else if (payload.type === 'chat-error') {
      patch.status = 'failed';
      patch.error = payload.error || '任务失败';
      patch.label = '任务失败';
    } else if (payload.type === 'chat-aborted') {
      patch.status = 'aborted';
      patch.label = '已中止';
    } else {
      return;
    }

    if (payload.startedAt) {
      patch.startedAt = payload.startedAt;
    }
    if (payload.completedAt) {
      patch.completedAt = payload.completedAt;
    }
    if (payload.durationMs) {
      patch.durationMs = payload.durationMs;
    }

    rememberTurn(payload.turnId, patch);
  }

  return {
    getTurn: (turnId) => recentTurns.get(turnId) || null,
    rememberTurn,
    rememberTurnEvent,
    values: () => recentTurns.values()
  };
}
