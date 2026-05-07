export const SLASH_COMMANDS = [
  {
    id: 'status',
    token: '/状态',
    aliases: ['/status'],
    title: '状态',
    description: '查看上下文、额度和连接状态',
    action: 'open-context'
  },
  {
    id: 'plan',
    token: '/计划',
    aliases: ['/plan'],
    title: '计划模式',
    description: '让 Codex 先规划并等待你选择方案',
    action: 'set-mode',
    mode: 'plan'
  },
  {
    id: 'compact',
    token: '/压缩上下文',
    aliases: ['/compact'],
    title: '压缩上下文',
    description: '把旧上下文压缩成摘要，保持线程轻量',
    action: 'insert-prompt',
    prompt: '请压缩当前对话的旧上下文，保留关键决策、文件路径、未完成事项和后续执行入口。'
  },
  {
    id: 'review',
    token: '/代码审查',
    aliases: ['/review'],
    title: '代码审查',
    description: '检查当前改动的风险、bug 和遗漏测试',
    action: 'insert-prompt',
    prompt: '请以代码审查视角检查当前仓库改动，优先指出 bug、行为回归、风险和缺失测试，并给出具体文件位置。'
  },
  {
    id: 'subagents',
    token: '/子代理',
    aliases: ['/subagents'],
    title: '子代理',
    description: '提示 Codex 在适合时拆分并行任务',
    action: 'insert-prompt',
    prompt: '如果任务适合拆分，请使用子代理并行处理互不冲突的部分，然后汇总结果。'
  }
];

export function detectComposerToken(text, cursor = null) {
  const value = String(text || '');
  const end = Number.isInteger(cursor) ? Math.max(0, Math.min(cursor, value.length)) : value.length;
  const before = value.slice(0, end);
  const match = before.match(/(^|\s)([/@$])([^\s/@$]*)$/u);
  if (!match) {
    return null;
  }
  const marker = match[2];
  const query = match[3] || '';
  const markerIndex = end - marker.length - query.length;
  return {
    type: marker === '/' ? 'slash' : marker === '$' ? 'skill' : 'file',
    marker,
    query,
    start: markerIndex,
    end
  };
}

export function replaceComposerToken(text, token, replacement) {
  if (!token) {
    return String(text || '');
  }
  const value = String(text || '');
  const next = `${value.slice(0, token.start)}${replacement}${value.slice(token.end)}`;
  return next.replace(/[ \t]{2,}/g, ' ');
}

export function normalizeComposerMode(mode) {
  return mode === 'plan' ? 'plan' : 'chat';
}

export function selectedComposerModeForSession(modesBySession, sessionId, pendingMode = 'chat') {
  if (!sessionId) {
    return normalizeComposerMode(pendingMode);
  }
  return normalizeComposerMode(modesBySession?.[sessionId]);
}

export function migrateComposerMode(modesBySession, sourceSessionIds, targetSessionId) {
  const current = modesBySession || {};
  if (!targetSessionId) {
    return current;
  }
  const sourceIds = (Array.isArray(sourceSessionIds) ? sourceSessionIds : [sourceSessionIds])
    .filter((id) => id && id !== targetSessionId);
  const sourceId = sourceIds.find((id) => current[id]);
  if (!sourceId) {
    return current;
  }
  const next = { ...current, [targetSessionId]: normalizeComposerMode(current[sourceId]) };
  delete next[sourceId];
  return next;
}

export function filteredSlashCommands(query, commands = SLASH_COMMANDS) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return commands;
  }
  return commands.filter((command) => {
    const tokens = [command.token, command.title, command.description, ...(command.aliases || [])]
      .filter(Boolean)
      .map((item) => String(item).toLowerCase());
    return tokens.some((item) => item.includes(normalized));
  });
}
