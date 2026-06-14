/**
 * 客户端会话域工具集：时间路径格式化、本地文件/图片 URL、草稿与列表合并、桌面 thread runtime 判定与轮次可见性。
 *
 * Keywords: session-utils, draft-session, thread-runtime, running-activity, media
 *
 * Exports:
 * - 通用与展示 — `formatTime`、`formatRelativeShort`、`formatDuration*`、`subAgentRoleLabel`、`compactPath`、`safeStoredJsonArray` 等。
 * - 上下文与媒体 — `emptyContextStatus`、`imageUrlWithRetry`、`sourceMediaKind`、本地/远程源与 `local*ApiPath`、`localFilePreviewDataPath`、`remoteImageApiPath`、`dataImageObjectUrl`、`useResolvedImageSource`。
 * - 会话生命周期 — `createClientTurnId`、`createDraftSession`、`resolveNewConversationProject`、`resolveComposerGitProject`、`isDraftSession`、`sessionMessagesApiPath`、标题补丁、`upsertSessionInProject`。
 * - Runtime — `payloadRunKeys`、`selectedRunKeys`、`reconcileThreadRuntimeWithSessions`、`is*Runtime`、`selectedMessagesHaveActiveTurnActivity`、`sessionRunBadgeState`、`selectedSessionIsRunning`、`hasVisibleAssistantForTurn` 等。
 *
 * Inward: `api`（blob）；`context-status`；`shared/session-title`。
 *
 * Outward: `App`、`useTurnSubmission`、`useTurnRuntime`、`useSessionActions`、panels、chat、composer、live refresh 等。
 */

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
export const SESSION_MESSAGES_PAGE_SIZE = 120;

export function emptyMessagePage() {
  return {
    offset: 0,
    total: 0,
    hasMoreBefore: false,
    loadingOlder: false
  };
}

export function messagePageFromResponse(data = {}) {
  return {
    offset: Number.isFinite(Number(data.offset)) ? Number(data.offset) : 0,
    total: Number.isFinite(Number(data.total)) ? Number(data.total) : 0,
    hasMoreBefore: Boolean(data.hasMoreBefore),
    loadingOlder: false
  };
}

export function prependUniqueMessages(current = [], older = []) {
  const seen = new Set((Array.isArray(current) ? current : []).map((message) => String(message?.id || '')).filter(Boolean));
  const additions = (Array.isArray(older) ? older : []).filter((message) => {
    const id = String(message?.id || '').trim();
    if (!id) {
      return true;
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
  return [...additions, ...(Array.isArray(current) ? current : [])];
}

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

export function formatRelativeShort(value, now = Date.now()) {
  if (!value) {
    return '';
  }
  const ts = new Date(value).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(ts) || !Number.isFinite(nowMs)) {
    return '';
  }
  const diff = nowMs - ts;
  if (Math.abs(diff) < 60_000) {
    return '刚刚';
  }
  if (diff < 0) {
    return formatTime(value);
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天`;
  }
  if (diff < 30 * 86_400_000) {
    return `${Math.floor(diff / (7 * 86_400_000))} 周`;
  }
  return formatTime(value);
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
const IMAGE_SOURCE_PATTERN = /(?:^data:image\/|\.(?:png|jpe?g|webp|gif|svg|ico)(?:$|[:?#]))/i;
const VIDEO_SOURCE_PATTERN = /\.(?:mp4|m4v|mov|webm|ogv)(?:$|[:?#])/i;
const AUDIO_SOURCE_PATTERN = /\.(?:mp3|m4a|aac|wav|ogg|flac)(?:$|[:?#])/i;

export function sourceMediaKind(value, contentType = '') {
  const lowerType = String(contentType || '').toLowerCase();
  if (lowerType.startsWith('image/')) {
    return 'image';
  }
  if (lowerType.startsWith('video/')) {
    return 'video';
  }
  if (lowerType.startsWith('audio/')) {
    return 'audio';
  }
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (IMAGE_SOURCE_PATTERN.test(raw)) {
    return 'image';
  }
  if (VIDEO_SOURCE_PATTERN.test(raw)) {
    return 'video';
  }
  if (AUDIO_SOURCE_PATTERN.test(raw)) {
    return 'audio';
  }
  return '';
}

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

export function localPathFileName(value, fallback = 'file') {
  const normalized = String(value || '').replaceAll('\\', '/');
  const name = normalized.split('/').filter(Boolean).pop() || fallback;
  return name || fallback;
}

export function localImageApiPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  return `/api/local-image?path=${encodeURIComponent(normalized)}`;
}

export function remoteImageApiPath(value) {
  const raw = String(value || '').trim();
  return `/api/remote-image?url=${encodeURIComponent(raw)}`;
}

export function localFileApiPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  const fileName = localPathFileName(normalized);
  return `/api/local-file/${encodeURIComponent(fileName)}?path=${encodeURIComponent(normalized)}`;
}

export function localFilePreviewPath(value, options = {}) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  const params = new URLSearchParams();
  params.set('path', normalized);
  if (options?.embed) {
    params.set('embed', '1');
  }
  return `/preview/file?${params.toString()}`;
}

export function localFilePreviewDataPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  return `/api/local-file-preview?path=${encodeURIComponent(normalized)}`;
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
      if (/^https?:\/\//i.test(raw)) {
        let stopped = false;
        let objectUrl = '';
        setResolved({ src: '', local: false, error: false });
        apiBlobFetch(remoteImageApiPath(raw))
          .then((blob) => {
            if (stopped) {
              return;
            }
            objectUrl = URL.createObjectURL(blob);
            const next = { src: objectUrl, local: false, error: false, cached: true };
            resolvedImageSourceCache.set(raw, next);
            setResolved(next);
          })
          .catch(() => {
            if (!stopped) {
              setResolved({ src: imageUrlWithRetry(raw, retryKey), local: false, error: false });
            }
          });

        return () => {
          stopped = true;
          if (objectUrl && !resolvedImageSourceCache.has(raw)) {
            URL.revokeObjectURL(objectUrl);
          }
        };
      }
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

export function resolveComposerGitProject({ homeVisible = false, projects = [], selectedProject = null, selectedSession = null } = {}) {
  const realProject = (project) => (project?.id && !project.projectless ? project : null);
  if (homeVisible) {
    return realProject(selectedProject);
  }
  const projectId = selectedSession?.projectId || '';
  if (!projectId) {
    return null;
  }
  return realProject(
    selectedProject?.id === projectId
      ? selectedProject
      : (Array.isArray(projects) ? projects : []).find((project) => project.id === projectId)
  );
}

export function isDraftSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  return Boolean(session?.draft || id?.startsWith('draft-'));
}

export function sessionMessagesApiPath(sessionId, { limit = 120, activity = true, offset = null, latest = true } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (offset !== null && offset !== undefined) {
    params.set('offset', String(offset));
  }
  if (!latest) {
    params.set('latest', '0');
  }
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
  return [payload?.turnId, payload?.clientTurnId, payload?.appTurnId, payload?.sessionId, payload?.previousSessionId].filter(Boolean);
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

export function isSessionIndexRuntime(runtime) {
  return runtime?.fromSessionIndex === true;
}

export function isLiveThreadRuntime(runtime) {
  return Boolean(runtime && !isSessionIndexRuntime(runtime));
}

function allProjectSessions(sessionsByProject = {}) {
  return Object.values(sessionsByProject || {}).flatMap((sessions) =>
    Array.isArray(sessions) ? sessions : []
  );
}

function runtimeFromSession(session) {
  void session;
  return null;
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
  void selectedSession;
  void hasRunningActivity;
  return runningById || {};
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

function messageHasVisibleContent(message = {}) {
  return typeof message.content === 'string' && message.content.trim();
}

function messageIsActiveTurnActivity(message = {}) {
  const kind = String(message?.kind || 'turn');
  return (
    message?.role === 'activity' &&
    kind === 'turn' &&
    ['running', 'queued'].includes(String(message.status || ''))
  );
}

export function selectedMessagesHaveActiveTurnActivity(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some((message, index) => {
    if (!messageIsActiveTurnActivity(message)) {
      return false;
    }
    const hasSameTurnAssistant = list.some((candidate) =>
      candidate?.role === 'assistant' &&
      messageHasVisibleContent(candidate) &&
      message.turnId &&
      candidate.turnId === message.turnId
    );
    if (hasSameTurnAssistant) {
      return false;
    }
    return !list.some((candidate, candidateIndex) =>
      candidateIndex > index &&
      candidate?.role === 'assistant' &&
      messageHasVisibleContent(candidate)
    );
  });
}

export function selectedSessionIsRunning({ running = false, hasActiveTurnActivity = false } = {}) {
  return Boolean(running || hasActiveTurnActivity);
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
