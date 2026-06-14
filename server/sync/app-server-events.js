/**
 * 将官方 Codex app-server v2 的 JSON-RPC 消息归一化为 CodexMobile SyncEvent。
 *
 * Keywords: app-server-v2, sync-event, thread, turn, item, interaction
 *
 * Exports:
 * - normalizeAppServerMessageToSyncEvents — 把 app-server notification/request 投影到同步事件。
 *
 * Inward（本模块依赖/组装的关键符号）: 标准 JSON-RPC app-server 消息与调用方传入的会话上下文。
 *
 * Outward（谁在用/调用场景）: sync-bridge、codex-runner 官方协议对齐路径。
 *
 * 不负责: WebSocket 发送与 Codex 子进程生命周期。
 */

const INTERACTION_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval'
]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  const text = String(value || '').trim();
  return text || null;
}

function eventId(prefix = 'app-server') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function appItemKind(type) {
  const kinds = {
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    dynamicToolCall: 'dynamic_tool_call',
    webSearch: 'web_search',
    imageGeneration: 'image_generation_call',
    contextCompaction: 'context_compaction',
    plan: 'plan',
    planImplementation: 'plan_implementation',
    reasoning: 'reasoning',
    userMessage: 'user_message',
    collabAgentToolCall: 'collab_agent_tool_call',
    subAgentActivity: 'sub_agent_activity'
  };
  return kinds[type] || type || 'item';
}

function statusForItem(method, item = {}) {
  const raw = String(item.status || '').trim().toLowerCase();
  if (method === 'item/completed') {
    return ['failed', 'error', 'cancelled', 'canceled'].includes(raw) ? 'failed' : 'completed';
  }
  if (['completed', 'success', 'succeeded'].includes(raw)) {
    return 'completed';
  }
  if (['failed', 'error'].includes(raw)) {
    return 'failed';
  }
  return 'running';
}

function activityEventType(status) {
  if (status === 'failed') return 'activity.failed';
  if (status === 'completed') return 'activity.completed';
  return 'activity.updated';
}

function itemDetail(item = {}) {
  if (item.command) return item.command;
  if (item.query) return item.query;
  if (item.tool || item.server) return [item.server, item.tool].filter(Boolean).join(' / ');
  if (Array.isArray(item.changes)) {
    return item.changes.map((change) => `${change.kind || 'update'} ${change.path || change.file || ''}`.trim()).join('\n');
  }
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.join('\n');
  if (Array.isArray(item.content) && item.content.length) return item.content.join('\n');
  return item.text || item.message || item.aggregatedOutput || item.aggregated_output || '';
}

function itemLabel(kind, status) {
  const done = status === 'completed';
  const failed = status === 'failed';
  const labels = {
    reasoning: done ? '思考完成' : '正在思考',
    command_execution: done ? '本地任务已处理' : failed ? '本地任务失败' : '正在处理本地任务',
    file_change: done ? '文件已更新' : failed ? '文件更新失败' : '正在更新文件',
    mcp_tool_call: done ? '已完成一步操作' : failed ? '这一步操作失败' : '正在完成一步操作',
    dynamic_tool_call: done ? '已完成一步操作' : failed ? '这一步操作失败' : '正在完成一步操作',
    web_search: done ? '网页信息已查到' : failed ? '网页搜索失败' : '正在查找网页信息',
    plan: done ? '计划已更新' : '正在规划',
    plan_implementation: done ? '计划已确认执行' : '等待确认执行计划',
    context_compaction: '上下文已自动压缩',
    image_generation_call: done ? '图片生成完成' : failed ? '图片生成失败' : '正在生成图片'
  };
  return labels[kind] || (done ? '已完成' : failed ? '失败' : '正在处理');
}

function resolveSessionId(params = {}, context = {}) {
  return clean(params.threadId) || clean(params.thread?.id) || clean(context.sessionId) || clean(context.draftSessionId);
}

function resolveClientTurnId(context = {}) {
  return clean(context.clientTurnId) || clean(context.turnId);
}

function resolveAppTurnId(params = {}, context = {}) {
  return clean(params.turn?.id) || clean(params.turnId) || clean(context.appTurnId);
}

function baseEvent(appMessage = {}, context = {}, eventType, extra = {}) {
  const params = appMessage.params || {};
  const timestamp = clean(context.timestamp) || nowIso();
  const clientTurnId = resolveClientTurnId(context);
  const appTurnId = resolveAppTurnId(params, context);
  return {
    id: eventId(eventType.replaceAll('/', '-').replaceAll('.', '-')),
    eventType,
    protocol: 'app-server-v2',
    appMethod: clean(appMessage.method),
    source: clean(context.source) || 'headless-local',
    projectId: clean(context.projectId),
    sessionId: resolveSessionId(params, context),
    previousSessionId: clean(context.previousSessionId),
    draftSessionId: clean(context.draftSessionId),
    turnId: clientTurnId || appTurnId,
    clientTurnId,
    appTurnId,
    status: clean(extra.status),
    label: clean(extra.label),
    detail: clean(extra.detail),
    startedAt: clean(context.startedAt),
    completedAt: clean(extra.completedAt),
    timestamp,
    ...extra
  };
}

function agentMessageEvent(method, params = {}, context = {}, appMessage = {}) {
  const item = params.item || {};
  const itemId = clean(params.itemId) || clean(item.id) || clean(context.itemId);
  const previous = itemId && context.agentMessages?.get ? context.agentMessages.get(itemId) : '';
  const delta = String(params.delta || '');
  const content = method === 'item/agentMessage/delta'
    ? `${previous || ''}${delta}`
    : String(item.text || previous || '');
  const phase = clean(params.phase) || clean(item.phase) || clean(context.items?.get?.(itemId)?.phase);
  const status = method === 'item/completed' ? 'completed' : 'running';
  if (!String(content || '').trim()) {
    return null;
  }
  return baseEvent(appMessage, context, status === 'completed' ? 'message.assistant.completed' : 'message.assistant.delta', {
    status,
    itemId,
    itemType: 'agentMessage',
    message: {
      id: itemId,
      role: 'assistant',
      content,
      sessionId: resolveSessionId(params, context),
      turnId: resolveClientTurnId(context) || resolveAppTurnId(params, context),
      done: status === 'completed',
      phase,
      timestamp: clean(context.timestamp) || nowIso()
    }
  });
}

function activityEvent(method, params = {}, context = {}, appMessage = {}) {
  const item = params.item || {};
  if (!item || item.type === 'userMessage' || item.type === 'agentMessage') {
    return null;
  }
  const status = statusForItem(method, item);
  const kind = appItemKind(item.type);
  const itemId = clean(item.id) || `${resolveClientTurnId(context) || resolveAppTurnId(params, context) || 'turn'}-${kind}`;
  const detail = itemDetail(item);
  return baseEvent(appMessage, context, activityEventType(status), {
    status,
    itemId,
    itemType: item.type || null,
    activity: {
      ...item,
      id: itemId,
      messageId: itemId,
      itemId,
      sessionId: resolveSessionId(params, context),
      turnId: resolveClientTurnId(context) || resolveAppTurnId(params, context),
      kind,
      status,
      label: itemLabel(kind, status),
      detail,
      command: item.command || '',
      output: item.aggregated_output || item.aggregatedOutput || item.output || '',
      exitCode: item.exitCode ?? item.exit_code ?? null,
      timestamp: clean(context.timestamp) || nowIso()
    }
  });
}

function interactionKind(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') return 'command_approval';
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') return 'file_approval';
  if (method === 'item/permissions/requestApproval') return 'permissions_approval';
  if (method === 'item/tool/requestUserInput') return 'user_input';
  if (method === 'mcpServer/elicitation/request') return 'mcp_elicitation';
  return 'interaction';
}

export function normalizeAppServerMessageToSyncEvents(appMessage = {}, context = {}) {
  if (!appMessage || typeof appMessage !== 'object') {
    return [];
  }
  const method = String(appMessage.method || '').trim();
  const params = appMessage.params || {};

  if (method === 'thread/started') {
    return [
      baseEvent(appMessage, context, 'thread.started', {
        status: 'running',
        session: params.thread || null
      })
    ];
  }

  if (method === 'turn/started') {
    return [
      baseEvent(appMessage, context, 'turn.running', {
        status: 'running',
        appTurnId: clean(params.turn?.id) || clean(params.turnId) || clean(context.appTurnId),
        label: '正在思考'
      })
    ];
  }

  if (method === 'item/agentMessage/delta') {
    const event = agentMessageEvent(method, params, context, appMessage);
    return event ? [event] : [];
  }

  if (method === 'item/started' || method === 'item/completed') {
    if (params.item?.type === 'agentMessage') {
      const event = agentMessageEvent(method, params, context, appMessage);
      return event ? [event] : [];
    }
    const event = activityEvent(method, params, context, appMessage);
    return event ? [event] : [];
  }

  if (method === 'turn/completed') {
    const status = String(params.turn?.status || '').toLowerCase() === 'failed'
      ? 'failed'
      : String(params.turn?.status || '').toLowerCase() === 'interrupted'
        ? 'aborted'
        : 'completed';
    return [
      baseEvent(appMessage, context, status === 'failed' ? 'turn.failed' : status === 'aborted' ? 'turn.aborted' : 'turn.completed', {
        status,
        appTurnId: clean(params.turn?.id) || clean(params.turnId) || clean(context.appTurnId),
        completedAt: nowIso()
      })
    ];
  }

  if (method === 'error' && !params.willRetry) {
    return [
      baseEvent(appMessage, context, 'turn.failed', {
        status: 'failed',
        detail: params.error?.message || params.message || params.error || 'Codex turn failed',
        completedAt: nowIso()
      })
    ];
  }

  if (INTERACTION_REQUEST_METHODS.has(method) && appMessage.id !== undefined) {
    const requestId = String(appMessage.id);
    const interactionId = `interaction-${requestId}`;
    return [
      baseEvent(appMessage, context, 'interaction.requested', {
        status: 'pending',
        interaction: {
          id: interactionId,
          appRequestId: requestId,
          method,
          kind: interactionKind(method),
          title: params.title || method,
          params
        }
      })
    ];
  }

  return [];
}
