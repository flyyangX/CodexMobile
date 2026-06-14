/**
 * 启动与管理 Codex CLI 子进程，解析流式输出并驱动一轮对话回合。
 *
 * Keywords: codex-runner, subprocess, streaming, abort, steer
 *
 * Exports:
 * - statusLabel / shouldCompleteTurnFromAppServerItem / appServerAgentMessagePhase — 状态与消息阶段判定辅助。
 * - runCodexTurn — 主演示路径：跑一轮 Codex。
 * - abortCodexTurn / getActiveRuns / steerCodexTurn — 控制运行中回合。
 *
 * Inward（本模块依赖/组装的关键符号）: Node child_process、服务层配置、runtime-debug。
 *
 * Outward（谁在用/调用场景）: chat-delivery、push、状态 API。
 *
 * 不负责: HTTP 请求解析。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeServiceTier } from '../shared/service-tier.js';
import { createCodexAppServerClient, defaultServerRequestResult } from './codex-app-server.js';
import { buildCodexTurnInput, imageMarkdownFromCodexImageGeneration } from './codex-native-images.js';
import { buildCodexLarkCliContext } from './lark-cli.js';
import { detectFeishuSkillKeys } from './feishu-skills.js';
import { codexSandboxForPermissionMode, desktopSandboxPolicyForPermissionMode } from './permission-policy.js';
import { readSecurityOptions } from './security-options.js';
import { createSyncEventPayload } from './sync/sync-events.js';

const activeRuns = new Map();
const NON_ASCII_PATH_PATTERN = /[^\u0000-\u007F]/;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const TURN_TIMEOUT_MS = parseTurnTimeoutMs(process.env.CODEXMOBILE_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS);
const TURN_INACTIVITY_TIMEOUT_MS = parseTurnTimeoutMs(
  process.env.CODEXMOBILE_TURN_INACTIVITY_TIMEOUT_MS,
  DEFAULT_TURN_INACTIVITY_TIMEOUT_MS
);
const INTERACTIVE_SERVER_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval'
]);

function parseTurnTimeoutMs(value, fallbackMs = DEFAULT_TURN_TIMEOUT_MS) {
  const timeoutMs = Number(value);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.max(1000, Math.floor(timeoutMs));
  }
  return fallbackMs;
}

function formatTimeoutDuration(timeoutMs) {
  if (timeoutMs >= 60_000) {
    return `${Math.round(timeoutMs / 60_000)} 分钟`;
  }
  return `${Math.round(timeoutMs / 1000)} 秒`;
}

function turnTimeoutError() {
  const error = new Error(`Codex turn timed out after ${formatTimeoutDuration(TURN_TIMEOUT_MS)}`);
  error.code = 'CODEXMOBILE_TURN_TIMEOUT';
  return error;
}

function turnInactivityTimeoutError() {
  const error = new Error(`Codex turn had no activity for ${formatTimeoutDuration(TURN_INACTIVITY_TIMEOUT_MS)}`);
  error.code = 'CODEXMOBILE_TURN_INACTIVITY_TIMEOUT';
  return error;
}

function isTurnTimeoutError(error) {
  return error?.code === 'CODEXMOBILE_TURN_TIMEOUT';
}

function isTurnInactivityTimeoutError(error) {
  return error?.code === 'CODEXMOBILE_TURN_INACTIVITY_TIMEOUT';
}

async function ensureAsciiWorkingDirectory(projectPath) {
  if (process.platform !== 'win32' || !NON_ASCII_PATH_PATTERN.test(projectPath)) {
    return projectPath;
  }

  const resolved = path.resolve(projectPath);
  const driveRoot = path.parse(resolved).root || 'C:\\';
  const aliasRoot = path.join(driveRoot, 'codex_project_aliases');
  const aliasName = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex');
  const aliasPath = path.join(aliasRoot, aliasName);

  await fs.mkdir(aliasRoot, { recursive: true });
  try {
    const stats = await fs.lstat(aliasPath);
    if (stats.isDirectory() || stats.isSymbolicLink()) {
      return aliasPath;
    }
    await fs.rm(aliasPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(resolved, aliasPath, 'junction');
  return aliasPath;
}

function mapPermissionMode(permissionMode) {
  return codexSandboxForPermissionMode(permissionMode, readSecurityOptions());
}

function normalizeReasoningEffort(reasoningEffort) {
  const value = String(reasoningEffort || '').trim();
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : undefined;
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'output_text' || part?.type === 'input_text' || part?.type === 'text') {
        return part.text || '';
      }
      return part?.text || '';
    })
    .filter(Boolean)
    .join('\n');
}

function contentFromItem(item) {
  if (!item) {
    return '';
  }
  const contentText = textFromContent(item.content);
  if (contentText) {
    return contentText;
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (typeof item.aggregated_output === 'string') {
    return item.aggregated_output;
  }
  if (typeof item.message === 'string') {
    return item.message;
  }
  return '';
}

export function statusLabel(kind, status = 'running') {
  const done = status === 'completed';
  const failed = status === 'failed';
  const labels = {
    turn: done ? '任务已完成' : failed ? '任务失败' : '正在处理',
    reasoning: done ? '思考完成' : '正在思考',
    agent_message: '正在回复',
    message: '正在回复',
    command_execution: done ? '本地任务已处理' : failed ? '本地任务失败' : '正在处理本地任务',
    file_change: done ? '文件已更新' : failed ? '文件更新失败' : '正在更新文件',
    mcp_tool_call: done ? '已完成一步操作' : failed ? '这一步操作失败' : '正在完成一步操作',
    dynamic_tool_call: done ? '已完成一步操作' : failed ? '这一步操作失败' : '正在完成一步操作',
    web_search: done ? '网页信息已查到' : failed ? '网页搜索失败' : '正在查找网页信息',
    plan: done ? '计划已更新' : '正在规划',
    plan_implementation: done ? '计划已确认执行' : '等待确认执行计划',
    todo_list: done ? '计划已更新' : '正在规划',
    image_generation_call: done ? '图片生成完成' : failed ? '图片生成失败' : '正在生成图片',
    context_compaction: '上下文已自动压缩',
    custom_tool_call: done ? '已完成一步操作' : failed ? '这一步操作失败' : '正在完成一步操作',
    function_call: done ? '已完成一步操作' : failed ? '这一步操作失败' : '正在完成一步操作',
    error: '出现错误'
  };
  return labels[kind] || (done ? '已完成' : failed ? '失败' : '正在处理');
}

function detailFromItem(item) {
  if (!item) {
    return '';
  }
  if (item.command) {
    return item.command;
  }
  if (item.query) {
    return item.query;
  }
  if (item.action?.query) {
    return item.action.query;
  }
  if (Array.isArray(item.action?.queries) && item.action.queries.length) {
    return item.action.queries.join('\n');
  }
  if (item.action?.url) {
    return item.action.url;
  }
  if (item.action?.pattern && item.action?.url) {
    return `${item.action.pattern} in ${item.action.url}`;
  }
  if (item.tool || item.server) {
    return [item.server, item.tool].filter(Boolean).join(' / ');
  }
  if (Array.isArray(item.changes)) {
    return item.changes.map((change) => `${change.kind || 'update'} ${change.path}`).join('\n');
  }
  if (item.message) {
    return item.message;
  }
  if (item.planContent) {
    return item.planContent;
  }
  return item.aggregatedOutput || contentFromItem(item);
}

function diffStats(unifiedDiff = '') {
  let additions = 0;
  let deletions = 0;
  for (const line of String(unifiedDiff || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function normalizeFileChanges(item) {
  const changes = item?.changes;
  if (Array.isArray(changes)) {
    return changes.map((change) => {
      const diff = change?.unified_diff || change?.diff || '';
      const stats = diffStats(diff);
      return {
        ...change,
        additions: Number(change?.additions) || stats.additions,
        deletions: Number(change?.deletions) || stats.deletions,
        unifiedDiff: diff,
        movePath: change?.move_path || change?.movePath || null
      };
    });
  }
  if (!changes || typeof changes !== 'object') {
    return [];
  }
  return Object.entries(changes).map(([filePath, change]) => {
    const stats = diffStats(change?.unified_diff || change?.diff || '');
    return {
      path: filePath,
      kind: change?.type || change?.kind || 'update',
      additions: Number(change?.additions) || stats.additions,
      deletions: Number(change?.deletions) || stats.deletions,
      unifiedDiff: change?.unified_diff || change?.diff || '',
      movePath: change?.move_path || null
    };
  });
}

function maybeIsoFromTimeValue(value) {
  if (typeof value === 'string' && value.trim() && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const millis = seconds > 10_000_000_000 ? seconds : seconds * 1000;
  return new Date(millis).toISOString();
}

function turnTimingPayload(turn, { fallbackStartedAt = null, fallbackCompletedAt = null } = {}) {
  const startedAt = maybeIsoFromTimeValue(turn?.startedAt) || fallbackStartedAt || null;
  const completedAt = maybeIsoFromTimeValue(turn?.completedAt) || fallbackCompletedAt || null;
  let durationMs = positiveNumber(turn?.durationMs);
  if (!durationMs && startedAt && completedAt) {
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(completedAt).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      durationMs = endMs - startMs;
    }
  }
  return { startedAt, completedAt, durationMs };
}

function emitStatus(emit, {
  sessionId,
  turnId,
  kind,
  status = 'running',
  label,
  detail = '',
  startedAt = null,
  completedAt = null,
  durationMs = null,
  timestamp = null
}) {
  const eventType = status === 'queued'
    ? 'turn.queued'
    : status === 'completed'
      ? 'turn.completed'
      : status === 'failed'
        ? 'turn.failed'
        : status === 'aborted'
          ? 'turn.aborted'
          : 'turn.running';
  emit(createSyncEventPayload(eventType, {
    sessionId,
    turnId,
    kind,
    status,
    label: label || statusLabel(kind, status),
    detail,
    timestamp: timestamp || completedAt || startedAt || new Date().toISOString(),
    startedAt,
    completedAt,
    durationMs
  }));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function emitContextStatus(emit, { sessionId, turnId, state, timestamp = new Date().toISOString() }) {
  const contextWindow = state.contextWindow || null;
  const inputTokens = state.inputTokens || null;
  const percent =
    inputTokens && contextWindow
      ? Math.max(0, Math.min(100, Math.round((inputTokens / contextWindow) * 1000) / 10))
      : null;
  emit(createSyncEventPayload('context.updated', {
    sessionId,
    turnId,
    inputTokens,
    totalTokens: state.totalTokens || null,
    contextWindow,
    percent,
    lastTokenUsage: state.lastTokenUsage || null,
    totalTokenUsage: state.totalTokenUsage || null,
    updatedAt: timestamp,
    autoCompact: {
      detected: Boolean(state.autoCompactDetected),
      status: state.autoCompactDetected ? 'detected' : 'watching',
      lastCompactedAt: state.autoCompactLastAt || null,
      reason: state.autoCompactReason || ''
    }
  }, {
    context: {
      inputTokens,
      totalTokens: state.totalTokens || null,
      contextWindow,
      percent,
      lastTokenUsage: state.lastTokenUsage || null,
      totalTokenUsage: state.totalTokenUsage || null,
      autoCompact: {
        detected: Boolean(state.autoCompactDetected),
        status: state.autoCompactDetected ? 'detected' : 'watching',
        lastCompactedAt: state.autoCompactLastAt || null,
        reason: state.autoCompactReason || ''
      }
    }
  }));
}

function applyTokenCountToContextState(contextState, payload, timestamp) {
  const info = payload?.info && typeof payload.info === 'object' ? payload.info : {};
  const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
  const total = info.total_token_usage && typeof info.total_token_usage === 'object' ? info.total_token_usage : {};
  const inputTokens = positiveNumber(last.input_tokens ?? total.input_tokens);
  const totalTokens = positiveNumber(total.total_tokens ?? last.total_tokens);
  const contextWindow = positiveNumber(info.model_context_window ?? payload?.model_context_window);
  const previousInputTokens = contextState.inputTokens;

  contextState.inputTokens = inputTokens || contextState.inputTokens || null;
  contextState.totalTokens = totalTokens || contextState.totalTokens || null;
  contextState.contextWindow = contextWindow || contextState.contextWindow || null;
  contextState.lastTokenUsage = last;
  contextState.totalTokenUsage = total;
  contextState.updatedAt = timestamp;

  if (
    previousInputTokens &&
    inputTokens &&
    previousInputTokens > 20000 &&
    inputTokens < previousInputTokens * 0.62
  ) {
    contextState.autoCompactDetected = true;
    contextState.autoCompactLastAt = timestamp;
    contextState.autoCompactReason = '上下文用量回落';
  }
}

function isSpawnPermissionError(error) {
  return error?.code === 'EPERM' && String(error?.syscall || '').startsWith('spawn');
}

function userFacingCodexError(error) {
  const message = String(error?.message || 'Codex task failed');
  if (process.platform === 'win32' && isSpawnPermissionError(error)) {
    return [
      'Codex 执行器启动被 Windows 拒绝（spawn EPERM）。',
      '通常是后台服务从受限环境启动导致的，请重启正式服务后再试。'
    ].join(' ');
  }
  return message;
}

function codexErrorDiagnostics(error) {
  return {
    message: error?.message || '',
    code: error?.code || '',
    errno: error?.errno || '',
    syscall: error?.syscall || '',
    path: error?.path || '',
    spawnargs: Array.isArray(error?.spawnargs) ? error.spawnargs : [],
    cwd: process.cwd(),
    execPath: process.execPath,
    pathLength: String(process.env.Path || process.env.PATH || '').length
  };
}

function emitActivity(emit, { sessionId, turnId, messageId, item, kind, status }) {
  const detail = detailFromItem(item);
  const requestTurnId = String(item?.turnId || '').trim();
  const planContent = String(item?.planContent || detail || '').trim();
  const planImplementation = kind === 'plan_implementation'
    ? {
      requestId: String(item?.id || (requestTurnId ? `implement-plan:${requestTurnId}` : messageId) || '').trim(),
      turnId: requestTurnId || turnId,
      planContent,
      completed: Boolean(item?.isCompleted || item?.completed || status === 'completed')
    }
    : null;
  const eventType = status === 'completed'
    ? 'activity.completed'
    : status === 'failed'
      ? 'activity.failed'
      : 'activity.updated';
  const activity = {
    kind,
    label: statusLabel(kind, status),
    status,
    detail,
    command: item?.command || '',
    output: item?.aggregated_output || item?.aggregatedOutput || item?.output || '',
    exitCode: item?.exitCode ?? item?.exit_code ?? null,
    fileChanges: normalizeFileChanges(item),
    planImplementation,
    toolName: item?.tool || item?.name || '',
    error: item?.error?.message || item?.message || ''
  };
  emit(createSyncEventPayload(eventType, {
    sessionId,
    turnId,
    messageId,
    kind,
    label: activity.label,
    status,
    detail,
    planImplementation,
    timestamp: new Date().toISOString()
  }, {
    activity,
    command: activity.command,
    output: activity.output,
    exitCode: activity.exitCode,
    fileChanges: activity.fileChanges,
    toolName: activity.toolName,
    error: activity.error
  }));
}

function sandboxPolicyFromPermissionMode(permissionMode, { networkAccess = false } = {}) {
  return desktopSandboxPolicyForPermissionMode(permissionMode, {
    ...readSecurityOptions(),
    networkAccess: Boolean(networkAccess),
    writableRoots: []
  });
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
    'plan-implementation': 'plan_implementation',
    reasoning: 'reasoning',
    userMessage: 'user_message'
  };
  return kinds[type] || type || 'item';
}

function appItemStatus(method, item) {
  const raw = typeof item?.status === 'string' ? item.status.toLowerCase() : '';
  if (method === 'item/completed') {
    if (['failed', 'error', 'cancelled', 'canceled'].includes(raw)) {
      return 'failed';
    }
    return 'completed';
  }
  if (['completed', 'success', 'succeeded'].includes(raw)) {
    return 'completed';
  }
  if (['failed', 'error'].includes(raw)) {
    return 'failed';
  }
  return 'running';
}

export function shouldCompleteTurnFromAppServerItem(method, item, content = '') {
  if (method !== 'item/completed' || item?.type !== 'agentMessage') {
    return false;
  }
  if (String(item?.phase || '').toLowerCase() === 'commentary') {
    return false;
  }
  if (appItemStatus(method, item) !== 'completed') {
    return false;
  }
  return Boolean(String(content || item?.text || '').trim());
}

function normalizeAppItem(item, state = {}) {
  if (!item || typeof item !== 'object') {
    return item;
  }
  const copy = { ...item, type: appItemKind(item.type) };
  if (item.aggregatedOutput && !copy.aggregated_output) {
    copy.aggregated_output = item.aggregatedOutput;
  }
  if (item.type === 'dynamicToolCall') {
    copy.tool = item.tool;
    copy.name = item.tool;
  }
  if (item.type === 'imageGeneration') {
    copy.message = item.revisedPrompt || item.result || '';
  }
  if (state.commandOutputs?.has(item.id)) {
    copy.aggregatedOutput = state.commandOutputs.get(item.id);
    copy.aggregated_output = copy.aggregatedOutput;
  }
  return copy;
}

function emitNativeImageResult(emit, { sessionId, turnId, messageId, item, status, state }) {
  if (status !== 'completed') {
    return false;
  }
  const content = imageMarkdownFromCodexImageGeneration(item);
  if (!content) {
    return false;
  }
  emit(createSyncEventPayload('message.assistant.completed', {
    sessionId,
    turnId,
    messageId: `${messageId}-result`,
    role: 'assistant',
    kind: 'image_generation_result',
    phase: 'final_answer',
    content,
    status: 'completed',
    done: true
  }, {
    message: {
      id: `${messageId}-result`,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
      sessionId,
      turnId,
      done: true,
      phase: 'final_answer'
    }
  }));
  state.hadAssistantText = true;
  return true;
}

export function appServerAgentMessagePhase(params = {}, state = {}, messageId = '') {
  const directPhase = String(params.phase || params.item?.phase || '').trim().toLowerCase();
  if (directPhase) {
    return directPhase;
  }
  const itemId = messageId || params.itemId || params.item?.id || '';
  const knownItem = itemId && state.items?.get ? state.items.get(itemId) : null;
  return String(knownItem?.phase || '').trim().toLowerCase();
}

function tokenUsagePayload(tokenUsage = {}) {
  const last = tokenUsage.last || {};
  const total = tokenUsage.total || {};
  return {
    info: {
      last_token_usage: {
        input_tokens: last.inputTokens,
        cached_input_tokens: last.cachedInputTokens,
        output_tokens: last.outputTokens,
        reasoning_output_tokens: last.reasoningOutputTokens,
        total_tokens: last.totalTokens
      },
      total_token_usage: {
        input_tokens: total.inputTokens,
        cached_input_tokens: total.cachedInputTokens,
        output_tokens: total.outputTokens,
        reasoning_output_tokens: total.reasoningOutputTokens,
        total_tokens: total.totalTokens
      },
      model_context_window: tokenUsage.modelContextWindow
    }
  };
}

function errorTextFromNotification(params = {}) {
  return params.error?.message || params.message || params.error || 'Codex turn failed';
}

function emitAppServerItem({ method, params }, sessionId, turnId, emit, state) {
  const rawItem = params?.item;
  if (!rawItem || rawItem.type === 'userMessage') {
    return;
  }

  const item = normalizeAppItem(rawItem, state);
  const status = appItemStatus(method, rawItem);
  const messageId = rawItem.id || `${turnId}-${item.type}`;

  if (rawItem.type === 'agentMessage') {
    const content = String(rawItem.text || state.agentMessages?.get(messageId) || '').trimEnd();
    if (!content.trim()) {
      return;
    }
    const isCommentary = rawItem.phase === 'commentary';
    if (!isCommentary) {
      state.hadAssistantText = true;
      if (shouldCompleteTurnFromAppServerItem(method, rawItem, content)) {
        state.scheduleFallbackTurnCompletion?.({
          completedAt: new Date().toISOString(),
          fallback: 'final-assistant-item'
        });
      }
    }
    return;
  }

  if (rawItem.type === 'reasoning') {
    return;
  }

  if (rawItem.type === 'contextCompaction') {
    const timestamp = new Date().toISOString();
    state.context.autoCompactDetected = true;
    state.context.autoCompactLastAt = timestamp;
    state.context.autoCompactReason = '上下文已自动压缩';
    emitContextStatus(emit, { sessionId, turnId, state: state.context, timestamp });
  }

  if (rawItem.type === 'imageGeneration') {
    emitNativeImageResult(emit, { sessionId, turnId, messageId, item: rawItem, status, state });
  }
}

function emitAppServerNotification(message, sessionId, turnId, emit, state) {
  const { method, params = {} } = message;

  if (method === 'turn/started') {
    return;
  }

  if (method === 'thread/tokenUsage/updated') {
    const timestamp = new Date().toISOString();
    applyTokenCountToContextState(state.context, tokenUsagePayload(params.tokenUsage), timestamp);
    emitContextStatus(emit, { sessionId, turnId, state: state.context, timestamp });
    return;
  }

  if (method === 'thread/compacted') {
    const timestamp = new Date().toISOString();
    state.context.autoCompactDetected = true;
    state.context.autoCompactLastAt = timestamp;
    state.context.autoCompactReason = '上下文已自动压缩';
    emitContextStatus(emit, { sessionId, turnId, state: state.context, timestamp });
    emit(createSyncEventPayload('activity.completed', {
      sessionId,
      turnId,
      messageId: `${turnId}-context-compaction-${Date.now()}`,
      kind: 'context_compaction',
      label: '上下文已自动压缩',
      status: 'completed',
      detail: '',
      timestamp
    }, {
      activity: {
        kind: 'context_compaction',
        label: '上下文已自动压缩',
        status: 'completed',
        detail: ''
      }
    }));
    return;
  }

  if (method === 'item/agentMessage/delta') {
    const messageId = params.itemId || `${turnId}-agent-message`;
    const previous = state.agentMessages.get(messageId) || '';
    const content = `${previous}${params.delta || ''}`;
    state.agentMessages.set(messageId, content);
    const phase = appServerAgentMessagePhase(params, state, messageId);
    if (content.trim() && phase !== 'commentary') {
      state.hadAssistantText = true;
    }
    return;
  }

  if (method === 'item/commandExecution/outputDelta') {
    const itemId = params.itemId || `${turnId}-command`;
    const previous = state.commandOutputs.get(itemId) || '';
    state.commandOutputs.set(itemId, `${previous}${params.delta || ''}`);
    const item = normalizeAppItem(state.items.get(itemId) || { id: itemId, type: 'commandExecution' }, state);
    emitActivity(emit, {
      sessionId,
      turnId,
      messageId: itemId,
      item,
      kind: 'command_execution',
      status: 'running'
    });
    return;
  }

  if (method === 'item/fileChange/outputDelta') {
    const itemId = params.itemId || `${turnId}-file-change`;
    const previous = state.commandOutputs.get(itemId) || '';
    state.commandOutputs.set(itemId, `${previous}${params.delta || ''}`);
    const item = normalizeAppItem(state.items.get(itemId) || { id: itemId, type: 'fileChange' }, state);
    emitActivity(emit, {
      sessionId,
      turnId,
      messageId: itemId,
      item,
      kind: 'file_change',
      status: 'running'
    });
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    if (params.item?.id) {
      state.items.set(params.item.id, params.item);
    }
    emitAppServerItem(message, sessionId, turnId, emit, state);
    return;
  }

  if (method === 'error' && !params.willRetry) {
    state.failed = true;
  }
}

function emitPlanImplementationRequest(message, sessionId, turnId, emit) {
  const params = message?.params || {};
  const requestTurnId = String(params.turnId || '').trim();
  const requestThreadId = String(params.threadId || sessionId || '').trim();
  const planContent = String(params.planContent || '').trim();
  const requestId = String(message?.id || (requestTurnId ? `implement-plan:${requestTurnId}` : '')).trim();
  const content = /<proposed_plan\b/i.test(planContent)
    ? planContent
    : `<proposed_plan>\n${planContent}\n</proposed_plan>`;
  emit(createSyncEventPayload('message.assistant.completed', {
    sessionId: requestThreadId || sessionId,
    turnId,
    messageId: requestId || `${turnId}-plan-implementation`,
    role: 'assistant',
    kind: 'agent_message',
    phase: 'final_answer',
    content,
    status: 'completed',
    done: true,
    timestamp: new Date().toISOString(),
    planImplementation: {
      requestId: requestId || (requestTurnId ? `implement-plan:${requestTurnId}` : ''),
      turnId: requestTurnId || turnId,
      planContent,
      completed: false
    }
  }, {
    message: {
      id: requestId || `${turnId}-plan-implementation`,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
      sessionId: requestThreadId || sessionId,
      turnId,
      done: true,
      phase: 'final_answer',
      planImplementation: {
        requestId: requestId || (requestTurnId ? `implement-plan:${requestTurnId}` : ''),
        turnId: requestTurnId || turnId,
        planContent,
        completed: false
      }
    }
  }));
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export async function runCodexTurn({ sessionId, draftSessionId, projectPath, message, attachments = [], selectedSkills = [], model, reasoningEffort, serviceTier, permissionMode, collaborationMode = null, turnId: providedTurnId, onCodexServerRequest = null }, emit) {
  const workingDirectory = await ensureAsciiWorkingDirectory(projectPath);
  const { sandboxMode, approvalPolicy } = mapPermissionMode(permissionMode);
  const feishuSkillKeys = detectFeishuSkillKeys(message);
  const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
  const normalizedServiceTier = normalizeServiceTier(serviceTier);
  const modelReasoningEffort =
    feishuSkillKeys.length && normalizedReasoningEffort === 'xhigh' ? 'low' : normalizedReasoningEffort;
  const larkCliContext = await buildCodexLarkCliContext(message).catch((error) => {
    console.warn('[lark-cli] Codex context disabled:', error.message);
    return { enabled: false, env: { ...process.env }, instruction: '' };
  });
  const abortController = new AbortController();
  const turnId = providedTurnId || crypto.randomUUID();
  const state = {
    hadAssistantText: false,
    failed: false,
    usage: null,
    context: {},
    agentMessages: new Map(),
    commandOutputs: new Map(),
    items: new Map(),
    fallbackCompletionTimer: null,
    turnCompletionResolved: false,
    sawAppTurnCompleted: false,
    scheduleFallbackTurnCompletion: null
  };
  const run = {
    thread: null,
    client: null,
    appTurnId: null,
    abortController,
    turnId,
    sessionId: sessionId || draftSessionId || null,
    previousSessionId: draftSessionId || sessionId || null,
    startedAt: new Date().toISOString(),
    status: 'running'
  };
  activeRuns.set(turnId, run);

  let currentSessionId = sessionId || null;
  let previousSessionId = draftSessionId || sessionId || null;
  let client = null;
  let completionResolve = null;
  let completionReject = null;
  const completionPromise = new Promise((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });
  function resolveTurnCompletion(turn = {}) {
    if (state.turnCompletionResolved) {
      return;
    }
    state.turnCompletionResolved = true;
    completionResolve(turn);
  }
  state.scheduleFallbackTurnCompletion = (turn = {}) => {
    if (state.turnCompletionResolved || state.fallbackCompletionTimer) {
      return;
    }
    state.fallbackCompletionTimer = setTimeout(() => resolveTurnCompletion(turn), 750);
    if (typeof state.fallbackCompletionTimer.unref === 'function') {
      state.fallbackCompletionTimer.unref();
    }
  };
  function emitAppServerSync(appMessage) {
    emit({
      type: 'app-server-message',
      appMessage,
      context: {
        source: 'headless-local',
        sessionId: currentSessionId || sessionId || draftSessionId || '',
        previousSessionId,
        draftSessionId,
        turnId,
        clientTurnId: turnId,
        appTurnId: run.appTurnId || null,
        startedAt: run.startedAt,
        agentMessages: state.agentMessages,
        items: state.items
      }
    });
  }
  const abortPromise = new Promise((_, reject) => {
    abortController.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  abortPromise.catch(() => {
    // The abort can arrive before the turn reaches Promise.race; keep Node from treating it as unhandled.
  });
  let turnTimeoutTimer = null;
  let turnInactivityTimeoutTimer = null;
  let resetTurnInactivityTimeout = () => {};

  try {
    if (larkCliContext.enabled && larkCliContext.env) {
      larkCliContext.env.CODEXMOBILE_TURN_ID = turnId;
      larkCliContext.env.CODEXMOBILE_SESSION_ID = sessionId || draftSessionId || '';
    }

    client = await createCodexAppServerClient({
      env: larkCliContext.env || { ...process.env },
      cwd: workingDirectory,
      clientInfo: { name: 'CodexMobile', title: null, version: '0.1.0' },
      allowHeadlessLocal: true,
      transport: {
        mode: 'headless-local',
        strict: false,
        sockPath: null,
        connected: true,
        reason: '移动端后台 Codex 执行固定使用独立 headless app-server'
      },
      onServerRequest: async (appMessage) => {
        resetTurnInactivityTimeout();
        if (INTERACTIVE_SERVER_REQUEST_METHODS.has(appMessage?.method)) {
          emitAppServerSync(appMessage);
        }
        if (appMessage?.method === 'item/plan/requestImplementation') {
          emitPlanImplementationRequest(appMessage, currentSessionId || sessionId || draftSessionId, turnId, emit);
        }
        if (typeof onCodexServerRequest === 'function' && INTERACTIVE_SERVER_REQUEST_METHODS.has(appMessage?.method)) {
          const result = await onCodexServerRequest(appMessage, {
            sessionId: currentSessionId || sessionId || draftSessionId || '',
            turnId,
            projectPath: workingDirectory
          });
          if (result !== null && result !== undefined) {
            return result;
          }
        }
        return defaultServerRequestResult(appMessage);
      },
      onNotification: (appMessage) => {
        resetTurnInactivityTimeout();
        const params = appMessage.params || {};
        if (appMessage.method === 'thread/started' && params.thread?.id) {
          const fromSessionId = previousSessionId || currentSessionId || draftSessionId || params.thread.id;
          currentSessionId = params.thread.id;
          run.sessionId = currentSessionId;
          run.previousSessionId = fromSessionId;
          emitAppServerSync(appMessage);
          return;
        }
        if (appMessage.method === 'turn/started' && params.turn?.id) {
          run.appTurnId = params.turn.id;
        }
        if (params.threadId && currentSessionId && params.threadId !== currentSessionId) {
          return;
        }
        emitAppServerSync(appMessage);
        emitAppServerNotification(appMessage, currentSessionId || sessionId || draftSessionId, turnId, emit, state);
        if (appMessage.method === 'turn/completed') {
          state.sawAppTurnCompleted = true;
          state.usage = params.turn || null;
          resolveTurnCompletion(params.turn || {});
        } else if (appMessage.method === 'error' && !params.willRetry) {
          completionReject(new Error(errorTextFromNotification(params)));
        }
      }
    });

    const threadParams = {
      cwd: workingDirectory,
      approvalPolicy,
      sandbox: sandboxMode,
      model: model || null,
      config: modelReasoningEffort ? { model_reasoning_effort: modelReasoningEffort } : null,
      serviceName: 'CodexMobile'
    };
    if (normalizedServiceTier) {
      threadParams.serviceTier = normalizedServiceTier;
    }
    const threadResponse = sessionId
      ? await client.request('thread/resume', { threadId: sessionId, ...threadParams }, { timeoutMs: 30_000 })
      : await client.request('thread/start', threadParams, { timeoutMs: 30_000 });
    const desktopThread = threadResponse?.thread || {};
    currentSessionId = desktopThread.id || sessionId || `codex-${Date.now()}`;
    run.thread = desktopThread;
    run.client = client;
    run.sessionId = currentSessionId;
    emitStatus(emit, { sessionId: currentSessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });

    const turnStartParams = {
      threadId: currentSessionId,
      input: buildCodexTurnInput({
        message,
        attachments,
        selectedSkills,
        larkInstruction: larkCliContext.enabled ? larkCliContext.instruction : ''
      }),
      cwd: workingDirectory,
      approvalPolicy,
      sandboxPolicy: sandboxPolicyFromPermissionMode(permissionMode, { networkAccess: larkCliContext.enabled }),
      model: model || null,
      effort: modelReasoningEffort || null,
      collaborationMode: collaborationMode || null
    };
    if (normalizedServiceTier) {
      turnStartParams.serviceTier = normalizedServiceTier;
    }
    const turnResponse = await client.request('turn/start', turnStartParams, { timeoutMs: 30_000 });
    if (turnResponse?.turn?.id) {
      run.appTurnId = turnResponse.turn.id;
    }
    const turnTimeoutPromise = new Promise((_, reject) => {
      turnTimeoutTimer = setTimeout(() => reject(turnTimeoutError()), TURN_TIMEOUT_MS);
      if (typeof turnTimeoutTimer.unref === 'function') {
        turnTimeoutTimer.unref();
      }
    });
    const turnInactivityTimeoutPromise = new Promise((_, reject) => {
      resetTurnInactivityTimeout = () => {
        if (turnInactivityTimeoutTimer) {
          clearTimeout(turnInactivityTimeoutTimer);
        }
        turnInactivityTimeoutTimer = setTimeout(
          () => reject(turnInactivityTimeoutError()),
          TURN_INACTIVITY_TIMEOUT_MS
        );
        if (typeof turnInactivityTimeoutTimer.unref === 'function') {
          turnInactivityTimeoutTimer.unref();
        }
      };
      resetTurnInactivityTimeout();
    });

    await Promise.race([
      completionPromise,
      abortPromise,
      turnTimeoutPromise,
      turnInactivityTimeoutPromise,
      client.closed.then(({ error }) => {
        if (error && run.status !== 'aborted') {
          throw error;
        }
        if (run.status !== 'aborted') {
          throw new Error('Codex app-server closed before the turn completed');
        }
      })
    ]);

    if (!state.failed && !state.sawAppTurnCompleted) {
      const timing = turnTimingPayload(state.usage, {
        fallbackStartedAt: run.startedAt,
        fallbackCompletedAt: new Date().toISOString()
      });
      emit(createSyncEventPayload('turn.completed', {
        sessionId: currentSessionId,
        previousSessionId,
        turnId,
        usage: state.usage,
        context: state.context,
        hadAssistantText: state.hadAssistantText,
        ...timing
      }, {
        usage: state.usage,
        context: state.context,
        hadAssistantText: state.hadAssistantText
      }));
    }
  } catch (error) {
    const timedOut = isTurnTimeoutError(error);
    const inactiveTimedOut = isTurnInactivityTimeoutError(error);
    if (timedOut || inactiveTimedOut) {
      run.status = 'timeout';
      if (client && currentSessionId && run.appTurnId) {
        await client.request('turn/interrupt', {
          threadId: currentSessionId,
          turnId: run.appTurnId
        }, { timeoutMs: 5_000 }).catch((interruptError) => {
          console.warn('[codex] Failed to interrupt timed out turn:', interruptError.message);
        });
      }
    }
    const wasAborted =
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted') ||
      activeRuns.get(turnId)?.status === 'aborted';
    const userError = timedOut
      ? `任务超过 ${formatTimeoutDuration(TURN_TIMEOUT_MS)} 没有完成，已自动中止。可以重新发送一次。`
      : inactiveTimedOut
        ? `任务超过 ${formatTimeoutDuration(TURN_INACTIVITY_TIMEOUT_MS)} 没有任何进度，已自动中止。可以重新发送一次。`
      : userFacingCodexError(error);

    emit(createSyncEventPayload(wasAborted ? 'turn.aborted' : 'turn.failed', {
      sessionId: currentSessionId,
      turnId,
      error: wasAborted ? null : userError,
      detail: wasAborted ? '' : userError,
      status: wasAborted ? 'aborted' : 'failed',
      completedAt: new Date().toISOString()
    }));
    if (!wasAborted) {
      console.error('[codex] Chat error:', codexErrorDiagnostics(error));
      emitStatus(emit, {
        sessionId: currentSessionId,
        turnId,
        kind: 'turn',
        status: 'failed',
        label: '任务失败',
        detail: userError
      });
    }
  } finally {
    if (turnTimeoutTimer) {
      clearTimeout(turnTimeoutTimer);
    }
    if (turnInactivityTimeoutTimer) {
      clearTimeout(turnInactivityTimeoutTimer);
    }
    if (state.fallbackCompletionTimer) {
      clearTimeout(state.fallbackCompletionTimer);
    }
    if (client) {
      client.close();
    }
    if (activeRuns.has(turnId)) {
      const activeRun = activeRuns.get(turnId);
      activeRun.status = activeRun.status === 'aborted' ? 'aborted' : 'completed';
      activeRuns.delete(turnId);
    }
  }

  return currentSessionId;
}

function runMatchesIdentifier(run, identifier) {
  return (
    Boolean(identifier) &&
    (run.turnId === identifier || run.sessionId === identifier || run.previousSessionId === identifier)
  );
}

export function abortCodexTurn(identifier) {
  const id = String(identifier || '').trim();
  const runs = [...activeRuns.values()].filter(
    (run) => run.status === 'running' && runMatchesIdentifier(run, id)
  );
  if (!runs.length) {
    return false;
  }
  for (const run of runs) {
    run.status = 'aborted';
    if (run.client && run.sessionId && run.appTurnId) {
      run.client.request('turn/interrupt', {
        threadId: run.sessionId,
        turnId: run.appTurnId
      }, { timeoutMs: 5_000 }).catch((error) => {
        console.warn('[codex] Failed to interrupt turn:', error.message);
      });
    }
    run.abortController.abort();
  }
  return true;
}

export function getActiveRuns() {
  return [...activeRuns.values()]
    .filter((run) => run.status === 'running')
    .map((run) => ({
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId,
      startedAt: run.startedAt,
      status: run.status,
      turnId: run.turnId,
      steerable: Boolean(run.appTurnId),
      source: 'headless-local',
      context: run.context || null
    }));
}

export async function steerCodexTurn(identifier, { message, attachments = [], selectedSkills = [] } = {}) {
  const id = String(identifier || '').trim();
  const run = [...activeRuns.values()].find(
    (item) => item.status === 'running' && runMatchesIdentifier(item, id)
  );
  if (!run) {
    const error = new Error('当前桌面端没有可引导的运行任务');
    error.statusCode = 409;
    error.code = 'NO_ACTIVE_TURN';
    throw error;
  }
  if (!run.client || !run.sessionId || !run.appTurnId) {
    const error = new Error('当前任务暂时不能接收运行中消息');
    error.statusCode = 409;
    error.code = 'ACTIVE_TURN_NOT_STEERABLE';
    throw error;
  }

  try {
    const response = await run.client.request('turn/steer', {
      threadId: run.sessionId,
      expectedTurnId: run.appTurnId,
      input: buildCodexTurnInput({ message, attachments, selectedSkills })
    }, { timeoutMs: 30_000 });
    return {
      accepted: true,
      delivery: 'steered',
      sessionId: run.sessionId,
      turnId: run.turnId,
      appTurnId: response?.turnId || run.appTurnId
    };
  } catch (error) {
    const text = String(error?.message || '');
    if (
      /active.*not.*steerable|no active turn to steer|cannot steer|expected active turn id/i.test(text) ||
      error?.code === 'ActiveTurnNotSteerable'
    ) {
      const steerError = new Error('当前桌面端任务不能接收运行中消息，可以加入队列或中止后发送。');
      steerError.statusCode = 409;
      steerError.code = 'ACTIVE_TURN_NOT_STEERABLE';
      steerError.detail = text;
      throw steerError;
    }
    throw error;
  }
}
