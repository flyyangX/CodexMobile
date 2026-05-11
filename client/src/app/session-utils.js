import { useEffect, useState } from 'react';
import { apiBlobFetch } from '../api.js';
import { normalizeContextStatus } from './context-status.js';
import { provisionalSessionTitle } from '../../../shared/session-title.js';

const EMPTY_CONTEXT_FALLBACK = {
  inputTokens: null,
  totalTokens: null,
  contextWindow: null,
  modelContextWindow: null,
  configuredContextWindow: null,
  maxContextWindow: null,
  percent: null,
  updatedAt: null,
  autoCompact: {
    enabled: false,
    tokenLimit: null,
    detected: false,
    status: 'unknown',
    lastCompactedAt: null,
    reason: ''
  }
};

export function formatTime(value) {
  if (!value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return '';
  }
}

export function subAgentRoleLabel(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'worker') {
    return '执行';
  }
  if (value === 'explorer') {
    return '探索';
  }
  return value || '子代理';
}

export function subAgentSubtitle(session) {
  const agent = session?.subAgent || {};
  const parts = ['子代理'];
  if (agent.nickname) {
    parts.push(agent.nickname);
  }
  if (agent.role) {
    parts.push(subAgentRoleLabel(agent.role));
  }
  if (agent.status === 'open') {
    parts.push('进行中');
  }
  return parts.join(' · ');
}

export function formatDuration(start, end = Date.now()) {
  const startMs = new Date(start || end).getTime();
  const endMs = new Date(end || Date.now()).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return '';
  }
  const totalSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    return '';
  }
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export function compactPath(value) {
  if (!value) {
    return '';
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : normalized;
}

export function emptyContextStatus(fallback = EMPTY_CONTEXT_FALLBACK) {
  return normalizeContextStatus(fallback, fallback);
}

export function safeStoredJsonArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function imageUrlWithRetry(url, retryKey) {
  if (!retryKey || /^data:image\//i.test(String(url || '').trim())) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}r=${retryKey}`;
}

const resolvedImageSourceCache = new Map();

export function isLocalImageSource(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('/generated/') || raw.startsWith('/assets/')) {
    return false;
  }
  return (
    /^file:\/\//i.test(raw) ||
    /^\/(?:Users|private|var|tmp|Volumes)\//.test(raw) ||
    /^~[\\/]/.test(raw) ||
    /^[A-Za-z]:[\\/]/.test(raw)
  );
}

export function isLocalFileSource(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('/api/') || raw.startsWith('/generated/') || raw.startsWith('/assets/')) {
    return false;
  }
  return (
    /^file:\/\//i.test(raw) ||
    /^\/(?:Users|private|var|tmp|Volumes)\//.test(raw) ||
    /^~[\\/]/.test(raw) ||
    /^[A-Za-z]:[\\/]/.test(raw)
  );
}

export function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localImageApiPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  return `/api/local-image?path=${encodeURIComponent(normalized)}`;
}

export function localFileApiPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  return `/api/local-file?path=${encodeURIComponent(normalized)}`;
}

export function localFilePreviewPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  const params = new URLSearchParams();
  params.set('path', normalized);
  return `/preview/file?${params.toString()}`;
}

export function dataImageObjectUrl(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([\s\S]+)$/i);
  if (!match) {
    return '';
  }
  const binary = atob(match[2].replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: match[1].toLowerCase() }));
}

export function cachedResolvedImageSource(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return null;
  }
  return resolvedImageSourceCache.get(raw) || null;
}

export function useResolvedImageSource(url, retryKey) {
  const [resolved, setResolved] = useState(() => cachedResolvedImageSource(url) || { src: '', local: false, error: false, cached: false });

  useEffect(() => {
    const raw = String(url || '').trim();
    if (!raw) {
      setResolved({ src: '', local: false, error: true });
      return undefined;
    }
    const cached = resolvedImageSourceCache.get(raw);
    if (cached) {
      setResolved(cached);
      return undefined;
    }
    if (/^data:image\//i.test(raw)) {
      try {
        const src = dataImageObjectUrl(raw);
        if (src) {
          const next = { src, local: false, error: false, cached: true };
          resolvedImageSourceCache.set(raw, next);
          setResolved(next);
          return undefined;
        }
      } catch {
        setResolved({ src: raw, local: false, error: false, cached: false });
        return undefined;
      }
    }
    if (!isLocalImageSource(raw)) {
      setResolved({ src: imageUrlWithRetry(raw, retryKey), local: false, error: false });
      return undefined;
    }

    let stopped = false;
    let objectUrl = '';
    setResolved({ src: '', local: true, error: false });
    apiBlobFetch(localImageApiPath(raw))
      .then((blob) => {
        if (stopped) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        const next = { src: objectUrl, local: true, error: false, cached: true };
        resolvedImageSourceCache.set(raw, next);
        setResolved(next);
      })
      .catch(() => {
        if (!stopped) {
          setResolved({ src: '', local: true, error: true });
        }
      });

    return () => {
      stopped = true;
      if (objectUrl && !resolvedImageSourceCache.has(raw)) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [url, retryKey]);

  return resolved;
}

export function createClientTurnId() {
  return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createDraftSession(project) {
  const now = new Date().toISOString();
  return {
    id: `draft-${project.id}-${Date.now()}`,
    projectId: project.id,
    title: '新对话',
    summary: '等待第一条消息',
    messageCount: 0,
    updatedAt: now,
    draft: true
  };
}

export function resolveNewConversationProject(targetProject, selectedProject, projects = []) {
  const list = Array.isArray(projects) ? projects : [];
  if (targetProject?.id) {
    return list.find((project) => project.id === targetProject.id) || targetProject;
  }
  return selectedProject || list.find((project) => project.projectless) || list[0] || null;
}

export function isDraftSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  return Boolean(session?.draft || id?.startsWith('draft-'));
}

export function sessionMessagesApiPath(sessionId, { limit = 120, activity = true } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (activity) {
    params.set('activity', '1');
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
}

export function titleFromFirstMessage(message) {
  return provisionalSessionTitle(message);
}

export function autoTitlePatch(title, phase = 'provisional') {
  return title ? { title, titleLocked: false, titleAutoGenerated: phase } : {};
}

export function payloadRunKeys(payload) {
  return [payload?.turnId, payload?.clientTurnId, payload?.sessionId, payload?.previousSessionId].filter(Boolean);
}

export function selectedRunKeys(session) {
  return [session?.id, session?.turnId].filter(Boolean);
}

export function upsertSessionInProject(current, projectId, session, replaceId = null) {
  if (!projectId || !session) {
    return current;
  }
  const existing = current[projectId] || [];
  const filtered = existing.filter((item) => item.id !== session.id && (!replaceId || item.id !== replaceId));
  return {
    ...current,
    [projectId]: [session, ...filtered]
  };
}

export function hasRunningKey(runningById, keys) {
  return keys.some((key) => Boolean(runningById[key]));
}

export function sessionRunKeys(session) {
  return [session?.id, session?.turnId, session?.previousSessionId].filter(Boolean);
}

export function isExternalThreadRuntimeSource(value) {
  return ['desktop-thread', 'desktop-ipc', 'headless-local'].includes(String(value || ''));
}

export function isExternalThreadRuntime(runtime) {
  return runtime?.status === 'running' && isExternalThreadRuntimeSource(runtime?.source);
}

export function isSessionIndexRuntime(runtime) {
  return runtime?.fromSessionIndex === true;
}

export function isLiveThreadRuntime(runtime) {
  return Boolean(runtime && !isSessionIndexRuntime(runtime));
}

export function isPersistentDesktopThreadRuntime(runtime) {
  return runtime?.status === 'running' && String(runtime?.source || '') === 'desktop-thread' && !isSessionIndexRuntime(runtime);
}

export function shouldClearRuntimeWhenNoActiveRuns(runtime) {
  return runtime?.status === 'running' && !isPersistentDesktopThreadRuntime(runtime);
}

export function externalThreadRuntimeById(threadRuntimeById = {}) {
  const next = {};
  for (const [key, runtime] of Object.entries(threadRuntimeById || {})) {
    if (isPersistentDesktopThreadRuntime(runtime)) {
      next[key] = runtime;
    }
  }
  return next;
}

function allProjectSessions(sessionsByProject = {}) {
  return Object.values(sessionsByProject || {}).flatMap((sessions) =>
    Array.isArray(sessions) ? sessions : []
  );
}

function runtimeFromSession(session) {
  if (!session?.id || session.runtime?.status !== 'running') {
    return null;
  }
  return {
    ...session.runtime,
    status: 'running',
    fromSessionIndex: true,
    source: session.runtime.source || 'desktop-thread',
    sessionId: session.runtime.sessionId || session.id,
    turnId: session.runtime.turnId || session.turnId || null,
    updatedAt: session.runtime.updatedAt || session.updatedAt || null,
    steerable: session.runtime.steerable === true
  };
}

export function reconcileThreadRuntimeWithSessions(threadRuntimeById = {}, sessionsByProject = {}) {
  const sessions = allProjectSessions(sessionsByProject);
  if (!sessions.length) {
    return threadRuntimeById || {};
  }

  const loadedSessionIds = new Set(sessions.map((session) => session?.id).filter(Boolean));
  const next = { ...(threadRuntimeById || {}) };
  for (const [key, runtime] of Object.entries(next)) {
    const sessionId = runtime?.sessionId || (loadedSessionIds.has(key) ? key : '');
    if (sessionId && loadedSessionIds.has(sessionId) && isSessionIndexRuntime(runtime)) {
      delete next[key];
    }
  }

  for (const session of sessions) {
    const runtime = runtimeFromSession(session);
    if (!runtime) {
      continue;
    }
    for (const key of [session.id, runtime.turnId].filter(Boolean)) {
      if (!next[key] || isSessionIndexRuntime(next[key])) {
        next[key] = runtime;
      }
    }
  }

  return next;
}

export function runningByIdWithSelectedActivity(runningById = {}, selectedSession = null, hasRunningActivity = false) {
  if (!hasRunningActivity || !selectedSession?.id) {
    return runningById || {};
  }
  const next = { ...(runningById || {}) };
  for (const key of sessionRunKeys(selectedSession)) {
    next[key] = true;
  }
  return next;
}

export function sessionRunBadgeState(session, {
  runningById = {},
  threadRuntimeById = {},
  completedSessionIds = {}
} = {}) {
  if (!session?.id) {
    return null;
  }
  const keys = sessionRunKeys(session);
  const runtimes = keys.map((key) => threadRuntimeById?.[key]).filter(isLiveThreadRuntime);
  if (runtimes.some((runtime) => runtime?.status === 'running') || hasRunningKey(runningById, keys)) {
    return 'running';
  }
  if (runtimes.some((runtime) => runtime?.status === 'failed')) {
    return 'failed';
  }
  if (runtimes.some((runtime) => runtime?.status === 'completed') || Boolean(completedSessionIds?.[session.id])) {
    return 'complete';
  }
  return null;
}

export function shouldPreserveLocalRunsFromStatus({
  activePollCount = 0,
  turnRefreshTimerCount = 0,
  forceClear = false
} = {}) {
  void turnRefreshTimerCount;
  if (forceClear) {
    return false;
  }
  return activePollCount > 0;
}

export function shouldDropRunningActivityWhenNoActiveRuns(message) {
  if (message?.role !== 'activity') {
    return false;
  }
  if (!['running', 'queued'].includes(String(message?.status || ''))) {
    return false;
  }
  if (message?.transient) {
    return false;
  }
  return String(message?.kind || '') !== 'desktop';
}

export function shouldDropRunningActivityMissingFromActiveRuns(message, activeRunKeys = new Set()) {
  if (!shouldDropRunningActivityWhenNoActiveRuns(message)) {
    return false;
  }
  const keys = payloadRunKeys(message);
  if (!keys.length) {
    return true;
  }
  return !keys.some((key) => activeRunKeys.has(key));
}

export function selectedSessionIsRunning({ running = false, hasRunningActivity = false } = {}) {
  return Boolean(running || hasRunningActivity);
}

function compactComposerActivityText(value, maxLength = 28) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function isGenericComposerActivityLabel(value) {
  const text = String(value || '').trim();
  return /^(正在思考中?|正在处理|正在回复|正在整理回复|处理中|运行中|queued|running)$/i.test(text);
}

function isVisibleComposerActivityStep(step, messageStatus) {
  if (!step) {
    return false;
  }
  const label = String(step.label || '').trim();
  const hasWorkDetail =
    Boolean(step.command || step.detail || step.output || step.error || step.toolName) ||
    (Array.isArray(step.fileChanges) && step.fileChanges.length > 0);
  if (isGenericComposerActivityLabel(label) && !hasWorkDetail) {
    return false;
  }
  if (step.kind === 'function_call_output' && messageStatus !== 'failed' && step.status !== 'failed') {
    return false;
  }
  return true;
}

function describeComposerActivityStep(step) {
  const label = String(step?.label || '').trim();
  const detail = String(step?.detail || step?.command || step?.toolName || '').trim();
  const source = `${step?.kind || ''} ${label} ${detail} ${step?.output || ''}`.toLowerCase();
  if (step?.kind === 'file_change' || Array.isArray(step?.fileChanges) && step.fileChanges.length) {
    return { type: 'edit', label: compactComposerActivityText(label || '编辑文件') };
  }
  if (step?.kind === 'command_execution' || /命令|shell|执行|npm|node|git|rg|sed|cat/.test(source)) {
    return { type: 'command', label: compactComposerActivityText(label || '运行命令') };
  }
  if (step?.kind === 'web_search' || /web_search|网页搜索|搜索网页/.test(source)) {
    return { type: 'web_search', label: compactComposerActivityText(label || '网页搜索') };
  }
  if (/搜索|查找|search/.test(source)) {
    return { type: 'search', label: compactComposerActivityText(label || '搜索') };
  }
  if (/编辑|修改|写入|替换|创建|删除|apply_patch/.test(source)) {
    return { type: 'edit', label: compactComposerActivityText(label || '编辑文件') };
  }
  if (/读取|查看|检查|探索|read|list|inspect/.test(source)) {
    return { type: 'explore', label: compactComposerActivityText(label || '探索文件') };
  }
  return { type: 'tool', label: compactComposerActivityText(label || '调用工具') };
}

export function buildComposerRunStatus(messages, running, now = Date.now()) {
  const activity = [...(messages || [])]
    .reverse()
    .find((message) => message.role === 'activity' && (message.status === 'running' || message.status === 'queued'));
  if (!running && !activity) {
    return null;
  }

  const steps = Array.isArray(activity?.activities) ? activity.activities : [];
  const visibleSteps = steps.filter((step) => isVisibleComposerActivityStep(step, activity?.status || 'running'));
  const activeStep = [...visibleSteps].reverse().find((step) => step.status === 'running' || step.status === 'queued') || null;
  const latestStep = activeStep || visibleSteps[visibleSteps.length - 1] || null;
  const startedAt = activity?.startedAt || activity?.timestamp || now;
  const duration = formatDuration(startedAt, now);
  let label = '正在思考';

  if (latestStep) {
    if (latestStep.kind === 'agent_message' || latestStep.kind === 'message') {
      label = '正在同步回复';
    } else if (activeStep) {
      label = describeComposerActivityStep(latestStep).label || latestStep.label || label;
    } else if (activity?.status === 'running' || activity?.status === 'queued') {
      label = '正在思考';
    } else {
      const descriptor = describeComposerActivityStep(latestStep);
      label = descriptor.type === 'command'
        ? '等待命令返回'
        : descriptor.type === 'edit'
          ? '文件变更已同步'
          : descriptor.type === 'web_search'
            ? '网页搜索已完成'
            : descriptor.label || latestStep.label || '等待下一步';
    }
  } else if (activity?.detail) {
    label = activity.detail;
  } else if (activity?.label && !isGenericComposerActivityLabel(activity.label)) {
    label = activity.label;
  }

  return {
    label: compactComposerActivityText(label) || '正在处理',
    duration,
    running: true
  };
}

export function hasVisibleAssistantForTurn(messages, payload) {
  const hasExactTurnMatch = messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
  if (hasExactTurnMatch) {
    return true;
  }

  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1
  );
  return messages.some(
    (message, index) =>
      message.role === 'assistant' &&
      index > latestUserIndex &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}
