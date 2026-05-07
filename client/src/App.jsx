import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Headphones,
  Image,
  Loader2,
  Menu,
  Mic,
  Minus,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  UploadCloud,
  Volume2,
  Wifi,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { apiBlobFetch, apiFetch, clearToken, getToken, realtimeVoiceWebsocketUrl, setToken, websocketUrl } from './api.js';
import { isThinkingActivityStep, thinkingActivityText } from './activity-display.js';
import { removeDuplicateFinalAnswerActivity } from './activity-dedupe.js';
import { mergeActivityStep } from './activity-merge.js';
import { isPlaceholderTimelineItem } from './activity-timeline.js';
import { isNearChatBottom, shouldFollowChatOutput } from './chat-scroll.js';
import { composerSendState, desktopBridgeCanCreateThread } from './send-state.js';
import {
  detectComposerToken,
  filteredSlashCommands,
  replaceComposerToken
} from './composer-shortcuts.js';
import { connectionRecoveryState } from './connection-recovery.js';
import {
  browserNotificationPermission,
  isStandalonePwa,
  notificationFromPayload,
  notificationPreferenceEnabled,
  setNotificationPreferenceEnabled,
  shouldUseWebNotification
} from './notification-events.js';
import {
  browserPushSupported,
  notificationEnablementMessage,
  registerWebPush
} from './web-push-client.js';
import {
  applySessionRenameToProjectSessions,
  desktopThreadHasAssistantAfterLocalSend,
  desktopThreadHasAssistantAfterPendingSend,
  mergeLiveSelectedThreadMessages,
  shouldPollSelectedSessionMessages
} from './session-live-refresh.js';
import { provisionalSessionTitle, sessionTitleFromConversation } from '../../shared/session-title.js';

const DEFAULT_STATUS = {
  connected: false,
  desktopBridge: {
    strict: true,
    connected: false,
    mode: 'unavailable',
    reason: null
  },
  provider: 'cliproxyapi',
  model: 'gpt-5.5',
  modelShort: '5.5 中',
  reasoningEffort: 'xhigh',
  models: [{ value: 'gpt-5.5', label: 'gpt-5.5' }],
  skills: [],
  docs: {
    provider: 'feishu',
    integration: 'lark-cli',
    label: '飞书文档',
    configured: false,
    connected: false,
    user: null,
    homeUrl: 'https://docs.feishu.cn/',
    cliInstalled: false,
    skillsInstalled: false,
    capabilities: [],
    codexEnabled: false,
    authorizationReady: false,
    missingScopes: [],
    scopeGroups: [],
    slidesAuthorized: false,
    sheetsAuthorized: false,
    authPending: null
  },
  context: {
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
  },
  voiceRealtime: { configured: false, model: 'qwen3.5-omni-plus-realtime', provider: '阿里百炼' },
  auth: { authenticated: false }
};

const CONNECTION_STATUS = {
  connected: { label: '已连接', className: 'is-connected' },
  connecting: { label: '连接中', className: 'is-connecting' },
  disconnected: { label: '已断开', className: 'is-disconnected' }
};

const DEFAULT_REASONING_EFFORT = 'xhigh';
const REASONING_DEFAULT_VERSION = 'xhigh-v1';
const THEME_KEY = 'codexmobile.theme';
const SELECTED_SKILLS_KEY = 'codexmobile.selectedSkills';
const VOICE_MAX_RECORDING_MS = 90 * 1000;
const VOICE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const VOICE_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const VOICE_DIALOG_SILENCE_MS = 900;
const VOICE_DIALOG_MIN_RECORDING_MS = 600;
const VOICE_DIALOG_LEVEL_THRESHOLD = 0.018;
const VOICE_DIALOG_SILENCE_AUDIO =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
const REALTIME_VOICE_SAMPLE_RATE = 24000;
const REALTIME_VOICE_BUFFER_SIZE = 2048;
const REALTIME_VOICE_MIN_TURN_MS = 500;
const REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD = 0.026;
const REALTIME_VOICE_BARGE_IN_SUSTAIN_MS = 180;

function realtimePayloadErrorMessage(payload) {
  return String(payload?.error?.message || payload?.error || payload?.message || '');
}

function isBenignRealtimeCancelError(payload) {
  return /Conversation has none active response/i.test(realtimePayloadErrorMessage(payload));
}

function normalizeVoiceCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】\[\]<>《》]/g, '');
}

function isVoiceHandoffCommand(value) {
  const text = normalizeVoiceCommandText(value);
  if (!text) {
    return false;
  }
  const wantsSummary = /总结|整理|归纳|汇总|梳理|提炼|概括|组织|形成任务|变成任务|整理成任务/.test(text);
  const wantsHandoff = /交给|发给|发送给|提交给|提交|让|叫|拿给|丢给|转给|传给|给/.test(text);
  const wantsAction = /执行|处理|做|改|实现|修|查|跑|操作|落实|开始干/.test(text);
  const mentionsExecutor =
    /codex|code[x叉]?|代码|扣德克斯|扣得克斯|扣的克斯|扣得|扣德|科德克斯|科得克斯|寇德克斯|口德克斯|口得克斯|助手|后台|你/.test(text);
  if (mentionsExecutor && ((wantsSummary && wantsHandoff) || (wantsSummary && wantsAction) || (wantsHandoff && wantsAction))) {
    return true;
  }
  if (wantsSummary && wantsHandoff) {
    return true;
  }
  if (/交给codex|发给codex|提交给codex|让codex|交给代码|发给代码|提交给代码|让代码/.test(text)) {
    return true;
  }
  return false;
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back below for browsers that block Clipboard API in PWA/http contexts.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

const PERMISSION_OPTIONS = [
  { value: 'default', label: '默认权限' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'bypassPermissions', label: '完全访问', danger: true }
];
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

const REASONING_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }
];

function formatTime(value) {
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

function subAgentRoleLabel(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'worker') {
    return '执行';
  }
  if (value === 'explorer') {
    return '探索';
  }
  return value || '子代理';
}

function subAgentSubtitle(session) {
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

function formatDuration(start, end = Date.now()) {
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

function formatDurationMs(value) {
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

function compactPath(value) {
  if (!value) {
    return '';
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : normalized;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatTokenCount(value) {
  const tokens = numberOrNull(value);
  if (!tokens) {
    return '--';
  }
  if (tokens >= 1000000) {
    return `${Math.round(tokens / 100000) / 10}m`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(Math.round(tokens));
}

function normalizeContextStatus(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const inputTokens = numberOrNull(source.inputTokens ?? source.input_tokens ?? base.inputTokens);
  const totalTokens = numberOrNull(source.totalTokens ?? source.total_tokens ?? base.totalTokens);
  const contextWindow = numberOrNull(
    source.contextWindow ??
    source.modelContextWindow ??
    source.model_context_window ??
    base.contextWindow ??
    base.modelContextWindow
  );
  const percent =
    numberOrNull(source.percent ?? base.percent) ||
    (inputTokens && contextWindow ? Math.max(0, Math.min(100, Math.round((inputTokens / contextWindow) * 1000) / 10)) : null);
  const sourceCompact = source.autoCompact && typeof source.autoCompact === 'object' ? source.autoCompact : {};
  const baseCompact = base.autoCompact && typeof base.autoCompact === 'object' ? base.autoCompact : {};
  const tokenLimit = numberOrNull(
    sourceCompact.tokenLimit ??
    sourceCompact.token_limit ??
    source.autoCompactTokenLimit ??
    source.modelAutoCompactTokenLimit ??
    baseCompact.tokenLimit ??
    base.autoCompactTokenLimit
  );
  const detected = Boolean(sourceCompact.detected ?? baseCompact.detected);
  const compactEnabled = Boolean(sourceCompact.enabled ?? source.autoCompactEnabled ?? baseCompact.enabled ?? base.autoCompactEnabled ?? tokenLimit);
  return {
    ...base,
    ...source,
    inputTokens,
    totalTokens,
    contextWindow,
    percent,
    updatedAt: source.updatedAt || base.updatedAt || null,
    autoCompact: {
      ...baseCompact,
      ...sourceCompact,
      enabled: compactEnabled,
      tokenLimit,
      detected,
      status: sourceCompact.status || baseCompact.status || (detected ? 'detected' : compactEnabled ? 'watching' : 'unknown'),
      lastCompactedAt: sourceCompact.lastCompactedAt || baseCompact.lastCompactedAt || null,
      reason: sourceCompact.reason || baseCompact.reason || ''
    }
  };
}

function mergeContextStatus(current, incoming, configContext = {}) {
  const config = normalizeContextStatus(configContext);
  const base = normalizeContextStatus(current || config, config);
  const next = normalizeContextStatus(incoming || {}, base);
  return {
    ...base,
    ...next,
    inputTokens: next.inputTokens || base.inputTokens || null,
    totalTokens: next.totalTokens || base.totalTokens || null,
    contextWindow: next.contextWindow || base.contextWindow || config.contextWindow || null,
    percent: next.percent || base.percent || null,
    autoCompact: {
      ...base.autoCompact,
      ...next.autoCompact,
      tokenLimit: next.autoCompact?.tokenLimit || base.autoCompact?.tokenLimit || null,
      detected: Boolean(next.autoCompact?.detected || base.autoCompact?.detected)
    }
  };
}

function emptyContextStatus() {
  return normalizeContextStatus(DEFAULT_STATUS.context, DEFAULT_STATUS.context);
}

function shortModelName(model) {
  if (!model) {
    return '5.5';
  }
  return model
    .replace(/^gpt-/i, '')
    .replace(/-codex.*$/i, '')
    .replace(/-mini$/i, ' mini');
}

function permissionLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.label || '默认权限';
}

function reasoningLabel(value) {
  return REASONING_OPTIONS.find((option) => option.value === value)?.label || '超高';
}

function safeStoredJsonArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function selectedSkillSummary(selectedSkills) {
  if (!selectedSkills?.length) {
    return '技能';
  }
  if (selectedSkills.length === 1) {
    return selectedSkills[0]?.label || selectedSkills[0]?.name || '技能';
  }
  return `技能 ${selectedSkills.length}`;
}

function imageUrlWithRetry(url, retryKey) {
  if (!retryKey || /^data:image\//i.test(String(url || '').trim())) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}r=${retryKey}`;
}

const resolvedImageSourceCache = new Map();

function isLocalImageSource(value) {
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

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localImageApiPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  return `/api/local-image?path=${encodeURIComponent(normalized)}`;
}

function dataImageObjectUrl(value) {
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

function cachedResolvedImageSource(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return null;
  }
  return resolvedImageSourceCache.get(raw) || null;
}

function useResolvedImageSource(url, retryKey) {
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

function createClientTurnId() {
  return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createDraftSession(project) {
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

function isDraftSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  return Boolean(session?.draft || id?.startsWith('draft-'));
}

function sessionMessagesApiPath(sessionId, { limit = 120, activity = true } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (activity) {
    params.set('activity', '1');
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
}

function titleFromFirstMessage(message) {
  return provisionalSessionTitle(message);
}

function autoTitlePatch(title, phase = 'provisional') {
  return title ? { title, titleLocked: false, titleAutoGenerated: phase } : {};
}

function payloadRunKeys(payload) {
  return [payload?.turnId, payload?.sessionId, payload?.previousSessionId].filter(Boolean);
}

function selectedRunKeys(session) {
  return [session?.id, session?.turnId].filter(Boolean);
}

function hasRunningKey(runningById, keys) {
  return keys.some((key) => Boolean(runningById[key]));
}

function sessionRunKeys(session) {
  return [session?.id, session?.turnId, session?.previousSessionId].filter(Boolean);
}

function buildComposerRunStatus(messages, running, now = Date.now()) {
  const activity = [...(messages || [])]
    .reverse()
    .find((message) => message.role === 'activity' && (message.status === 'running' || message.status === 'queued'));
  if (!running && !activity) {
    return null;
  }

  const steps = Array.isArray(activity?.activities) ? activity.activities : [];
  const visibleSteps = steps.filter((step) => isVisibleActivityStep(step, activity?.status || 'running'));
  const activeStep = [...visibleSteps].reverse().find((step) => step.status === 'running' || step.status === 'queued') || null;
  const latestStep = activeStep || visibleSteps[visibleSteps.length - 1] || null;
  const startedAt = activity?.startedAt || activity?.timestamp || now;
  const duration = formatDuration(startedAt, now);
  let label = '正在思考';

  if (latestStep) {
    if (latestStep.kind === 'agent_message' || latestStep.kind === 'message') {
      label = '正在同步回复';
    } else if (activeStep) {
      label = describeActivityStep(latestStep).label || latestStep.label || label;
    } else if (activity?.status === 'running' || activity?.status === 'queued') {
      label = '正在思考';
    } else {
      const descriptor = describeActivityStep(latestStep);
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
  } else if (activity?.label && !isGenericActivityLabel(activity.label)) {
    label = activity.label;
  }

  return {
    label: compactActivityText(label) || '正在处理',
    duration,
    running: true
  };
}

function hasVisibleAssistantForTurn(messages, payload) {
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

function spokenReplyText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/```[\s\S]*?```/g, ' 代码块 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

function voiceDialogStatusLabel(state) {
  const labels = {
    idle: '准备对话',
    listening: '正在听',
    transcribing: '正在转写',
    sending: '正在发送',
    waiting: '等待回复',
    speaking: '正在朗读',
    summarizing: '正在整理任务',
    handoff: '确认交给 Codex',
    error: '对话出错'
  };
  return labels[state] || labels.idle;
}

function downsampleAudio(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[index] = input[before] * (1 - weight) + input[after] * weight;
  }
  return output;
}

function floatToPcm16Base64(input) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function pcm16Base64ToFloat(base64) {
  const binary = atob(base64);
  const length = Math.floor(binary.length / 2);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const lo = binary.charCodeAt(index * 2);
    const hi = binary.charCodeAt(index * 2 + 1);
    const value = (hi << 8) | lo;
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    output[index] = Math.max(-1, Math.min(1, signed / 0x8000));
  }
  return output;
}

function audioLevel(samples) {
  if (!samples?.length) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += samples[index] * samples[index];
  }
  return Math.sqrt(total / samples.length);
}

function upsertSessionInProject(current, projectId, session, replaceId = null) {
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

function statusMessageId(payload) {
  return `status-${payload.turnId || payload.sessionId || 'current'}`;
}

function larkCliActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!lower.includes('lark-cli')) {
    return '';
  }

  if (/\bauth\b/.test(lower)) {
    return '确认飞书授权';
  }

  if (/\bsheets?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建表格';
    }
    if (/\+append|\bappend\b/.test(lower)) {
      return '追加表格数据';
    }
    if (/\+write|\bwrite\b/.test(lower)) {
      return '写入表格数据';
    }
    if (/\+find|\bfind\b/.test(lower)) {
      return '查找表格内容';
    }
    if (/\+replace|\breplace\b/.test(lower)) {
      return '替换表格内容';
    }
    if (/\+export|\bexport\b/.test(lower)) {
      return '导出表格';
    }
    if (/title|rename|\bpatch\b|\bupdate\b|spreadsheet\.meta/.test(lower)) {
      return '修改表名';
    }
    if (/\+read|\bread\b|\bget\b|\bmeta\b/.test(lower)) {
      return '读取表格信息';
    }
    return '操作表格';
  }

  if (/\bslides?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建 PPT';
    }
    if (/\+update|\bupdate\b|\breplace\b|\bpatch\b/.test(lower)) {
      return '修改 PPT';
    }
    if (/\+read|\bread\b|\bget\b|\bxml_presentations\b/.test(lower)) {
      return '读取 PPT';
    }
    return '操作 PPT';
  }

  if (/\bdocs?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建文档';
    }
    if (/\+update|\bupdate\b|\bappend\b|\breplace\b|\bpatch\b/.test(lower)) {
      return '修改文档';
    }
    if (/\+search|\bsearch\b/.test(lower)) {
      return '搜索文档';
    }
    if (/\+fetch|\bread\b|\bget\b|\bfetch\b/.test(lower)) {
      return '读取文档';
    }
    return '操作文档';
  }

  if (/\bdrive\b/.test(lower)) {
    if (/\+import|\bimport\b/.test(lower)) {
      return '导入文件';
    }
    if (/\+upload|\bupload\b/.test(lower)) {
      return '上传文件';
    }
    if (/\+download|\bdownload\b/.test(lower)) {
      return '下载文件';
    }
    if (/\+delete|\bdelete\b|\btrash\b/.test(lower)) {
      return '删除文件';
    }
    if (/\+move|\bmove\b/.test(lower)) {
      return '移动文件';
    }
    if (/title|rename|\bpatch\b|\bupdate\b/.test(lower)) {
      return '修改文件名';
    }
    if (/\+search|\bsearch\b/.test(lower)) {
      return '搜索云空间';
    }
    return '操作云空间';
  }

  return '';
}

function shellCommandActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!text) {
    return '';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bvite\s+build\b|\bwebpack\b|\brollup\b/.test(lower)) {
    return '构建前端';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?smoke\b|\bsmoke\.mjs\b/.test(lower)) {
    return '运行冒烟检查';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bmvn\b.*\btest\b|\bcargo\s+test\b/.test(lower)) {
    return '运行测试';
  }
  if (/\bnode\s+--check\b|\btsc\b|\beslint\b|\bbiome\b|\bprettier\b|\bflake8\b|\bmypy\b/.test(lower)) {
    return '检查代码';
  }
  if (/\bgit\s+(status|diff|show|log|ls-files)\b/.test(lower)) {
    return '检查改动';
  }
  if (/\b(get-content|select-string|rg|findstr|grep)\b/.test(lower)) {
    return /\b(select-string|rg|findstr|grep)\b/.test(lower) ? '搜索代码' : '读取文件';
  }
  if (/\b(get-childitem|ls|dir)\b/.test(lower)) {
    return '查看文件';
  }
  if (/\b(start-process|node\s+server\/index\.js|node\s+server\\index\.js)\b/.test(lower)) {
    return '启动服务';
  }
  return '';
}

function meaningfulActivityLabel(payload, rawLabel, detail) {
  const source = [payload.command, detail, rawLabel, payload.output]
    .filter(Boolean)
    .join(' ');
  const larkLabel = larkCliActivityLabel(source);
  if (larkLabel) {
    return larkLabel;
  }
  const commandLabel = shellCommandActivityLabel(payload.command || detail);
  if (commandLabel) {
    return commandLabel;
  }

  if (payload.kind === 'agent_message' || payload.kind === 'message') {
    const text = rawLabel || payload.content || detail;
    return isGenericActivityLabel(text) ? '' : text;
  }

  if (payload.kind === 'reasoning') {
    return briefActivityLabel(rawLabel || payload.content || detail);
  }

  if (isGenericActivityLabel(rawLabel)) {
    return '';
  }

  return rawLabel && rawLabel.length <= 18 ? rawLabel : '';
}

function isGenericActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return true;
  }
  return /^(正在思考中?|思考完成|正在处理|正在回复|正在整理回复|正在准备任务|正在修改并验证|正在执行命令|命令已完成|命令完成|命令执行完成|执行完成|正在处理本地任务|本地任务已处理|本地任务失败|文件已更新|文件更新失败|正在更新文件|工具调用完成|正在调用工具|工具调用失败|正在完成一步操作|已完成一步操作|这一步操作失败|工具已完成|网页信息已查到|正在查找网页信息|计划已更新|正在规划|任务已完成|已完成|完成|失败)$/i.test(text);
}

function activityStepFromPayload(payload, fallbackKind = 'status') {
  const preservesText = payload.kind === 'agent_message' || payload.kind === 'message';
  const rawLabel = preservesText
    ? String(payload.label || payload.content || '').trim()
    : String(payload.label || payload.content || '').replace(/\s+/g, ' ').trim();
  const detail = String(payload.detail || payload.error || '').trim();
  const label = meaningfulActivityLabel(payload, rawLabel, detail);
  if (!label) {
    return null;
  }
  return {
    id: payload.messageId || `${statusMessageId(payload)}-${payload.kind || fallbackKind}-${label || payload.status || 'step'}`,
    kind: payload.kind || fallbackKind,
    label,
    status: payload.status || 'running',
    detail,
    command: payload.command || '',
    output: payload.output || '',
    error: payload.error || '',
    fileChanges: payload.fileChanges || [],
    toolName: payload.toolName || payload.name || '',
    timestamp: payload.timestamp || new Date().toISOString()
  };
}

function compactActivityText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text;
}

function conciseActivityDetail(value, maxLength = 140) {
  const text = compactActivityText(value);
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function briefActivityLabel(value, fallback = '正在处理') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (/授权|登录|连接/.test(text)) {
    return '确认授权';
  }
  if (/记忆|skill|技能|能力|scope|权限/i.test(text)) {
    return '';
  }
  if (/搜索|查找|定位/.test(text)) {
    return '查找文件';
  }
  if (/创建|新建|生成/.test(text)) {
    return '创建文件';
  }
  if (/改名|重命名|修改标题|rename/i.test(text) && /验证|确认|检查|读取/.test(text)) {
    return '修改并验证';
  }
  if (/改名|重命名|修改标题|rename/i.test(text)) {
    return '修改标题';
  }
  if (/读取|获取|标题|内容/.test(text)) {
    return '读取内容';
  }
  if (/修改|更新|写入|追加|替换|编辑/.test(text)) {
    return '修改内容';
  }
  if (/上传|导入/.test(text)) {
    return '上传文件';
  }
  if (/下载|导出/.test(text)) {
    return '导出文件';
  }
  if (/删除|移除/.test(text)) {
    return '删除文件';
  }
  if (/验证|确认|检查/.test(text)) {
    return '验证结果';
  }
  if (/命令|lark-cli|PowerShell|shell|执行/i.test(text)) {
    return '';
  }
  return text.length > 18 ? '' : text;
}

function isVisibleActivityStep(step, messageStatus) {
  if (!step) {
    return false;
  }
  if (isThinkingActivityStep(step)) {
    return true;
  }
  const label = String(step.label || '').trim();
  const hasWorkDetail =
    Boolean(step.command || step.detail || step.output || step.error || step.toolName) ||
    (Array.isArray(step.fileChanges) && step.fileChanges.length > 0);
  const workKinds = new Set([
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'dynamic_tool_call',
    'web_search',
    'image_generation_call',
    'plan',
    'context_compaction',
    'subagent_activity'
  ]);
  if (isGenericActivityLabel(label) && !hasWorkDetail && !workKinds.has(step.kind)) {
    return false;
  }
  if (
    ['reasoning', 'message', 'agent_message'].includes(step.kind) &&
    /^(正在思考中?|正在处理|正在回复|正在整理回复)$/.test(label)
  ) {
    return false;
  }
  if (step.kind === 'function_call_output' && messageStatus !== 'failed' && step.status !== 'failed') {
    return false;
  }
  if (messageStatus !== 'failed' && /blocked by policy|rejected/i.test(`${step.detail || ''}\n${step.output || ''}\n${step.error || ''}`)) {
    return false;
  }
  return true;
}

function completeActivityMessagesForTurn(current, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size) {
    return current;
  }
  const finalText = normalizeActivityDuplicateText(payload.content || payload.label || '');
  const completedAt = payload.completedAt || payload.timestamp || new Date().toISOString();
  return current.map((message) => {
    if (message.role !== 'activity' || !payloadRunKeys(message).some((key) => keys.has(key))) {
      return message;
    }
    const activities =
      finalText && Array.isArray(message.activities)
        ? message.activities.filter((activity) => {
          if (!['agent_message', 'message'].includes(activity?.kind)) {
            return true;
          }
          return normalizeActivityDuplicateText(activity.label || activity.content || activity.detail) !== finalText;
        })
        : message.activities;
    return {
      ...message,
      status: message.status === 'failed' ? 'failed' : 'completed',
      label: message.status === 'failed' ? message.label : '过程已同步',
      content: message.status === 'failed' ? message.content : '过程已同步',
      startedAt: message.startedAt || payload.startedAt || message.timestamp || null,
      completedAt: message.completedAt || completedAt,
      durationMs: message.durationMs || payload.durationMs || null,
      activities
    };
  });
}

function normalizeActivityDuplicateText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function messageMatchesRun(message, keys) {
  if (!keys?.size) {
    return false;
  }
  return payloadRunKeys(message).some((key) => keys.has(key));
}

function mergeLoadedMessagesPreservingActivity(current, loaded, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size || !Array.isArray(loaded)) {
    return loaded || [];
  }
  if (loaded.some((message) => message.role === 'activity' && message.durationMs)) {
    return loaded;
  }
  const activityMessages = completeActivityMessagesForTurn(
    current.filter((message) => message.role === 'activity' && messageMatchesRun(message, keys)),
    payload
  );
  if (!activityMessages.length) {
    return loaded;
  }

  const result = [];
  let inserted = false;
  for (const message of loaded) {
    if (!inserted && message.role === 'assistant' && messageMatchesRun(message, keys)) {
      result.push(...removeDuplicateFinalAnswerActivity(activityMessages, { ...payload, content: message.content }));
      inserted = true;
    }
    result.push(message);
  }
  if (!inserted) {
    result.push(...activityMessages);
  }
  return result;
}

function messageStreamSignature(messages) {
  return (messages || [])
    .map((message) => {
      const activities = Array.isArray(message.activities) ? message.activities : [];
      const activitySignature = activities
        .map((activity) => `${activity.id}:${activity.status}:${activity.label}:${activity.detail || activity.command || ''}`)
        .map((signature, index) => {
          const activity = activities[index] || {};
          const fileChanges = Array.isArray(activity.fileChanges) ? activity.fileChanges : [];
          const fileSignature = fileChanges
            .map((change) => `${change.path || ''}:${change.kind || ''}:${change.additions || 0}:${change.deletions || 0}:${String(change.unifiedDiff || '').length}`)
            .join(',');
          const output = String(activity.output || activity.error || '');
          return `${signature}:${output.length}:${output.slice(-160)}:${fileSignature}`;
        })
        .join('|');
      return `${message.id}:${message.role}:${message.status || ''}:${message.content || ''}:${activitySignature}`;
    })
    .join('\n');
}

function upsertStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const normalizedPayload =
    payload.kind === 'agent_message'
      ? { ...payload, label: String(payload.label || payload.content || '').trim() }
      : payload;
  const detail =
    normalizedPayload.kind === 'reasoning'
      ? previous?.detail || ''
      : normalizedPayload.detail || previous?.detail || '';
  const isTurnLevel = normalizedPayload.kind === 'turn' || normalizedPayload.kind === 'error';
  const terminalTimestamp =
    normalizedPayload.completedAt ||
    (['completed', 'failed'].includes(normalizedPayload.status) ? normalizedPayload.timestamp : '') ||
    '';
  const nextMessage = {
    id,
    role: 'activity',
    turnId: normalizedPayload.turnId || previous?.turnId || null,
    sessionId: normalizedPayload.sessionId || previous?.sessionId || null,
    content: isTurnLevel ? (normalizedPayload.label || previous?.content || '正在处理') : (previous?.content || '正在处理'),
    label: isTurnLevel ? (normalizedPayload.label || previous?.label || '正在处理') : (previous?.label || '正在处理'),
    detail,
    kind: normalizedPayload.kind || previous?.kind || 'turn',
    status: isTurnLevel ? (normalizedPayload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: normalizedPayload.timestamp || previous?.timestamp || new Date().toISOString(),
    startedAt: previous?.startedAt || normalizedPayload.startedAt || normalizedPayload.timestamp || new Date().toISOString(),
    completedAt: previous?.completedAt || terminalTimestamp || null,
    durationMs: previous?.durationMs || normalizedPayload.durationMs || null,
    activities: mergeActivityStep(previous?.activities || [], activityStepFromPayload(normalizedPayload))
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

function upsertActivityMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const isTurnLevel = payload.kind === 'turn' || payload.kind === 'error';
  const activity = activityStepFromPayload(payload, 'activity');
  if (!activity && !previous) {
    return current;
  }
  const activities = activity
    ? mergeActivityStep(previous?.activities || [], activity)
    : previous?.activities || [];

  const nextMessage = {
    id,
    role: 'activity',
    turnId: payload.turnId || previous?.turnId || null,
    sessionId: payload.sessionId || previous?.sessionId || null,
    content: previous?.content || '正在处理',
    label: previous?.label || '正在处理',
    detail: payload.detail || previous?.detail || activity?.detail || '',
    kind: payload.kind || previous?.kind || 'activity',
    status: isTurnLevel ? (payload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: previous?.timestamp || payload.timestamp || new Date().toISOString(),
    startedAt: previous?.startedAt || payload.startedAt || previous?.timestamp || payload.timestamp || new Date().toISOString(),
    completedAt:
      previous?.completedAt ||
      payload.completedAt ||
      (isTurnLevel && ['completed', 'failed'].includes(payload.status) ? payload.timestamp || new Date().toISOString() : null),
    durationMs: previous?.durationMs || payload.durationMs || null,
    activities
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

function completeStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  return current.filter((message) => message.id !== id);
}

function hasAssistantMessageForTurn(messages, payload) {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

function removeActivityMessagesForTurn(messages, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size) {
    return messages;
  }
  return messages.filter((message) => {
    if (message.role !== 'activity') {
      return true;
    }
    return !payloadRunKeys(message).some((key) => keys.has(key));
  });
}

function upsertAssistantMessage(current, payload) {
  const content = String(payload.content || '').trim();
  if (!content) {
    return current;
  }
  const id = payload.messageId || `assistant-${payload.turnId || Date.now()}`;
  const nextMessage = {
    id,
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
    turnId: payload.turnId || null,
    sessionId: payload.sessionId || null,
    kind: payload.kind
  };
  const dedupedActivity = removeDuplicateFinalAnswerActivity(current, payload);
  const withCompletedActivity = payload.done === false ? dedupedActivity : completeActivityMessagesForTurn(dedupedActivity, payload);
  const existingIndex = withCompletedActivity.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const next = [...withCompletedActivity];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...withCompletedActivity, nextMessage];
}

function PairingScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);

  async function handlePair(event) {
    event.preventDefault();
    setPairing(true);
    setError('');
    try {
      const result = await apiFetch('/api/pair', {
        method: 'POST',
        body: {
          code,
          deviceName: navigator.platform || 'iPhone'
        }
      });
      setToken(result.token);
      onPaired();
    } catch (err) {
      setError(err.message);
    } finally {
      setPairing(false);
    }
  }

  return (
    <main className="pairing-screen">
      <div className="pairing-mark">
        <Monitor size={30} />
      </div>
      <h1>CodexMobile</h1>
      <p className="pairing-lead">
        我的本机 Codex 移动工作台。电脑继续执行，iPhone 随时接管、追问、看过程、处理确认和收完成通知。
      </p>
      <div className="pairing-points" aria-label="CodexMobile 核心能力">
        <span>桌面线程同步</span>
        <span>完整执行过程</span>
        <span>私有网络访问</span>
      </div>
      <p className="pairing-note">输入电脑端启动日志里的 6 位配对码。</p>
      <form className="pairing-form" onSubmit={handlePair}>
        <input
          inputMode="numeric"
          maxLength={6}
          placeholder="6 位配对码"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button type="submit" disabled={code.length !== 6 || pairing}>
          {pairing ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
          连接
        </button>
      </form>
      {error ? <div className="pairing-error">{error}</div> : null}
    </main>
  );
}

function quotaPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

function quotaRemainingPercent(quotaWindow) {
  if (!quotaWindow || typeof quotaWindow !== 'object') {
    return null;
  }
  const display = quotaPercent(quotaWindow.displayPercent ?? quotaWindow.display_percent);
  if (display !== null) {
    return display;
  }
  const explicit = quotaPercent(quotaWindow.remainingPercent ?? quotaWindow.remaining_percent);
  if (explicit !== null) {
    return explicit;
  }
  const used = quotaPercent(quotaWindow.usedPercent ?? quotaWindow.used_percent);
  return used === null ? null : Math.max(0, Math.min(100, 100 - used));
}

function formatQuotaPercent(quotaWindow) {
  const percent = quotaRemainingPercent(quotaWindow);
  return percent === null ? '--' : `${Math.round(percent)}%`;
}

function quotaToneClass(percent) {
  if (percent === null) {
    return 'is-low';
  }
  if (percent >= 80) {
    return 'is-healthy';
  }
  if (percent >= 60) {
    return 'is-medium';
  }
  if (percent >= 40) {
    return 'is-warning';
  }
  return 'is-low';
}

function Drawer({
  open,
  onClose,
  projects,
  selectedProject,
  selectedSession,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  runningById,
  threadRuntimeById,
  completedSessionIds,
  onToggleProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onNewConversation,
  onSync,
  syncing,
  theme,
  setTheme,
  canCreateThread = true,
  createThreadUnavailableReason = ''
}) {
  const [drawerView, setDrawerView] = useState('main');
  const [subagentExpandedById, setSubagentExpandedById] = useState({});
  const [quotaExpanded, setQuotaExpanded] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaNotice, setQuotaNotice] = useState('');
  const [quotaAccounts, setQuotaAccounts] = useState([]);
  const [drawerQuery, setDrawerQuery] = useState('');
  const normalizedDrawerQuery = drawerQuery.trim().toLowerCase();
  const runningCount = Object.values(runningById || {}).filter(Boolean).length;

  async function refreshCodexQuota(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (quotaLoading) {
      return;
    }
    setQuotaExpanded(true);
    setQuotaLoading(true);
    setQuotaError('');
    setQuotaNotice('');
    try {
      const result = await apiFetch('/api/quotas/codex');
      setQuotaAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setQuotaNotice(result.stale ? (result.staleReason || '实时查询失败，显示最近一次成功结果') : '');
      setQuotaLoaded(true);
    } catch (error) {
      setQuotaError(`${error.message || '查询失败'}，点击刷新重试`);
      setQuotaLoaded(true);
    } finally {
      setQuotaLoading(false);
    }
  }

  if (drawerView === 'settings') {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
        <aside className={`drawer ${open ? 'is-open' : ''}`}>
          <div className="drawer-subheader">
            <button className="icon-button" onClick={() => setDrawerView('main')} aria-label="返回">
              <ChevronLeft size={22} />
            </button>
            <strong>设置</strong>
            <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
              <X size={20} />
            </button>
          </div>
          <div className="settings-view">
            <section className="settings-group">
              <div className="drawer-heading">外观</div>
              <div className="theme-setting">
                <div className="theme-setting-title">
                  <span>主题选择</span>
                </div>
                <div className="theme-segment" role="group" aria-label="主题选择">
                  <button
                    type="button"
                    className={theme === 'light' ? 'is-selected' : ''}
                    onClick={() => setTheme('light')}
                  >
                    白色
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'is-selected' : ''}
                    onClick={() => setTheme('dark')}
                  >
                    黑色
                  </button>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`}>
        <div className="drawer-header">
          <div>
            <strong>CodexMobile</strong>
            <small>{runningCount ? `已连接 · ${runningCount} 个任务运行中` : '已连接'}</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
            <X size={20} />
          </button>
        </div>

        <div className="drawer-command">
          <label className="drawer-search">
            <Search size={17} />
            <input
              type="search"
              value={drawerQuery}
              onChange={(event) => setDrawerQuery(event.target.value)}
              placeholder="搜索对话..."
              aria-label="搜索对话"
            />
          </label>
          <button
            className="drawer-new-button"
            onClick={onNewConversation}
            disabled={!canCreateThread}
            title={!canCreateThread ? (createThreadUnavailableReason || '请先在桌面端新建对话') : '新对话'}
          >
            <Plus size={17} />
            新对话
          </button>
        </div>

        <section className="drawer-section project-section">
          <div className="drawer-heading">对话分类</div>
          <div className="project-list">
            {projects.map((project) => {
              const isSelected = selectedProject?.id === project.id;
              const isExpanded = Boolean(expandedProjectIds[project.id]);
              const projectSessions = sessionsByProject[project.id] || [];
              const projectMatches = normalizedDrawerQuery
                ? [project.name, project.pathLabel, project.path].some((value) => String(value || '').toLowerCase().includes(normalizedDrawerQuery))
                : true;
              const visibleProjectSessions = normalizedDrawerQuery
                ? projectSessions.filter((session) => String(session.title || '对话').toLowerCase().includes(normalizedDrawerQuery))
                : projectSessions;
              if (normalizedDrawerQuery && !projectMatches && !visibleProjectSessions.length) {
                return null;
              }
              const projectSessionIds = new Set(visibleProjectSessions.map((session) => session.id));
              const childSessionsByParent = visibleProjectSessions.reduce((acc, session) => {
                if (session.parentSessionId && projectSessionIds.has(session.parentSessionId)) {
                  if (!acc.has(session.parentSessionId)) {
                    acc.set(session.parentSessionId, []);
                  }
                  acc.get(session.parentSessionId).push(session);
                }
                return acc;
              }, new Map());
              const rootSessions = visibleProjectSessions.filter(
                (session) => !session.parentSessionId || !projectSessionIds.has(session.parentSessionId)
              );
              const sessionsOpen = isExpanded || Boolean(normalizedDrawerQuery);
              const renderThreadRow = (session, { isSubAgent = false } = {}) => {
                const runtime = threadRuntimeById?.[session.id] || null;
                const sessionRunning = runtime?.status === 'running' || hasRunningKey(runningById, sessionRunKeys(session));
                const sessionCompleted = runtime?.status === 'completed' || Boolean(completedSessionIds?.[session.id]);
                const childCount = Number(session.childCount) || 0;
                const openChildCount = Number(session.openChildCount) || 0;
                const subagentsOpen = Boolean(subagentExpandedById[session.id]);
                const rowSelected = selectedSession?.id === session.id;
                return (
                  <div
                    key={session.id}
                    className={`thread-row ${rowSelected ? 'is-selected has-actions' : 'is-compact'} ${session.draft ? 'is-draft' : ''} ${sessionRunning ? 'is-running' : ''} ${sessionCompleted ? 'has-complete-notice' : ''} ${isSubAgent || session.isSubAgent ? 'is-subagent' : ''}`}
                  >
                    <button
                      type="button"
                      className="thread-main"
                      onClick={() => onSelectSession(session)}
                    >
                      <span className="thread-title-line">
                        <span>{session.title || '对话'}</span>
                        {!isSubAgent && childCount ? (
                          <span
                            role="button"
                            tabIndex={0}
                            className="thread-subagent-toggle"
                            aria-label={subagentsOpen ? '折叠子代理线程' : '展开子代理线程'}
                            aria-expanded={subagentsOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSubagentExpandedById((current) => ({ ...current, [session.id]: !current[session.id] }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                setSubagentExpandedById((current) => ({ ...current, [session.id]: !current[session.id] }));
                              }
                            }}
                          >
                            {openChildCount ? `${openChildCount}/${childCount}` : childCount} 子代理
                            <ChevronDown size={12} />
                          </span>
                        ) : null}
                        {sessionRunning ? (
                          <Loader2 className="thread-status-spin spin" size={12} aria-label="运行中" />
                        ) : sessionCompleted ? (
                          <span className="thread-complete-dot" aria-label="有新完成结果" />
                        ) : null}
                      </span>
                      <small>
                        {sessionRunning
                          ? '正在处理'
                          : session.draft
                            ? '待发送'
                            : isSubAgent || session.isSubAgent
                              ? subAgentSubtitle(session)
                              : formatTime(session.updatedAt)}
                      </small>
                    </button>
                    {rowSelected ? (
                      <>
                        <button
                          type="button"
                          className="thread-rename"
                          onClick={() => onRenameSession(project, session)}
                          aria-label="重命名线程"
                          title="重命名线程"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="thread-delete"
                          onClick={() => onDeleteSession(project, session)}
                          aria-label="归档线程"
                          title="归档线程"
                        >
                          <Archive size={14} />
                        </button>
                      </>
                    ) : (
                      <ChevronDown size={14} className="thread-row-more" />
                    )}
                  </div>
                );
              };
              return (
                <div key={project.id} className="project-group">
                  <button
                    className={`project-row ${isSelected ? 'is-selected' : ''} ${sessionsOpen ? 'is-expanded' : ''}`}
                    onClick={() => onToggleProject(project)}
                  >
                    {project.projectless ? <MessageSquare size={18} /> : <Folder size={18} />}
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.pathLabel || compactPath(project.path)}</small>
                    </span>
                    <small className="project-count">{project.sessionCount || projectSessions.length || 0}</small>
                    <ChevronDown size={15} className="project-chevron" />
                  </button>
                  {sessionsOpen ? (
                    <div className="thread-list">
                      {loadingProjectId === project.id ? (
                        <div className="thread-empty">
                          <Loader2 className="spin" size={14} />
                          加载中
                        </div>
                      ) : visibleProjectSessions.length ? (
                        rootSessions.map((session) => {
                          const childSessions = childSessionsByParent.get(session.id) || [];
                          const childSessionsOpen = Boolean(subagentExpandedById[session.id]);
                          return (
                            <div key={session.id} className="thread-stack">
                              {renderThreadRow(session)}
                              {childSessions.length && childSessionsOpen ? (
                                <div className="thread-list is-subagents">
                                  {childSessions.map((childSession) => renderThreadRow(childSession, { isSubAgent: true }))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <div className="thread-empty">暂无线程</div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="drawer-section drawer-controls">
          <div className="control-row sync-row">
            <span>
              对话同步
            </span>
            <button className="sync-button" onClick={onSync} disabled={syncing}>
              {syncing ? <Loader2 className="spin" size={16} /> : null}
              同步
            </button>
            <span className="sync-spacer" aria-hidden="true" />
          </div>
          <div className={`quota-widget ${quotaExpanded ? 'is-expanded' : ''}`}>
            <div className="quota-row">
              <button
                type="button"
                className="quota-main"
                onClick={() => setQuotaExpanded((current) => !current)}
              >
                <span className="quota-title">额度查询</span>
                <span className="quota-kind">Codex</span>
              </button>
              <button
                type="button"
                className="quota-refresh"
                onClick={refreshCodexQuota}
                disabled={quotaLoading}
              >
                {quotaLoading ? '刷新中...' : '刷新'}
              </button>
              <button
                type="button"
                className="quota-toggle"
                onClick={() => setQuotaExpanded((current) => !current)}
                aria-label={quotaExpanded ? '收起额度查询' : '展开额度查询'}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            {quotaExpanded ? (
              <div className="quota-panel">
                {quotaError ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaError}
                  </button>
                ) : null}
                {!quotaError && quotaNotice ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaNotice}，点击刷新
                  </button>
                ) : null}
                {!quotaError && quotaAccounts.length ? (
                  quotaAccounts.map((account) => {
                    const windows = Array.isArray(account.windows) ? account.windows : [];
                    const accountStatus = account.status || 'ok';
                    const plan = account.plan || 'Codex';
                    return (
                      <div key={account.id} className={`quota-account is-${accountStatus}`}>
                        <div className="quota-account-head">
                          <span>{account.label || 'Codex'}</span>
                          <small>{plan}</small>
                        </div>
                        {accountStatus === 'ok' && windows.length ? (
                          <div className="quota-window-list">
                            {windows.map((quotaWindow) => {
                              const percent = quotaRemainingPercent(quotaWindow);
                              return (
                                <div
                                  key={quotaWindow.id}
                                  className={`quota-window ${quotaToneClass(percent)}`}
                                  style={{ '--quota-percent': `${percent ?? 0}%` }}
                                >
                                  <div className="quota-window-meta">
                                    <span>{quotaWindow.label}</span>
                                    <strong>{formatQuotaPercent(quotaWindow)}</strong>
                                  </div>
                                  <div className="quota-bar">
                                    <span />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="quota-account-message"
                            onClick={accountStatus === 'failed' ? refreshCodexQuota : undefined}
                          >
                            {accountStatus === 'disabled' ? '已停用' : `${account.error || '查询失败'}，点击刷新重试`}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : null}
                {!quotaLoading && !quotaError && quotaLoaded && !quotaAccounts.length ? (
                  <div className="quota-empty">暂无 Codex 凭证</div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="settings-entry" onClick={() => setDrawerView('settings')}>
            <span>
              <Settings size={18} />
              设置
            </span>
            <ChevronRight size={17} />
          </button>
        </section>
      </aside>
    </>
  );
}

function bridgeConnectionLabel(connectionState, desktopBridge) {
  if (connectionState !== 'connected') {
    return CONNECTION_STATUS[connectionState] || CONNECTION_STATUS.disconnected;
  }
  if (desktopBridge?.mode === 'headless-local') {
    return { label: '后台 Codex', className: 'is-connected is-headless' };
  }
  return CONNECTION_STATUS.connected;
}

function TopBar({
  selectedProject,
  selectedSession,
  connectionState,
  desktopBridge,
  onMenu,
  onOpenDocs,
  onGitAction,
  notificationSupported,
  notificationEnabled,
  onEnableNotifications,
  gitDisabled = false
}) {
  const status = bridgeConnectionLabel(connectionState, desktopBridge);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedThreadId, setCopiedThreadId] = useState(false);
  const menuRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const canCopyThreadId = Boolean(selectedSession?.id && !isDraftSession(selectedSession));

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    function closeMenu(event) {
      if (!menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [menuOpen]);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  function handleGitAction(action) {
    setMenuOpen(false);
    onGitAction?.(action);
  }

  async function handleCopyThreadId() {
    if (!canCopyThreadId) {
      return;
    }
    const copied = await copyTextToClipboard(selectedSession.id);
    if (!copied) {
      window.alert('复制失败');
      return;
    }
    setCopiedThreadId(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopiedThreadId(false), 1400);
  }

  function handleOpenDocs() {
    setMenuOpen(false);
    onOpenDocs?.();
  }

  function handleEnableNotifications() {
    setMenuOpen(false);
    onEnableNotifications?.();
  }

  return (
    <header className="top-bar">
      <button className="icon-button" onClick={onMenu} aria-label="打开菜单">
        <Menu size={22} />
      </button>
      <div className="top-title">
        <strong>{selectedProject?.name || 'CodexMobile'}</strong>
        <span className={`connection-status ${status.className}`}>
          <Wifi size={13} />
          {status.label}
        </span>
      </div>
      <div className="top-actions">
        <div className="top-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="更多操作"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={22} />
          </button>
          {menuOpen ? (
            <div className="top-menu-popover" role="menu" aria-label="更多操作">
              <div className="top-menu-title">
                <MoreHorizontal size={16} />
                <span>更多</span>
              </div>
              <button type="button" role="menuitem" onClick={handleCopyThreadId} disabled={!canCopyThreadId}>
                {copiedThreadId ? <Check size={16} /> : <Copy size={16} />}
                <span>{copiedThreadId ? '已复制对话 ID' : '复制对话 ID'}</span>
              </button>
              <button type="button" role="menuitem" onClick={handleOpenDocs}>
                <FeishuLogoIcon size={18} className="top-docs-logo" />
                <span>飞书文档</span>
              </button>
              <button type="button" role="menuitem" onClick={handleEnableNotifications}>
                <Bell size={16} />
                <span>{notificationEnabled ? '完成通知已开启' : '开启完成通知'}</span>
              </button>
              <div className="top-menu-divider" />
              <div className="top-menu-title">
                <GitBranch size={16} />
                <span>Git</span>
              </div>
              <button type="button" role="menuitem" onClick={() => handleGitAction('status')} disabled={gitDisabled}>
                <GitBranch size={16} />
                <span>Git 面板</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('sync')} disabled={gitDisabled}>
                <RefreshCw size={16} />
                <span>同步</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('commit')} disabled={gitDisabled}>
                <GitCommitHorizontal size={16} />
                <span>提交</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('push')} disabled={gitDisabled}>
                <UploadCloud size={16} />
                <span>推送</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('branch')} disabled={gitDisabled}>
                <GitBranch size={16} />
                <span>创建分支</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function FeishuLogoIcon({ size = 30, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="飞书"
    >
      <rect x="4" y="4" width="56" height="56" rx="15" fill="#fff" />
      <path
        d="M24 15h16.4c2.2 0 3.4.7 4.7 2.5 4.1 5.7 6.5 12.2 7 19.6-6.4-5.5-13.3-8.5-20.4-8.7L24 15Z"
        fill="#12C9B7"
      />
      <path
        d="M14.5 25.8c7.1 7.9 15.3 13.8 24.5 17.8 7.4 3.2 14.7 2.7 21.4-1.6-5.7 9.6-14.7 15.1-27 16.4-7.1.8-13.9-.1-20.5-2.8-2.4-1-4.2-3.2-4.2-5.9V28.1c0-2.3 2.4-3.8 5.8-2.3Z"
        fill="#3A73F6"
      />
      <path
        d="M30.8 38.4c8.7-9.7 18.3-14.1 28.8-8.7-4.8 9.1-12.2 16.1-21.5 17.2-5.8.7-11.7-1-17.8-5.1 3.7-.5 7.2-1.6 10.5-3.4Z"
        fill="#1F45A7"
      />
    </svg>
  );
}

function DocsPanel({ open, docs, busy, error, onClose, onConnect, onDisconnect, onOpenHome, onOpenAuth, onRefresh }) {
  if (!open) {
    return null;
  }

  const cliInstalled = Boolean(docs?.cliInstalled);
  const skillsInstalled = Boolean(docs?.skillsInstalled);
  const configured = Boolean(docs?.configured);
  const connected = Boolean(docs?.connected);
  const authorizationReady = connected && Boolean(docs?.authorizationReady);
  const missingScopes = Array.isArray(docs?.missingScopes) ? docs.missingScopes : [];
  const needsExtraAuth = connected && (!authorizationReady || missingScopes.length > 0);
  const slidesAuthorized = connected && Boolean(docs?.slidesAuthorized);
  const sheetsAuthorized = connected && Boolean(docs?.sheetsAuthorized);
  const authPending = docs?.authPending;
  const setupItems = [
    { id: 'cli', label: 'lark-cli', ok: cliInstalled },
    { id: 'skills', label: '官方 skills', ok: skillsInstalled },
    { id: 'config', label: 'App 凭证', ok: configured },
    { id: 'auth', label: '用户授权', ok: connected },
    { id: 'slides', label: 'PPT 权限', ok: slidesAuthorized },
    { id: 'sheets', label: '表格权限', ok: sheetsAuthorized }
  ];
  const subtitle = connected
    ? needsExtraAuth
      ? '待补权限'
      : ''
    : authPending?.status === 'polling'
      ? '等待授权'
      : configured
        ? '未连接'
        : '未配置';
  const summary = authPending?.status === 'polling'
      ? '授权页已打开，完成后回到这里刷新状态。'
      : connected
        ? needsExtraAuth
          ? '飞书账号已连接，但部分文档权限还没授权。补充授权后，Codex 可完整操作飞书文档、PPT、表格和云空间文件。'
          : 'Codex 已可操作飞书文档、PPT、表格和云空间文件。'
        : !cliInstalled
          ? '本机还没有检测到 lark-cli。'
          : !skillsInstalled
            ? '官方文档 skills 还没有安装完整。'
            : configured
              ? '连接飞书账号后，Codex 才能以你的身份操作文档、PPT 和表格。'
              : '请先在后端配置飞书 App ID 和 Secret。';
  const canConnect = cliInstalled && skillsInstalled && configured;

  return (
    <section className="docs-panel" role="dialog" aria-modal="true" aria-label="飞书文档">
      <header className="docs-panel-header">
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭文档">
          <ChevronLeft size={22} />
        </button>
        <div className="docs-panel-title">
          <strong>飞书文档</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭文档">
          <X size={20} />
        </button>
      </header>
      <div className="docs-panel-body">
        <div className="docs-status-state">
          <div className="docs-status-icon">
            <FeishuLogoIcon size={58} />
          </div>
          <h2>飞书文档</h2>
          <p>{summary}</p>
          {error ? <div className="docs-panel-error">{error}</div> : null}
          {authPending?.verificationUrl && (!connected || needsExtraAuth) ? (
            <div className="docs-auth-box">
              <span>授权码 {authPending.userCode || '已生成'}</span>
              <button type="button" onClick={() => onOpenAuth(authPending.verificationUrl)}>
                打开授权页
              </button>
            </div>
          ) : null}
          <div className="docs-check-list">
            {setupItems.map((item) => (
              <div key={item.id} className={item.ok ? 'is-ok' : ''}>
                {item.ok ? <Check size={15} /> : <X size={15} />}
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          {needsExtraAuth && missingScopes.length ? (
            <div className="docs-scope-hint">
              缺少 {missingScopes.slice(0, 4).join('、')}
            </div>
          ) : null}
          <div className="docs-panel-actions">
            {connected ? (
              <>
                <button type="button" onClick={needsExtraAuth ? onConnect : onOpenHome} disabled={needsExtraAuth && busy}>
                  {needsExtraAuth ? (
                    busy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />
                  ) : (
                    <FeishuLogoIcon size={18} />
                  )}
                  {needsExtraAuth ? '补充授权' : '打开飞书'}
                </button>
                <button type="button" onClick={onDisconnect} disabled={busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <X size={16} />}
                  断开
                </button>
                <button type="button" onClick={onRefresh} disabled={busy}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onConnect} disabled={!canConnect || busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
                  连接飞书
                </button>
                <button type="button" onClick={onRefresh} disabled={busy}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function gitActionTitle(action) {
  if (action === 'status') {
    return 'Git 面板';
  }
  if (action === 'diff') {
    return 'Git Diff';
  }
  if (action === 'sync') {
    return 'Git 同步';
  }
  if (action === 'commit-push') {
    return '提交并推送';
  }
  if (action === 'commit') {
    return 'Git 提交';
  }
  if (action === 'push') {
    return 'Git 推送';
  }
  if (action === 'branch') {
    return '创建分支';
  }
  return 'Git';
}

function gitBranchDraft(project) {
  const name = String(project?.name || 'changes')
    .trim()
    .toLowerCase()
    .replace(/^codex\//, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return `codex/${name || 'changes'}`;
}

function gitViewFromAction(action) {
  if (action === 'commit' || action === 'commit-push') {
    return 'commit';
  }
  if (action === 'branch') {
    return 'branch';
  }
  if (action === 'push' || action === 'sync') {
    return 'sync';
  }
  if (action === 'diff') {
    return 'diff';
  }
  return 'status';
}

function gitSafetyWarnings(status = {}) {
  const warnings = [];
  const files = Array.isArray(status.files) ? status.files : [];
  if (files.length) {
    warnings.push(`工作区有 ${files.length} 个改动文件`);
  }
  if (status.behind > 0) {
    warnings.push(`落后远端 ${status.behind} 个提交，pull/sync 会先尝试快进`);
  }
  if (status.branch && !String(status.branch).startsWith('codex/')) {
    warnings.push('当前不是 codex/ 分支，操作前请确认分支用途');
  }
  if (status.branch && !status.upstream) {
    warnings.push('当前分支没有 upstream，push 会设置 origin upstream');
  }
  if (!status.clean && status.behind > 0) {
    warnings.push('本地有改动且落后远端，pull 可能失败并保留 Git 原始输出');
  }
  return warnings;
}

function GitPanel({ open, action, project, onClose, onToast }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [diff, setDiff] = useState(null);
  const [activeView, setActiveView] = useState(() => gitViewFromAction(action));
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');

  const projectId = project?.id || '';
  const title = gitActionTitle(activeView === 'status' ? 'status' : activeView);
  const files = Array.isArray(status?.files) ? status.files : [];
  const canCommit = Boolean(status?.canCommit);
  const canPush = Boolean(status?.branch);
  const safetyWarnings = gitSafetyWarnings(status || {});

  const loadGitStatus = useCallback(async () => {
    if (!open || !projectId) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
      const nextStatus = data.status || null;
      setStatus(nextStatus);
      setCommitMessage((current) => current || nextStatus?.defaultCommitMessage || '');
      setBranchName((current) => current || gitBranchDraft(project));
    } catch (loadError) {
      setError(loadError.message || '读取 Git 状态失败');
    } finally {
      setBusy(false);
    }
  }, [open, projectId, project]);

  const loadGitDiff = useCallback(async () => {
    if (!open || !projectId) {
      return;
    }
    setBusy(true);
    setBusyAction('diff');
    setError('');
    try {
      const data = await apiFetch(`/api/git/diff?projectId=${encodeURIComponent(projectId)}`);
      setDiff(data.diff || null);
      if (data.diff?.status) {
        setStatus(data.diff.status);
      }
    } catch (loadError) {
      setError(loadError.message || '读取 Git diff 失败');
    } finally {
      setBusy(false);
      setBusyAction('');
    }
  }, [open, projectId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setResult(null);
    setDiff(null);
    setActiveView(gitViewFromAction(action));
    setCommitMessage('');
    setBranchName('');
    loadGitStatus();
  }, [open, action, projectId, loadGitStatus]);

  useEffect(() => {
    if (open && activeView === 'diff' && !diff && !busy) {
      loadGitDiff();
    }
  }, [open, activeView, diff, busy, loadGitDiff]);

  if (!open) {
    return null;
  }

  async function runGitAction(nextAction = action) {
    if (!projectId || busy) {
      return;
    }
    setBusy(true);
    setBusyAction(nextAction);
    setError('');
    setResult(null);
    onToast?.({ level: 'info', title: gitActionTitle(nextAction), body: '正在执行 Git 操作...' });
    try {
      let data = null;
      if (nextAction === 'commit') {
        data = await apiFetch('/api/git/commit', {
          method: 'POST',
          body: { projectId, message: commitMessage }
        });
      } else if (nextAction === 'commit-push') {
        data = await apiFetch('/api/git/commit-push', {
          method: 'POST',
          body: { projectId, message: commitMessage }
        });
      } else if (nextAction === 'push') {
        data = await apiFetch('/api/git/push', {
          method: 'POST',
          body: { projectId }
        });
      } else if (nextAction === 'pull') {
        data = await apiFetch('/api/git/pull', {
          method: 'POST',
          body: { projectId }
        });
      } else if (nextAction === 'sync') {
        data = await apiFetch('/api/git/sync', {
          method: 'POST',
          body: { projectId }
        });
      } else if (nextAction === 'branch') {
        data = await apiFetch('/api/git/branch', {
          method: 'POST',
          body: { projectId, branchName }
        });
      }
      setResult(data || {});
      setStatus(data?.status || status);
      if (data?.status?.defaultCommitMessage) {
        setCommitMessage(data.status.defaultCommitMessage);
      }
      onToast?.({ level: 'success', title: gitActionTitle(nextAction), body: 'Git 操作已完成' });
    } catch (runError) {
      setError(runError.message || 'Git 操作失败');
      onToast?.({ level: 'error', title: gitActionTitle(nextAction), body: runError.message || 'Git 操作失败' });
    } finally {
      setBusy(false);
      setBusyAction('');
    }
  }

  const commitDisabled = busy || !projectId || !canCommit || !commitMessage.trim();
  const pushDisabled = busy || !projectId || !canPush;
  const branchDisabled = busy || !projectId || !branchName.trim();

  return (
    <section className="docs-panel git-panel" role="dialog" aria-modal="true" aria-label={title}>
      <header className="docs-panel-header">
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭 Git">
          <ChevronLeft size={22} />
        </button>
        <div className="docs-panel-title">
          <strong>{title}</strong>
          <span>{status?.branch || project?.name || 'Git'}</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭 Git">
          <X size={20} />
        </button>
      </header>
      <div className="docs-panel-body git-panel-body">
        <div className="git-tabs" role="tablist" aria-label="Git 操作">
          {[
            ['status', '状态'],
            ['diff', 'Diff'],
            ['sync', '同步'],
            ['commit', '提交'],
            ['branch', '分支']
          ].map(([view, label]) => (
            <button
              key={view}
              type="button"
              className={activeView === view ? 'is-active' : ''}
              onClick={() => setActiveView(view)}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="git-status-card">
          <div className="git-status-head">
            <div>
              <strong>{status?.clean ? '工作区干净' : '当前改动'}</strong>
              <span>
                {status?.branch || '未读取'}
                {status?.upstream ? ` -> ${status.upstream}` : ''}
              </span>
            </div>
            <button type="button" className="icon-button" onClick={loadGitStatus} disabled={busy} aria-label="刷新 Git 状态">
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="git-status-metrics">
            <span>{files.length} 个文件</span>
            <span>ahead {status?.ahead || 0}</span>
            <span>behind {status?.behind || 0}</span>
          </div>
          {files.length ? (
            <div className="git-file-list">
              {files.slice(0, 18).map((file) => (
                <div key={`${file.status}:${file.path}`}>
                  <code>{file.status}</code>
                  <span>{file.path}</span>
                </div>
              ))}
              {files.length > 18 ? <small>还有 {files.length - 18} 个文件</small> : null}
            </div>
          ) : null}
          {safetyWarnings.length ? (
            <div className="git-safety-list">
              {safetyWarnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          ) : null}
        </section>

        {activeView === 'diff' ? (
          <section className="git-diff-card">
            <div className="git-section-head">
              <strong>Diff 预览</strong>
              <button type="button" onClick={loadGitDiff} disabled={busy}>
                {busyAction === 'diff' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                刷新
              </button>
            </div>
            {diff?.summary ? <pre className="git-diff-summary">{diff.summary}</pre> : null}
            <pre className="git-diff-pre">{diff?.patch || (busyAction === 'diff' ? '正在读取 diff...' : '暂无 diff')}</pre>
            {diff?.truncated ? <small className="git-diff-note">diff 太长，已截断显示。</small> : null}
          </section>
        ) : null}

        {activeView === 'sync' ? (
          <section className="git-action-card">
            <div className="git-section-head">
              <strong>同步操作</strong>
              <span>pull 使用 --ff-only，sync 会 pull 后按需 push</span>
            </div>
            <div className="git-action-grid">
              <button type="button" onClick={() => runGitAction('pull')} disabled={busy || !projectId}>
                {busyAction === 'pull' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                Pull
              </button>
              <button type="button" onClick={() => runGitAction('sync')} disabled={busy || !projectId}>
                {busyAction === 'sync' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                Sync
              </button>
              <button type="button" onClick={() => runGitAction('push')} disabled={pushDisabled}>
                {busyAction === 'push' ? <Loader2 className="spin" size={15} /> : <UploadCloud size={15} />}
                Push
              </button>
            </div>
          </section>
        ) : null}

        {activeView === 'commit' ? (
          <label className="git-field">
            <span>提交信息</span>
            <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
          </label>
        ) : null}

        {activeView === 'commit' ? (
          <div className="git-action-grid">
            <button type="button" onClick={() => runGitAction('commit')} disabled={commitDisabled}>
              {busyAction === 'commit' ? <Loader2 className="spin" size={15} /> : <GitCommitHorizontal size={15} />}
              提交
            </button>
            <button type="button" onClick={() => runGitAction('commit-push')} disabled={commitDisabled}>
              {busyAction === 'commit-push' ? <Loader2 className="spin" size={15} /> : <UploadCloud size={15} />}
              提交并推送
            </button>
          </div>
        ) : null}

        {activeView === 'branch' ? (
          <label className="git-field">
            <span>分支名</span>
            <input value={branchName} onChange={(event) => setBranchName(event.target.value)} />
          </label>
        ) : null}

        {activeView === 'branch' ? (
          <div className="git-action-grid">
            <button type="button" onClick={() => runGitAction('branch')} disabled={branchDisabled}>
              {busyAction === 'branch' ? <Loader2 className="spin" size={15} /> : <GitBranch size={15} />}
              创建分支
            </button>
          </div>
        ) : null}

        {error ? <div className="docs-panel-error">{error}</div> : null}
        {result ? (
          <div className="git-result">
            <Check size={17} />
            <span>
              {action === 'commit' && result.hash ? `已提交 ${result.hash}` : null}
              {result.hash && action !== 'commit' ? `已提交 ${result.hash}` : null}
              {result.branch || result.pushed?.branch ? `已更新 ${result.branch || result.pushed?.branch}` : null}
              {!result.hash && !result.branch && !result.pushed?.branch ? 'Git 操作已完成' : null}
            </span>
          </div>
        ) : null}
        {result?.output ? <pre className="git-output">{result.output}</pre> : null}

        <div className="docs-panel-actions git-panel-actions">
          <button type="button" onClick={loadGitStatus} disabled={busy}>
            <RefreshCw size={16} />
            刷新状态
          </button>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </section>
  );
}

function ActivityMessage({ message, now = Date.now() }) {
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const [open, setOpen] = useState(() => running);
  const activities = message.activities || [];
  const visibleSteps = activities.filter((activity) => isVisibleActivityStep(activity, message.status));
  const details = activityTimeRange(visibleSteps);
  const timeline = buildActivityTimeline(visibleSteps, running);
  const fileSummary = buildActivityFileSummary(visibleSteps);
  const startedAt = message.startedAt || details.startedAt || message.timestamp;
  const endedAt = running ? now : message.completedAt || details.endedAt || message.timestamp || now;
  const duration = !running ? formatDurationMs(message.durationMs) || formatDuration(startedAt, endedAt) : formatDuration(startedAt, endedAt);
  const headline = failed ? '处理失败' : running ? '处理中' : '已处理';

  useEffect(() => {
    setOpen(running);
  }, [message.id, running]);

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''}`}>
        <button
          type="button"
          className="activity-summary"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{duration ? `${headline} ${duration}` : headline}</span>
          <ChevronDown className={`activity-chevron ${open ? 'is-open' : ''}`} size={15} />
        </button>
        {open && (timeline.length || fileSummary) ? (
          <div className="activity-timeline" aria-label="任务进度">
            {timeline.map((item) =>
              item.type === 'text' ? (
                <MarkdownContent
                  key={item.id}
                  className="message-content activity-markdown activity-text"
                  text={item.text}
                />
              ) : item.type === 'live' ? (
                <div key={item.id} className={`activity-live is-${item.liveType || 'step'} ${item.status === 'running' ? 'is-running' : ''}`}>
                  <span className="activity-live-dot" />
                  <span>{item.text}</span>
                </div>
              ) : item.type === 'divider' ? (
                <div key={item.id} className="activity-divider">
                  <span>{item.text}</span>
                </div>
              ) : item.metaType === 'subagent' ? (
                <SubagentActivityBlock key={item.id} item={item} />
              ) : item.items.some((step) => activityDetailText(step)) ? (
                <details key={item.id} className={`activity-meta ${item.items.some((step) => step.status === 'running' || step.status === 'queued') ? 'is-running' : ''}`}>
                  <summary className="activity-meta-summary">
                    {activityMetaIcon(item)}
                    <span>{item.title}</span>
                  </summary>
                  <div className="activity-meta-body">
                    {item.items.filter((step) => activityDetailText(step)).map((step) => (
                      <ActivityStepDetail key={step.id} step={step} />
                    ))}
                  </div>
                </details>
              ) : (
                <div key={item.id} className={`activity-meta ${item.items.some((step) => step.status === 'running' || step.status === 'queued') ? 'is-running' : ''}`}>
                  <div className="activity-meta-summary">
                    {activityMetaIcon(item)}
                    <span>{item.title}</span>
                  </div>
                </div>
              )
            )}
            {fileSummary ? <ActivityFileSummary summary={fileSummary} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActivityStepDetail({ step }) {
  const detail = activityDetailText(step);
  const isCommand = step.type === 'command' || Boolean(step.command);
  if (isCommand) {
    const command = step.command || detail;
    const output = step.output || step.error || '';
    const failed = step.status === 'failed';
    const running = step.status === 'running';
    const title = `${failed ? '本地任务失败' : running ? '正在处理本地任务' : '本地任务已处理'} ${conciseActivityDetail(command, 110)}`;
    const shellText = [`$ ${command}`, output].filter(Boolean).join('\n\n');
    const statusText = failed && step.exitCode !== undefined && step.exitCode !== null
      ? `退出码 ${step.exitCode}`
      : failed
        ? '失败'
        : running
          ? '运行中'
          : '成功';
    return (
      <details className={`activity-command-detail ${failed ? 'is-failed' : ''}`} open={failed}>
        <summary>
          <span>{title}</span>
        </summary>
        <div className="activity-shell">
          <div className="activity-shell-head">Shell</div>
          <pre><code>{shellText}</code></pre>
          <div className="activity-shell-status">{statusText}</div>
        </div>
      </details>
    );
  }

  return (
    <div className="activity-meta-line">
      <MarkdownContent
        className="message-content activity-markdown activity-meta-label"
        text={step.label}
      />
      <MarkdownContent
        className="message-content activity-markdown activity-meta-detail"
        text={detail}
      />
    </div>
  );
}

function SubagentActivityBlock({ item }) {
  const agents = item.items.flatMap((step) => (Array.isArray(step.subAgents) ? step.subAgents : []));
  const title = item.items[0]?.label || item.title || `${agents.length || 1} 个后台智能体（使用 @ 标记智能体）`;
  return (
    <details className="activity-meta activity-subagents">
      <summary className="activity-meta-summary">
        <Bot size={13} />
        <span>{title}</span>
      </summary>
      <div className="activity-subagent-list">
        {agents.length ? agents.map((agent) => (
          <div key={agent.threadId || `${agent.nickname}-${agent.role}`} className="activity-subagent-row">
            <span>
              <strong>{agent.nickname || agent.threadId || '子代理'}</strong>
              {agent.role ? <small>({agent.role})</small> : null}
              <em>{agent.statusText || '打开'}</em>
            </span>
          </div>
        )) : (
          <div className="activity-subagent-row">
            <span><strong>{item.title}</strong></span>
          </div>
        )}
      </div>
    </details>
  );
}

function activityTimeRange(steps) {
  let startedAt = null;
  let endedAt = null;

  for (const step of steps || []) {
    const timestamp = step.timestamp || '';
    if (timestamp && (!startedAt || new Date(timestamp) < new Date(startedAt))) {
      startedAt = timestamp;
    }
    if (timestamp && (!endedAt || new Date(timestamp) > new Date(endedAt))) {
      endedAt = timestamp;
    }
  }

  return { startedAt, endedAt };
}

function stepsForActivityTimeline(steps) {
  const items = Array.isArray(steps) ? steps : [];
  let latestThinkingIndex = -1;
  items.forEach((step, index) => {
    if (isThinkingActivityStep(step)) {
      latestThinkingIndex = index;
    }
  });
  return items.filter((step, index) => {
    if (isThinkingActivityStep(step)) {
      return index === latestThinkingIndex;
    }
    return true;
  });
}

function buildActivityTimeline(steps, running) {
  const timeline = [];
  let batch = [];
  let batchIndex = 0;

  function flushBatch() {
    if (!batch.length) {
      return;
    }
    timeline.push({
      id: `meta-${batchIndex++}-${batch.map((item) => item.id).join('-')}`,
      type: 'meta',
      metaType: dominantActivityType(batch),
      title: summarizeActivityBatch(batch, running),
      items: batch
    });
    batch = [];
  }

  for (const step of stepsForActivityTimeline(steps)) {
    if (isThinkingActivityStep(step)) {
      flushBatch();
      timeline.push({
        id: `thinking-${step.id}`,
        type: 'live',
        liveType: 'thinking',
        text: thinkingActivityText(step),
        status: step.status || 'running'
      });
    } else if (isContextCompactionActivity(step)) {
      flushBatch();
      timeline.push({
        id: `divider-${step.id}`,
        type: 'divider',
        text: step.status === 'running' ? '正在自动压缩上下文' : '上下文已自动压缩'
      });
    } else if (isNarrativeActivity(step)) {
      flushBatch();
      timeline.push({
        id: `text-${step.id}`,
        type: 'text',
        text: String(step.label || step.detail || step.content || '').trim()
      });
    } else {
      const item = activityTimelineItem(step);
      if (!isPlaceholderTimelineItem(item)) {
        batch.push(item);
      }
    }
  }
  flushBatch();

  return timeline;
}

function isContextCompactionActivity(step) {
  const source = `${step?.kind || ''} ${step?.label || ''} ${step?.detail || ''}`.trim();
  return step?.kind === 'context_compaction' || /自动压缩上下文|上下文已自动压缩/.test(source);
}

function isNarrativeActivity(step) {
  const label = String(step?.label || '').trim();
  const detail = activityDetailText(step);
  const source = `${step?.kind || ''} ${label} ${detail}`.toLowerCase();
  if (step?.command) {
    return false;
  }
  if (step?.kind === 'agent_message' || step?.kind === 'message') {
    return true;
  }
  if (/command|function_call|工具|命令|已运行|执行|编辑|修改|写入|读取|搜索|检查|查看|explore|search|read/.test(source)) {
    return false;
  }
  return label.length > 26;
}

function activityTimelineItem(step) {
  const descriptor = describeActivityStep(step);
  return {
    id: step.id,
    type: descriptor.type,
    label: descriptor.label,
    detail: descriptor.detail,
    count: descriptor.count,
    unit: descriptor.unit,
    command: step.command || '',
    output: step.output || '',
    error: step.error || '',
    exitCode: step.exitCode,
    subAgents: step.subAgents || [],
    status: step.status || 'running'
  };
}

function describeActivityStep(step) {
  const detail = activityDetailText(step);
  const label = String(step?.label || '').trim();
  const toolName = String(step?.toolName || '').trim();
  const command = String(step?.command || '').trim();
  const source = `${step?.kind || ''} ${toolName} ${label} ${command} ${detail} ${step?.output || ''}`.toLowerCase();
  const fileRefs = extractFileRefs([command, detail, step?.output, fileChangeText(step)].filter(Boolean).join('\n'));
  const count = Math.max(1, fileRefs.size || (Array.isArray(step?.fileChanges) ? step.fileChanges.length : 0));

  if (step?.kind === 'file_change' || Array.isArray(step?.fileChanges) && step.fileChanges.length) {
    return {
      type: 'edit',
      label: compactActivityText(label || '编辑文件'),
      detail: detail || compactActivityText(fileChangeText(step)),
      count,
      unit: 'file'
    };
  }

  const commandKind = classifyCommandIntent(
    command || (step?.kind === 'command_execution' ? detail : ''),
    Boolean(command) || step?.kind === 'command_execution'
  );
  if (commandKind) {
    const type =
      commandKind === 'search'
        ? 'search'
        : commandKind === 'read' || commandKind === 'inspect'
          ? 'explore'
          : commandKind === 'edit'
            ? 'edit'
            : 'command';
    return {
      type,
      label: compactActivityText(label || commandActivityLabel(commandKind)),
      detail: compactActivityText(command || detail),
      count: type === 'command' ? 1 : count,
      unit: type === 'command' ? 'command' : type === 'search' ? 'time' : 'file'
    };
  }

  if (step?.kind === 'web_search' || /web_search|网页搜索|搜索网页|web search/.test(source)) {
    return {
      type: 'web_search',
      label: compactActivityText(label || '网页搜索'),
      detail,
      count: 1,
      unit: 'time'
    };
  }

  if (step?.kind === 'subagent_activity' || /后台智能体|subagent|spawn_agent|wait_agent/.test(source)) {
    return {
      type: 'subagent',
      label: compactActivityText(label || '后台智能体'),
      detail,
      count: Math.max(1, Array.isArray(step?.subAgents) ? step.subAgents.length : 1),
      unit: 'agent'
    };
  }

  if (/搜索|查找|search/.test(source)) {
    return {
      type: 'search',
      label: compactActivityText(label || '搜索'),
      detail,
      count: 1,
      unit: 'time'
    };
  }

  if (/browser_|浏览器|截图|点击|导航|navigate|screenshot|click|type/.test(source)) {
    return {
      type: 'browser',
      label: compactActivityText(label || browserActivityLabel(toolName || source)),
      detail,
      count: 1,
      unit: 'action'
    };
  }

  if (/编辑|修改|写入|替换|创建|删除|updated|deleted|apply_patch/.test(source)) {
    return {
      type: 'edit',
      label: compactActivityText(label || '编辑文件'),
      detail,
      count,
      unit: 'file'
    };
  }

  if (/读取|查看|检查|探索|read|list|inspect|load_workspace_dependencies|view_image/.test(source)) {
    return {
      type: 'explore',
      label: compactActivityText(label || '探索文件'),
      detail,
      count,
      unit: 'file'
    };
  }

  if (/todo_list|计划/.test(source)) {
    return {
      type: 'plan',
      label: compactActivityText(label || '更新计划'),
      detail,
      count: 1,
      unit: 'step'
    };
  }

  return {
    type: 'tool',
    label: compactActivityText(label || (toolName ? `调用 ${toolName}` : '调用工具')),
    detail,
    count: 1,
    unit: 'step'
  };
}

function dominantActivityType(items) {
  if (items.some((item) => item.type === 'command')) {
    return 'command';
  }
  if (items.some((item) => item.type === 'edit')) {
    return 'edit';
  }
  if (items.some((item) => item.type === 'search')) {
    return 'search';
  }
  if (items.some((item) => item.type === 'web_search')) {
    return 'web_search';
  }
  if (items.some((item) => item.type === 'browser')) {
    return 'browser';
  }
  if (items.some((item) => item.type === 'explore')) {
    return 'explore';
  }
  if (items.some((item) => item.type === 'subagent')) {
    return 'subagent';
  }
  return items[0]?.type || 'tool';
}

function summarizeActivityBatch(items, running) {
  const activeItem = items.length === 1 && running && items[0]?.status === 'running' ? items[0] : null;
  if (activeItem?.type === 'edit') {
    const detail = activeItem.detail || activeItem.label || '';
    return detail ? `正在编辑 ${conciseActivityDetail(detail)}` : '正在编辑文件';
  }
  if (activeItem?.type === 'command' && activeItem.detail) {
    return `正在运行 ${conciseActivityDetail(activeItem.detail)}`;
  }
  if ((activeItem?.type === 'search' || activeItem?.type === 'web_search') && activeItem.detail) {
    return `正在搜索 ${conciseActivityDetail(activeItem.detail)}`;
  }
  if ((activeItem?.type === 'explore' || activeItem?.type === 'browser' || activeItem?.type === 'tool') && activeItem.detail) {
    return `${activeItem.label || '正在处理'} ${conciseActivityDetail(activeItem.detail)}`;
  }
  if (activeItem?.type === 'subagent') {
    return activeItem.label || '正在运行后台智能体';
  }

  const order = [];
  const groups = items.reduce((acc, item) => {
    const key = item.type || 'tool';
    if (!acc[key]) {
      acc[key] = { steps: 0, count: 0, failed: 0, running: false, unit: item.unit || 'step' };
      order.push(key);
    }
    acc[key].steps += 1;
    acc[key].count += Number(item.count) || 1;
    acc[key].failed += item.status === 'failed' ? Number(item.count) || 1 : 0;
    acc[key].running = acc[key].running || item.status === 'running';
    return acc;
  }, {});

  function groupText(key, group) {
    const active = running && group.running;
    const doneCount = Math.max(0, group.count - group.failed);
    const failedOnly = group.failed && !doneCount && !active;
    if (key === 'search') {
      return failedOnly ? `搜索失败 ${group.failed} 次` : `${active ? '正在搜索' : '已搜索'} ${doneCount || group.count} 次`;
    }
    if (key === 'web_search') {
      return failedOnly ? `网页搜索失败 ${group.failed} 次` : `${active ? '正在搜索网页' : '已搜索网页'} ${doneCount || group.count} 次`;
    }
    if (key === 'explore') {
      return failedOnly ? `探索失败 ${group.failed} 次` : `${active ? '正在探索' : '已探索'} ${doneCount || group.count} 个文件`;
    }
    if (key === 'edit') {
      return failedOnly ? `编辑失败 ${group.failed} 个文件` : `${active ? '正在编辑' : '已编辑'} ${doneCount || group.count} 个文件`;
    }
    if (key === 'command') {
      return failedOnly ? `${group.failed} 个本地任务失败` : `${active ? '正在处理' : '已处理'} ${doneCount || group.count} 个本地任务`;
    }
    if (key === 'browser') {
      return failedOnly ? `浏览器操作失败 ${group.failed} 次` : `${active ? '正在操作浏览器' : '已操作浏览器'} ${doneCount || group.count} 次`;
    }
    if (key === 'plan') {
      return failedOnly ? '计划更新失败' : active ? '正在更新计划' : '已更新计划';
    }
    if (key === 'tool') {
      return failedOnly ? `${group.failed} 步操作失败` : `${active ? '正在完成' : '已完成'} ${doneCount || group.count} 步操作`;
    }
    if (key === 'subagent') {
      return failedOnly
        ? `后台智能体失败 ${group.failed} 个`
        : `${active ? '正在运行' : '已完成'} ${doneCount || group.count} 个后台智能体`;
    }
    return '';
  }

  const parts = [];
  for (const key of order) {
    const text = groupText(key, groups[key]);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('，') || '已处理';
}

function activityMetaIcon(item) {
  if (item.metaType === 'command') {
    return <Terminal size={13} />;
  }
  if (item.metaType === 'edit') {
    return <Pencil size={13} />;
  }
  if (item.metaType === 'search' || item.metaType === 'web_search') {
    return <Search size={13} />;
  }
  if (item.metaType === 'subagent') {
    return <Bot size={13} />;
  }
  return <FileText size={13} />;
}

function activityDetailText(activity) {
  const label = String(activity?.label || '').trim();
  const detail = String(activity?.command || activity?.detail || activity?.error || '').trim();
  if (!detail || detail === label || isGenericActivityLabel(detail)) {
    return '';
  }
  return detail;
}

function fileChangeText(step) {
  return Array.isArray(step?.fileChanges)
    ? step.fileChanges.map((change) => `${change.kind || 'update'} ${change.path || ''}`.trim()).filter(Boolean).join('\n')
    : '';
}

function buildActivityFileSummary(steps) {
  const files = new Map();
  for (const step of steps || []) {
    if (!Array.isArray(step?.fileChanges)) {
      continue;
    }
    for (const change of step.fileChanges) {
      const rawPath = String(change?.path || '').trim();
      if (!rawPath) {
        continue;
      }
      const existing = files.get(rawPath) || {
        path: rawPath,
        label: compactActivityPath(rawPath),
        additions: 0,
        deletions: 0,
        kind: change?.kind || 'update',
        diffs: []
      };
      const diff = change?.unifiedDiff || change?.unified_diff || change?.diff || '';
      const stats = diffStatsFromUnifiedDiff(diff);
      existing.additions += Number(change?.additions) || stats.additions;
      existing.deletions += Number(change?.deletions) || stats.deletions;
      existing.kind = change?.kind || existing.kind;
      if (diff && !existing.diffs.includes(diff)) {
        existing.diffs.push(diff);
      }
      files.set(rawPath, existing);
    }
  }
  const items = [...files.values()];
  if (!items.length) {
    return null;
  }
  return {
    files: items,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0)
  };
}

function diffStatsFromUnifiedDiff(unifiedDiff = '') {
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

function compactActivityPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const marker = '/CodexMobile/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length);
  }
  if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 3 ? parts.slice(-3).join('/') : parts.join('/');
  }
  return normalized;
}

function parseUnifiedDiffLines(unifiedDiff = '') {
  const rows = [];
  let oldLine = null;
  let newLine = null;
  for (const rawLine of String(unifiedDiff || '').split(/\r?\n/)) {
    const hunk = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ type: 'hunk', oldLine: '', newLine: '', text: rawLine });
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ )/.test(rawLine)) {
      continue;
    }
    if (rawLine.startsWith('\\ No newline')) {
      rows.push({ type: 'meta', oldLine: '', newLine: '', text: rawLine });
      continue;
    }
    if (oldLine === null || newLine === null) {
      if (rawLine.trim()) {
        rows.push({ type: 'meta', oldLine: '', newLine: '', text: rawLine });
      }
      continue;
    }
    if (rawLine.startsWith('+')) {
      rows.push({ type: 'add', oldLine: '', newLine: newLine++, text: rawLine.slice(1) });
    } else if (rawLine.startsWith('-')) {
      rows.push({ type: 'del', oldLine: oldLine++, newLine: '', text: rawLine.slice(1) });
    } else {
      rows.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine });
    }
  }
  return rows;
}

function ActivityDiffView({ diffs }) {
  const rows = (diffs || []).flatMap((diff, diffIndex) => {
    const parsed = parseUnifiedDiffLines(diff);
    if (diffIndex === 0) {
      return parsed;
    }
    return [{ type: 'gap', oldLine: '', newLine: '', text: '' }, ...parsed];
  });

  if (!rows.length) {
    return null;
  }
  return (
    <div className="activity-diff-shell">
      <div className="activity-diff-view">
        {rows.map((row, index) => (
          <div key={`${index}-${row.oldLine}-${row.newLine}`} className={`activity-diff-row is-${row.type}`}>
            <span className="activity-diff-num">{row.oldLine}</span>
            <span className="activity-diff-num">{row.newLine}</span>
            <code>{row.text || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityFileSummary({ summary }) {
  return (
    <div className="activity-file-summary">
      <div className="activity-file-summary-head">
        <span>{summary.files.length} 个文件已更改</span>
        {summary.additions ? <strong className="is-added">+{summary.additions}</strong> : null}
        {summary.deletions ? <strong className="is-deleted">-{summary.deletions}</strong> : null}
      </div>
      <div className="activity-file-list">
        {summary.files.map((file) => (
          <details key={file.path} className="activity-file-item">
            <summary>
              <span>{file.label}</span>
              {file.additions ? <strong className="is-added">+{file.additions}</strong> : null}
              {file.deletions ? <strong className="is-deleted">-{file.deletions}</strong> : null}
            </summary>
            <ActivityDiffView diffs={file.diffs} />
          </details>
        ))}
      </div>
    </div>
  );
}

function classifyCommandIntent(value, assumeCommand = false) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  const lower = text.toLowerCase();
  if (/\b(apply_patch|perl\s+-0pi|python\b.*\bwrite_text|node\b.*\bwritefile|cat\s+>)/.test(lower)) {
    return 'edit';
  }
  if (/\b(rg|grep|findstr|select-string)\b/.test(lower)) {
    return 'search';
  }
  if (/\b(sed|cat|nl|head|tail|less|more|awk|jq|wc|ls|find|fd|tree)\b/.test(lower)) {
    return 'read';
  }
  if (/\bgit\s+(status|diff|show|log|ls-files|branch|rev-parse)\b/.test(lower)) {
    return 'inspect';
  }
  if (/\b(lsof|curl|ps|pwd|date|which|node\s+--check|tsc|eslint|biome|prettier|npm\s+run\s+build|npm\s+run\s+smoke|npm\s+run\s+test|pnpm|yarn|bun|pytest|vitest|jest|kill|sleep|npm\s+run\s+start|npm\s+run\s+start:bg|node\s+)/.test(lower)) {
    return 'command';
  }
  return assumeCommand ? 'command' : '';
}

function commandActivityLabel(kind) {
  if (kind === 'search') {
    return '搜索代码';
  }
  if (kind === 'read' || kind === 'inspect') {
    return '探索文件';
  }
  if (kind === 'edit') {
    return '编辑文件';
  }
  return '运行命令';
}

function browserActivityLabel(toolName) {
  const text = String(toolName || '').toLowerCase();
  if (/screenshot/.test(text)) {
    return '截取浏览器';
  }
  if (/navigate/.test(text)) {
    return '打开页面';
  }
  if (/click|type|press/.test(text)) {
    return '操作页面';
  }
  return '操作浏览器';
}

function extractFileRefs(value) {
  const refs = new Set();
  const text = String(value || '');
  const pattern = /(?:^|[\s"'`(])((?:\.{1,2}|~|\/)?[\w@.+\-~\u4e00-\u9fff]+(?:\/[\w@.+\- \u4e00-\u9fff]+)+\.(?:jsx?|tsx?|css|scss|json|md|mjs|cjs|html|yml|yaml|toml|py|sh|sql|swift|kt|java|go|rs|rb|php|txt|log)|[\w@.+\-~\u4e00-\u9fff]+\.(?:jsx?|tsx?|css|scss|json|md|mjs|cjs|html|yml|yaml|toml|py|sh|sql|swift|kt|java|go|rs|rb|php|txt|log))/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1]?.replace(/[,:;.)\]]+$/g, '');
    if (candidate && !candidate.startsWith('http')) {
      refs.add(candidate);
    }
  }
  return refs;
}

function GeneratedImage({ part, onPreviewImage, compact = false }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const resolved = useResolvedImageSource(part.url, retryKey);
  const src = resolved.src;

  useEffect(() => {
    setLoadState(resolved.error ? 'failed' : resolved.cached ? 'loaded' : 'loading');
  }, [resolved.cached, resolved.error, src]);

  function retry(event) {
    event.stopPropagation();
    setLoadState('loading');
    setRetryKey(Date.now());
  }

  return (
    <button
      type="button"
      className={`message-image-link ${compact ? 'is-thumbnail' : ''} ${loadState === 'failed' ? 'is-failed' : ''}`}
      onClick={() => (loadState === 'failed' ? setRetryKey(Date.now()) : onPreviewImage?.(part))}
      aria-label="预览图片"
    >
      {src ? (
        <img
          className="message-image"
          src={src}
          alt={part.alt}
          loading="eager"
          decoding="async"
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('failed')}
        />
      ) : null}
      {loadState === 'failed' ? (
        <span className="image-error">
          图片加载失败
          <span onClick={retry}>重试</span>
        </span>
      ) : null}
    </button>
  );
}

function UserImageStrip({ images, onPreviewImage }) {
  if (!images?.length) {
    return null;
  }
  return (
    <div className="message-image-strip" aria-label="图片附件">
      {images.map((image, index) => (
        <GeneratedImage
          key={`${image.url}-${index}`}
          part={image}
          onPreviewImage={onPreviewImage}
          compact
        />
      ))}
    </div>
  );
}

function ImagePreviewModal({ image, onClose }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);
  const imageRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);
  const lastTapRef = useRef(0);
  const resolved = useResolvedImageSource(image?.url, retryKey);

  const clampScale = useCallback((value) => Math.min(5, Math.max(1, value)), []);
  const normalizeTransform = useCallback((next) => {
    const scale = clampScale(next.scale);
    if (scale === 1) {
      return { scale, x: 0, y: 0 };
    }
    return { scale, x: next.x, y: next.y };
  }, [clampScale]);
  const updateTransform = useCallback((updater) => {
    setTransform((current) => normalizeTransform(typeof updater === 'function' ? updater(current) : updater));
  }, [normalizeTransform]);
  const resetZoom = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    setIsGesturing(false);
    setTransform({ scale: 1, x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setLoadState('loading');
    setRetryKey(0);
    resetZoom();
  }, [image?.url, resetZoom]);

  useEffect(() => {
    setLoadState(resolved.error ? 'failed' : 'loading');
  }, [resolved.error, resolved.src]);

  useEffect(() => {
    return () => {
      pointersRef.current.clear();
    };
  }, []);

  if (!image) {
    return null;
  }

  const src = resolved.src;
  const zoomIn = () => updateTransform((current) => ({ ...current, scale: current.scale + 0.5 }));
  const zoomOut = () => updateTransform((current) => ({ ...current, scale: current.scale - 0.5 }));
  const pointerDistance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
  const pointerCenter = (first, second) => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });

  function handlePointerDown(event) {
    if (!src || loadState === 'failed') {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointer = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, pointer);
    setIsGesturing(true);
    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length === 2) {
      gestureRef.current = {
        mode: 'pinch',
        startDistance: pointerDistance(pointers[0], pointers[1]),
        startCenter: pointerCenter(pointers[0], pointers[1]),
        startTransform: transform
      };
    } else if (pointers.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        startPointer: pointer,
        startTransform: transform
      };
    }
  }

  function handlePointerMove(event) {
    if (!pointersRef.current.has(event.pointerId)) {
      return;
    }
    const pointer = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, pointer);
    const pointers = Array.from(pointersRef.current.values());
    const gesture = gestureRef.current;
    if (!gesture) {
      return;
    }
    if (gesture.mode === 'pinch' && pointers.length >= 2) {
      const distance = pointerDistance(pointers[0], pointers[1]);
      const center = pointerCenter(pointers[0], pointers[1]);
      const scale = gesture.startTransform.scale * (distance / Math.max(gesture.startDistance, 1));
      updateTransform({
        scale,
        x: gesture.startTransform.x + (center.x - gesture.startCenter.x),
        y: gesture.startTransform.y + (center.y - gesture.startCenter.y)
      });
      return;
    }
    if (gesture.mode === 'pan' && pointers.length === 1 && gesture.startTransform.scale > 1) {
      updateTransform({
        scale: gesture.startTransform.scale,
        x: gesture.startTransform.x + pointer.x - gesture.startPointer.x,
        y: gesture.startTransform.y + pointer.y - gesture.startPointer.y
      });
    }
  }

  function handlePointerEnd(event) {
    pointersRef.current.delete(event.pointerId);
    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length === 0) {
      gestureRef.current = null;
      setIsGesturing(false);
      return;
    }
    if (pointers.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        startPointer: pointers[0],
        startTransform: transform
      };
    }
  }

  function handleDoubleTap() {
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      updateTransform((current) => (current.scale > 1 ? { scale: 1, x: 0, y: 0 } : { ...current, scale: 2.5 }));
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
  }

  function handleWheel(event) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.25 : 0.25;
    updateTransform((current) => ({ ...current, scale: current.scale + delta }));
  }

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-top">
        <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭图片预览">
          <X size={22} />
        </button>
      </div>
      <div
        className={`lightbox-stage ${transform.scale > 1 ? 'is-zoomed' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          handleDoubleTap();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
      >
        {src ? (
          <img
            ref={imageRef}
            src={src}
            alt={image.alt || '生成图片'}
            style={{
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
              transition: isGesturing ? 'none' : undefined
            }}
            onLoad={() => setLoadState('loaded')}
            onError={() => setLoadState('failed')}
          />
        ) : null}
      </div>
      {loadState !== 'failed' ? (
        <div className="lightbox-zoom-controls" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={zoomOut} aria-label="缩小图片" disabled={transform.scale <= 1}>
            <Minus size={17} />
          </button>
          <button type="button" onClick={resetZoom} aria-label="重置图片缩放" disabled={transform.scale === 1 && transform.x === 0 && transform.y === 0}>
            {Math.round(transform.scale * 100)}%
          </button>
          <button type="button" onClick={zoomIn} aria-label="放大图片" disabled={transform.scale >= 5}>
            <Plus size={17} />
          </button>
        </div>
      ) : null}
      {loadState === 'failed' ? (
        <div className="lightbox-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            onClick={() => {
              setLoadState('loading');
              setRetryKey(Date.now());
            }}
          >
            <RefreshCw size={16} />
            重新加载
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MarkdownContent({ text, onPreviewImage, className = 'message-content' }) {
  const value = String(text || '');

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        urlTransform={markdownUrlTransform}
        components={{
          a({ node, href, children, ...props }) {
            const safeHref = normalizeInlineHref(href);
            if (!safeHref) {
              return <span {...props}>{children}</span>;
            }
            return (
              <a href={safeHref} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
              </a>
            );
          },
          img({ node, src, alt }) {
            if (!src) {
              return null;
            }
            return <GeneratedImage part={{ type: 'image', url: src, alt: alt || '图片' }} onPreviewImage={onPreviewImage} />;
          },
          table({ node, children, ...props }) {
            return (
              <div className="markdown-table-wrap">
                <table {...props}>{children}</table>
              </div>
            );
          },
          pre({ node, children }) {
            return <>{children}</>;
          },
          code({ node, className, children, ...props }) {
            const language = String(className || '').match(/language-([\w-]+)/)?.[1] || '';
            const isBlock = Boolean(language) || node?.position?.start?.line !== node?.position?.end?.line;
            if (!isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock language={language || 'text'} code={String(children).replace(/\n$/, '')} />;
          }
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function MessageContent({ content, onPreviewImage }) {
  return <MarkdownContent text={content} onPreviewImage={onPreviewImage} />;
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  async function handleCopy() {
    const ok = await copyTextToClipboard(code);
    if (!ok) {
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-head">
        <span>{language}</span>
        <button type="button" onClick={handleCopy} aria-label="复制代码">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}

function normalizeInlineHref(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw) || raw.startsWith('/') || raw.startsWith('#')) {
    return raw;
  }
  return `https://${raw}`;
}

function markdownUrlTransform(url, key) {
  const raw = String(url || '').trim();
  if (key === 'src' && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
    return raw;
  }
  if (key === 'src' && isLocalImageSource(raw)) {
    return raw;
  }
  return defaultUrlTransform(raw);
}

function renderInlineText(text, keyPrefix) {
  const value = String(text || '');
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|\[([^\]]+)\]\(((?:https?:\/\/|www\.|mailto:|\/)[^\s)]*)\)|((?:https?:\/\/|www\.)[^\s<>()]+)/gi;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let partIndex = 0;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex, match.index)}</span>);
    }

    if (match[2]) {
      nodes.push(<code key={`${keyPrefix}-code-${partIndex++}`}>{match[2]}</code>);
    } else if (match[4] || match[6]) {
      nodes.push(<strong key={`${keyPrefix}-strong-${partIndex++}`}>{match[4] || match[6]}</strong>);
    } else if (match[7] && match[8]) {
      const href = normalizeInlineHref(match[8]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[7]}
        </a>
      );
    } else if (match[9]) {
      const href = normalizeInlineHref(match[9]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[9]}
        </a>
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < value.length) {
    nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex)}</span>);
  }

  return nodes.length ? nodes : [<span key={`${keyPrefix}-text-0`}>{value}</span>];
}

function renderInlineWithBreaks(text, keyPrefix) {
  return String(text || '')
    .split('\n')
    .flatMap((line, index, lines) => {
      const nodes = renderInlineText(line, `${keyPrefix}-line-${index}`);
      if (index < lines.length - 1) {
        nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
      }
      return nodes;
    });
}

function markdownImageFromLine(line) {
  const match = String(line || '').trim().match(/^!\[([^\]]*)\]\((?:<([^>]*)>|([^)]*?))\)$/);
  if (!match) {
    return null;
  }
  const url = String(match[2] || match[3] || '').trim();
  if (!url) {
    return null;
  }
  return { type: 'image', alt: match[1] || '图片', url };
}

function legacyAttachmentImageFromLine(line) {
  const match = String(line || '').trim().match(/^[-*]\s*图片[:：]\s*(.*?)\s*\((.+)\)\s*$/);
  if (!match) {
    return null;
  }
  const url = String(match[2] || '').trim();
  if (!isLocalImageSource(url) && !/\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(url)) {
    return null;
  }
  return { type: 'image', alt: match[1] || '图片', url };
}

function markdownImageDestination(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/[\s<>()]/.test(raw)) {
    return `<${raw.replace(/>/g, '%3E')}>`;
  }
  return raw;
}

function markdownImageAlt(value) {
  return String(value || '图片').replace(/[\[\]\n\r]/g, '').trim() || '图片';
}

function contentWithAttachmentPreviews(content, attachments = []) {
  const imageLines = (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment?.kind === 'image' && attachment.path)
    .map((attachment) => `![${markdownImageAlt(attachment.name)}](${markdownImageDestination(attachment.path)})`)
    .filter(Boolean);
  return [content, imageLines.join('\n')].filter(Boolean).join('\n\n');
}

function splitMessageImages(content) {
  const textLines = [];
  const images = [];
  const seenImages = new Set();
  for (const line of String(content || '').replace(/\r\n?/g, '\n').split('\n')) {
    const image = markdownImageFromLine(line) || legacyAttachmentImageFromLine(line);
    if (image) {
      const key = image.url || line;
      if (!seenImages.has(key)) {
        seenImages.add(key);
        images.push(image);
      }
    } else {
      textLines.push(line);
    }
  }
  return {
    text: textLines.join('\n').replace(/\n*附件路径[:：]\s*$/g, '').replace(/\n{3,}/g, '\n\n').trim(),
    images
  };
}

function isListLine(line) {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function isBlockStarter(line, nextLine) {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    isListLine(line) ||
    Boolean(markdownImageFromLine(line)) ||
    (line.includes('|') && isTableSeparator(nextLine || ''))
  );
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
}

function splitTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderMarkdownBlocks(content, onPreviewImage) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([^\s`]*)?.*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(
        <pre key={`code-${blocks.length}`}>
          <code className={fence[1] ? `language-${fence[1]}` : undefined}>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const image = markdownImageFromLine(line);
    if (image) {
      blocks.push(<GeneratedImage key={`image-${blocks.length}-${image.url}`} part={image} onPreviewImage={onPreviewImage} />);
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const HeadingTag = `h${level}`;
      blocks.push(<HeadingTag key={`heading-${blocks.length}`}>{renderInlineWithBreaks(heading[2], `heading-${blocks.length}`)}</HeadingTag>);
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      const headers = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${blocks.length}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={`head-${cellIndex}`}>{renderInlineWithBreaks(cell, `table-${blocks.length}-head-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${rowIndex}-${cellIndex}`}>
                      {renderInlineWithBreaks(row[cellIndex] || '', `table-${blocks.length}-cell-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{renderInlineWithBreaks(quoteLines.join('\n'), `quote-${blocks.length}`)}</blockquote>);
      continue;
    }

    if (isListLine(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const ListTag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length && isListLine(lines[index]) && /^\s*\d+[.)]\s+/.test(lines[index]) === ordered) {
        items.push(lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, ''));
        index += 1;
      }
      blocks.push(
        <ListTag key={`list-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{renderInlineWithBreaks(item, `list-${blocks.length}-item-${itemIndex}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStarter(lines[index], lines[index + 1])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`paragraph-${blocks.length}`}>{renderInlineWithBreaks(paragraph.join('\n'), `paragraph-${blocks.length}`)}</p>);
  }

  return blocks.length ? blocks : null;
}

function ChatMessage({ message, now, onPreviewImage, onDeleteMessage }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  if (message.role === 'activity') {
    return <ActivityMessage message={message} now={now} />;
  }
  const isUser = message.role === 'user';
  const canAct = message.role === 'user' || message.role === 'assistant';
  const userMedia = isUser ? splitMessageImages(message.content) : { text: message.content, images: [] };
  const visibleContent = isUser ? userMedia.text : message.content;

  async function handleCopy() {
    const copiedText = await copyTextToClipboard(message.content);
    if (!copiedText) {
      window.alert('复制失败');
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`message-row ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="message-stack">
        {isUser ? <UserImageStrip images={userMedia.images} onPreviewImage={onPreviewImage} /> : null}
        {visibleContent ? (
          <div className="message-bubble">
            <MessageContent content={visibleContent} onPreviewImage={onPreviewImage} />
            {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
          </div>
        ) : null}
        {canAct ? (
          <div className="message-actions" aria-label="消息操作">
            <button type="button" className="message-action" onClick={handleCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button type="button" className="message-action is-delete" onClick={() => onDeleteMessage?.(message)}>
              <Trash2 size={13} />
              <span>删除</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChatPane({ messages, selectedSession, running, now, onPreviewImage, onDeleteMessage }) {
  const paneRef = useRef(null);
  const contentRef = useRef(null);
  const bottomPinnedRef = useRef(true);
  const pendingInitialScrollSessionRef = useRef(null);
  const [showScrollLatest, setShowScrollLatest] = useState(false);
  const hasMessages = messages.length > 0;
  const sessionId = selectedSession?.id || '';

  const scrollToBottom = useCallback((behavior = 'auto') => {
    const pane = paneRef.current;
    if (!pane) {
      return;
    }
    pane.scrollTo({ top: pane.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) {
      return undefined;
    }

    function updatePinnedState() {
      const pinned = isNearChatBottom(pane);
      bottomPinnedRef.current = pinned;
      setShowScrollLatest(!pinned);
    }

    updatePinnedState();
    pane.addEventListener('scroll', updatePinnedState, { passive: true });
    return () => pane.removeEventListener('scroll', updatePinnedState);
  }, [hasMessages]);

  useEffect(() => {
    const force = Boolean(hasMessages && sessionId && pendingInitialScrollSessionRef.current === sessionId);
    if (!shouldFollowChatOutput({ pinnedToBottom: bottomPinnedRef.current, running, force })) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      scrollToBottom('auto');
      setShowScrollLatest(false);
      if (force) {
        pendingInitialScrollSessionRef.current = null;
        bottomPinnedRef.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, running, scrollToBottom, hasMessages, sessionId]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      if (shouldFollowChatOutput({ pinnedToBottom: bottomPinnedRef.current, running })) {
        scrollToBottom('auto');
      }
    });
    observer.observe(contentRef.current || pane);
    return () => observer.disconnect();
  }, [running, scrollToBottom]);

  useEffect(() => {
    pendingInitialScrollSessionRef.current = selectedSession?.id || null;
    bottomPinnedRef.current = true;
    setShowScrollLatest(false);
    const frame = requestAnimationFrame(() => scrollToBottom('auto'));
    return () => cancelAnimationFrame(frame);
  }, [selectedSession?.id, scrollToBottom]);

  if (!messages.length) {
    return (
      <section className="chat-pane empty-chat">
        <div className="empty-orbit">
          <ShieldCheck size={30} />
        </div>
        <h2>{selectedSession ? selectedSession.title : '新对话'}</h2>
        <p>问 Codex 任何事。</p>
      </section>
    );
  }

  return (
    <section className="chat-pane" ref={paneRef}>
      <div className="chat-content" ref={contentRef}>
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            now={now}
            onPreviewImage={onPreviewImage}
            onDeleteMessage={onDeleteMessage}
          />
        ))}
      </div>
      {showScrollLatest ? (
        <button
          type="button"
          className="scroll-latest-button"
          onClick={() => {
            scrollToBottom('smooth');
            bottomPinnedRef.current = true;
            setShowScrollLatest(false);
          }}
          aria-label="回到最新消息"
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
    </section>
  );
}

function VoiceDialogPanel({
  open,
  state,
  error,
  transcript,
  assistantText,
  handoffDraft,
  onHandoffDraftChange,
  onHandoffSubmit,
  onHandoffContinue,
  onHandoffCancel,
  onStart,
  onStop,
  onClose
}) {
  if (!open) {
    return null;
  }

  const listening = state === 'listening';
  const confirmingHandoff = state === 'handoff';
  const busy = ['transcribing', 'sending', 'waiting', 'speaking', 'summarizing'].includes(state);
  const statusIcon = state === 'speaking'
    ? <Volume2 size={28} />
    : busy
      ? <Loader2 className="spin" size={28} />
      : <Mic size={28} />;

  return (
    <div className="voice-dialog-backdrop">
      <section className="voice-dialog-panel" role="dialog" aria-modal="true" aria-label="语音对话">
        <div className="voice-dialog-header">
          <span>
            <Headphones size={17} />
            语音对话
          </span>
          <button type="button" onClick={onClose} aria-label="关闭语音对话">
            <X size={18} />
          </button>
        </div>
        <div className={`voice-dialog-orb is-${state}`}>
          {statusIcon}
        </div>
        <div className={`voice-dialog-status ${error ? 'is-error' : ''}`}>
          {error || voiceDialogStatusLabel(state)}
        </div>
        {transcript ? <p className="voice-dialog-line is-user">{transcript}</p> : null}
        {assistantText ? <p className="voice-dialog-line is-assistant">{assistantText}</p> : null}
        {confirmingHandoff ? (
          <div className="voice-dialog-handoff">
            <textarea
              value={handoffDraft}
              onChange={(event) => onHandoffDraftChange(event.target.value)}
              rows={8}
              aria-label="交给 Codex 的任务"
            />
            <div className="voice-dialog-actions voice-dialog-handoff-actions">
              <button type="button" className="voice-dialog-secondary" onClick={onHandoffContinue}>
                继续补充
              </button>
              <button type="button" className="voice-dialog-secondary" onClick={onHandoffCancel}>
                取消
              </button>
              <button
                type="button"
                className="voice-dialog-primary"
                onClick={onHandoffSubmit}
                disabled={!String(handoffDraft || '').trim()}
              >
                交给 Codex
              </button>
            </div>
          </div>
        ) : (
          <div className="voice-dialog-actions">
          <button
            type="button"
            className={`voice-dialog-primary ${listening ? 'is-listening' : ''}`}
            onClick={listening ? onStop : onStart}
            disabled={busy}
          >
            {listening ? '停止' : '开始'}
          </button>
          <button type="button" className="voice-dialog-secondary" onClick={onClose}>
            结束
          </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ContextStatusDetails({ contextStatus }) {
  const context = normalizeContextStatus(contextStatus);
  const usedPercent = numberOrNull(context.percent);
  const remainingPercent = usedPercent === null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const inputTokens = context.inputTokens;
  const contextWindow = context.contextWindow;
  const compact = context.autoCompact || {};
  const compactText = compact.detected
    ? 'Codex 已自动压缩背景信息'
    : 'Codex 自动压缩其背景信息';

  return (
    <>
      <div className="context-popover-title">背景信息窗口：</div>
      <div>
        {usedPercent !== null && remainingPercent !== null
          ? `${usedPercent}% 已用（剩余 ${remainingPercent}%）`
          : '正在同步背景信息窗口'}
      </div>
      <div>
        已用 {formatTokenCount(inputTokens)} 标记，共 {formatTokenCount(contextWindow)}
      </div>
      <div>{compactText}</div>
    </>
  );
}

function ContextStatusButton({ contextStatus, open, onToggle }) {
  const context = normalizeContextStatus(contextStatus);
  const usedPercent = numberOrNull(context.percent);
  const inputTokens = context.inputTokens;
  const contextWindow = context.contextWindow;
  const compact = context.autoCompact || {};
  const hasWindow = Boolean(inputTokens && contextWindow);

  return (
    <div className="context-status-wrap">
      <button
        type="button"
        className={`context-status-button ${compact.detected ? 'is-compacted' : ''} ${hasWindow ? 'has-window' : ''}`}
        onClick={onToggle}
        aria-label="查看背景信息窗口"
        aria-expanded={open}
      >
        <span className="context-status-dot" aria-hidden="true" />
        <span>{usedPercent !== null ? `${Math.round(usedPercent)}%` : '--'}</span>
      </button>
    </div>
  );
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) {
    return null;
  }
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-item is-${toast.level || 'info'}`}>
          <span className="toast-dot" />
          <span>
            <strong>{toast.title}</strong>
            {toast.body ? <small>{toast.body}</small> : null}
          </span>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label="关闭提醒">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ConnectionRecoveryCard({ state, onRetry, onSync, onPair, onStatus }) {
  if (!state) {
    return null;
  }

  function runAction(action) {
    if (action === 'pair') {
      onPair?.();
    } else if (action === 'sync') {
      onSync?.();
    } else if (action === 'status') {
      onStatus?.();
    } else {
      onRetry?.();
    }
  }

  return (
    <section className={`connection-recovery-card is-${state.state}`} aria-label="连接恢复">
      <span className="connection-recovery-dot" />
      <span className="connection-recovery-main">
        <strong>{state.title}</strong>
        <small>{state.detail}</small>
      </span>
      <button type="button" onClick={() => runAction(state.primaryAction)}>
        {state.primaryLabel}
      </button>
      {state.secondaryAction ? (
        <button type="button" onClick={() => runAction(state.secondaryAction)}>
          {state.secondaryLabel}
        </button>
      ) : null}
    </section>
  );
}

function Composer({
  input,
  setInput,
  selectedProject,
  selectedSession,
  onSubmit,
  running,
  onAbort,
  models,
  selectedModel,
  onSelectModel,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  skills,
  selectedSkillPaths,
  onToggleSkill,
  onSelectSkill,
  onClearSkills,
  permissionMode,
  onSelectPermission,
  attachments,
  onUploadFiles,
  onRemoveAttachment,
  fileMentions,
  onAddFileMention,
  onRemoveFileMention,
  uploading,
  contextStatus,
  runStatus,
  desktopBridge,
  queueDrafts,
  onRestoreQueueDraft,
  onRemoveQueueDraft,
  onSteerQueueDraft
}) {
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [skillFilter, setSkillFilter] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [fileSearch, setFileSearch] = useState({ query: '', loading: false, results: [] });
  const selectedFileMentions = Array.isArray(fileMentions) ? fileMentions : [];
  const hasInput = input.trim().length > 0 || attachments.length > 0 || selectedFileMentions.length > 0;
  const modelList = models?.length ? models : [{ value: selectedModel || 'gpt-5.5', label: selectedModel || 'gpt-5.5' }];
  const selectedModelLabel = modelList.find((model) => model.value === selectedModel)?.label || selectedModel || 'gpt-5.5';
  const skillList = Array.isArray(skills) ? skills : [];
  const selectedSkillSet = new Set(Array.isArray(selectedSkillPaths) ? selectedSkillPaths : []);
  const selectedSkills = skillList.filter((skill) => selectedSkillSet.has(skill.path));
  const composerToken = useMemo(
    () => detectComposerToken(input, cursorPosition || input.length),
    [input, cursorPosition]
  );
  const slashMatches = composerToken?.type === 'slash'
    ? filteredSlashCommands(composerToken.query)
    : [];
  const tokenSkillMatches = composerToken?.type === 'skill'
    ? skillList
      .filter((skill) => {
        const query = composerToken.query.trim().toLowerCase();
        if (!query) {
          return true;
        }
        return [skill.label, skill.name, skill.description, skill.path]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .slice(0, 12)
    : [];
  const sendState = composerSendState({
    running,
    hasInput,
    uploading,
    desktopBridge,
    steerable: runStatus?.steerable !== false,
    sessionIsDraft: isDraftSession(selectedSession)
  });
  const stopMode = sendState.mode === 'abort';
  const runningInputMode = running && hasInput;
  const sendLabel = sendState.label;
  const filteredSkills = skillList.filter((skill) => {
    const query = skillFilter.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return [skill.label, skill.name, skill.description, skill.path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  useEffect(() => {
    if (composerToken?.type !== 'file' || !selectedProject?.id) {
      setFileSearch({ query: '', loading: false, results: [] });
      return undefined;
    }

    const query = composerToken.query || '';
    let cancelled = false;
    setFileSearch((current) => ({ ...current, query, loading: true }));
    const timer = window.setTimeout(() => {
      apiFetch(`/api/files/search?projectId=${encodeURIComponent(selectedProject.id)}&q=${encodeURIComponent(query)}`)
        .then((result) => {
          if (!cancelled) {
            setFileSearch({ query, loading: false, results: Array.isArray(result.files) ? result.files : [] });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFileSearch({ query, loading: false, results: [] });
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composerToken?.type, composerToken?.query, selectedProject?.id]);

  function updateCursorFromTextarea() {
    const textarea = textareaRef.current;
    setCursorPosition(textarea?.selectionStart ?? input.length);
  }

  function replaceCurrentToken(replacement) {
    if (!composerToken) {
      return;
    }
    const next = replaceComposerToken(input, composerToken, replacement);
    setInput(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const position = Math.min(next.length, composerToken.start + String(replacement || '').length);
      textareaRef.current?.setSelectionRange(position, position);
      setCursorPosition(position);
    });
  }

  function runSlashCommand(command) {
    replaceCurrentToken(command.prompt ? `${command.prompt} ` : '');
    if (command.action === 'open-context') {
      setOpenMenu('context');
    } else {
      setOpenMenu(null);
    }
  }

  function selectTokenSkill(skill) {
    if (skill?.path) {
      onSelectSkill(skill.path);
    }
    replaceCurrentToken('');
    setOpenMenu(null);
  }

  function selectTokenFile(file) {
    if (!file?.path) {
      return;
    }
    onAddFileMention(file);
    replaceCurrentToken(`@${file.relativePath || file.name} `);
    setOpenMenu(null);
  }

  function submit(event) {
    event.preventDefault();
    if (stopMode) {
      onAbort();
      return;
    }
    if (runningInputMode) {
      setOpenMenu((current) => (current === 'send-mode' ? null : 'send-mode'));
      return;
    }
    if (hasInput) {
      onSubmit({ mode: 'start' });
      setOpenMenu(null);
    }
  }

  function toggleMenu(name) {
    setOpenMenu((current) => (current === name ? null : name));
    if (name !== 'skill') {
      setSkillFilter('');
    }
  }

  function handleFiles(event, kind) {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      onUploadFiles(files, kind);
    }
    event.target.value = '';
    setOpenMenu(null);
  }

  const tokenPanelOpen = !openMenu && composerToken && (
    (composerToken.type === 'slash' && slashMatches.length > 0) ||
    (composerToken.type === 'skill') ||
    (composerToken.type === 'file')
  );

  return (
    <form className="composer-wrap" onSubmit={submit}>
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => handleFiles(event, 'image')}
      />
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => handleFiles(event, 'file')}
      />
      {openMenu === 'attach' ? (
        <div className="composer-menu attach-menu">
          <button type="button" onClick={() => imageInputRef.current?.click()}>
            <Image size={17} />
            相册
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            <FileText size={17} />
            文件
          </button>
        </div>
      ) : null}
      {openMenu === 'permission' ? (
        <div className="composer-menu permission-menu">
          {PERMISSION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${permissionMode === option.value ? 'is-selected' : ''} ${option.danger ? 'is-danger' : ''}`}
              onClick={() => {
                onSelectPermission(option.value);
                setOpenMenu(null);
              }}
            >
              {permissionMode === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'skill' ? (
        <div className="composer-menu skill-menu">
          <div className="skill-search-wrap">
            <Search size={14} />
            <input
              type="search"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              placeholder="搜索 skill"
              aria-label="搜索 skill"
            />
          </div>
          {selectedSkills.length ? (
            <button type="button" className="skill-clear-button" onClick={onClearSkills}>
              <span className="menu-spacer" />
              <span>不指定 skill</span>
            </button>
          ) : null}
          {filteredSkills.length ? (
            filteredSkills.map((skill) => {
              const selected = selectedSkillSet.has(skill.path);
              return (
                <button
                  key={skill.path}
                  type="button"
                  className={`skill-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => onToggleSkill(skill.path)}
                >
                  {selected ? <Check size={16} /> : <span className="menu-spacer" />}
                  <span>
                    <strong>{skill.label || skill.name}</strong>
                    {skill.description ? <small>{skill.description}</small> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="menu-empty">{skillList.length ? '没有匹配的 skill' : 'skill 列表还没加载'}</div>
          )}
        </div>
      ) : null}
      {openMenu === 'model' ? (
        <div className="composer-menu model-menu">
          <div className="menu-section-label">模型</div>
          {modelList.map((model) => (
            <button
              key={model.value}
              type="button"
              className={selectedModel === model.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectModel(model.value);
                setOpenMenu(null);
              }}
            >
              {selectedModel === model.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{model.label}</span>
            </button>
          ))}
          <div className="menu-divider" />
          <div className="menu-section-label">智能</div>
          {REASONING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={selectedReasoningEffort === option.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectReasoningEffort(option.value);
                setOpenMenu(null);
              }}
            >
              {selectedReasoningEffort === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'context' ? (
        <div className="context-popover" role="status">
          <ContextStatusDetails contextStatus={contextStatus} />
        </div>
      ) : null}
      {tokenPanelOpen ? (
        <div className="composer-menu shortcut-menu" role="listbox">
          {composerToken.type === 'slash' ? (
            slashMatches.map((command) => (
              <button key={command.id} type="button" onClick={() => runSlashCommand(command)}>
                <Terminal size={16} />
                <span>
                  <strong>{command.title}</strong>
                  <small>{command.aliases.join(' ')}</small>
                </span>
              </button>
            ))
          ) : null}
          {composerToken.type === 'skill' ? (
            tokenSkillMatches.length ? tokenSkillMatches.map((skill) => (
              <button key={skill.path} type="button" onClick={() => selectTokenSkill(skill)}>
                {selectedSkillSet.has(skill.path) ? <Check size={16} /> : <Bot size={16} />}
                <span>
                  <strong>{skill.label || skill.name}</strong>
                  {skill.description ? <small>{skill.description}</small> : null}
                </span>
              </button>
            )) : <div className="menu-empty">{skillList.length ? '没有匹配的 skill' : 'skill 列表还没加载'}</div>
          ) : null}
          {composerToken.type === 'file' ? (
            fileSearch.loading ? (
              <div className="menu-empty"><Loader2 className="spin" size={15} /> 正在搜索文件</div>
            ) : fileSearch.results.length ? fileSearch.results.map((file) => (
              <button key={file.path} type="button" onClick={() => selectTokenFile(file)}>
                <FileText size={16} />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.relativePath}</small>
                </span>
              </button>
            )) : <div className="menu-empty">没有匹配的文件</div>
          ) : null}
        </div>
      ) : null}
      {queueDrafts?.length ? (
        <div className="queued-drafts-panel" aria-label="排队消息">
          {queueDrafts.map((draft) => (
            <div key={draft.id} className="queued-draft-row">
              <MessageSquarePlus size={15} />
              <button type="button" className="queued-draft-text" onClick={() => onRestoreQueueDraft(draft.id)}>
                <strong>{draft.text || '请查看附件。'}</strong>
                <small>{draft.selectedSkills?.length ? `${draft.selectedSkills.length} skills` : '排队中'}</small>
              </button>
              <div className="queued-draft-actions">
                <button type="button" onClick={() => onSteerQueueDraft(draft.id)} aria-label="立即发送到当前任务">
                  <MessageSquare size={14} />
                </button>
                <button type="button" onClick={() => onRemoveQueueDraft(draft.id)} aria-label="删除排队消息">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {runStatus ? (
        <div className="composer-run-status" role="status" aria-live="polite">
          <span className="composer-run-dot" />
          <span className="composer-run-main">
            <strong>Codex 正在处理</strong>
            <small>{runStatus.label}</small>
          </span>
          {runStatus.duration ? <span className="composer-run-time">{runStatus.duration}</span> : null}
        </div>
      ) : null}
      {!sendState.disabled || sendState.mode !== 'unavailable' ? null : (
        <div className="composer-run-status is-warning" role="status" aria-live="polite">
          <span className="composer-run-dot" />
          <span className="composer-run-main">
            <strong>桌面端 Codex 未连接</strong>
            <small>{desktopBridge?.reason || '打开桌面端 Codex，或配置同源 app-server control socket 后再发送'}</small>
          </span>
        </div>
      )}
      {sendState.mode !== 'create-unavailable' ? null : (
        <div className="composer-run-status is-warning" role="status" aria-live="polite">
          <span className="composer-run-dot" />
          <span className="composer-run-main">
            <strong>只能继续桌面端已有对话</strong>
            <small>{desktopBridge?.capabilities?.createThreadReason || '当前桌面端还没有开放从手机新建同源对话的入口'}</small>
          </span>
        </div>
      )}
      {openMenu === 'send-mode' ? (
        <div className="composer-menu send-mode-menu">
          <button
            type="button"
            disabled={!sendState.canSteer}
            onClick={() => {
              if (!sendState.canSteer) {
                return;
              }
              onSubmit({ mode: 'steer' });
              setOpenMenu(null);
            }}
          >
            <MessageSquare size={16} />
            <span>
              <strong>发送到当前任务</strong>
              <small>{sendState.canSteer ? '直接补充给桌面端正在执行的任务' : '当前任务暂时不能接收补充消息'}</small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              onSubmit({ mode: 'queue' });
              setOpenMenu(null);
            }}
          >
            <MessageSquarePlus size={16} />
            <span>
              <strong>加入队列</strong>
              <small>当前任务结束后自动发送</small>
            </span>
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              onSubmit({ mode: 'interrupt' });
              setOpenMenu(null);
            }}
          >
            <Square size={15} />
            <span>
              <strong>中止并发送</strong>
              <small>停下当前任务，用这条消息重新引导</small>
            </span>
          </button>
        </div>
      ) : null}
      <div className="composer">
        {attachments.length || selectedFileMentions.length ? (
          <div className="attachment-tray">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="attachment-chip">
                <Paperclip size={14} />
                <span>{attachment.name}</span>
                <small>{formatBytes(attachment.size)}</small>
                <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除附件">
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
            {selectedFileMentions.map((file) => (
              <span key={file.path} className="attachment-chip file-mention-chip">
                <FileText size={14} />
                <span>{file.relativePath || file.name}</span>
                <button type="button" onClick={() => onRemoveFileMention(file.path)} aria-label="移除文件引用">
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setCursorPosition(event.target.selectionStart ?? event.target.value.length);
          }}
          onClick={updateCursorFromTextarea}
          onKeyUp={updateCursorFromTextarea}
          onFocus={() => setOpenMenu(null)}
          placeholder="给 Codex 发送消息"
        />
        <div className="composer-controls">
          <div className="control-left">
            <button type="button" className="ghost-icon" aria-label="添加" onClick={() => toggleMenu('attach')} disabled={uploading}>
              <Plus size={21} />
            </button>
            <button type="button" className="permission-pill" onClick={() => toggleMenu('permission')}>
              {permissionLabel(permissionMode)}
              <ChevronDown size={15} />
            </button>
            <button type="button" className="skill-select" onClick={() => toggleMenu('skill')}>
              <Bot size={14} />
              <span>{selectedSkillSummary(selectedSkills)}</span>
              <ChevronDown size={15} />
            </button>
          </div>
          <div className="control-right">
            <ContextStatusButton
              contextStatus={contextStatus}
              open={openMenu === 'context'}
              onToggle={() => toggleMenu('context')}
            />
            <button type="button" className="model-select" onClick={() => toggleMenu('model')}>
              {shortModelName(selectedModelLabel)} {reasoningLabel(selectedReasoningEffort)}
              <ChevronDown size={15} />
            </button>
            <button
              type="submit"
              className={`send-button ${stopMode ? 'is-running' : ''} ${runningInputMode ? 'is-queueing' : ''}`}
              disabled={sendState.disabled}
              aria-label={sendLabel}
              title={sendLabel}
            >
              {stopMode ? <Square size={16} /> : uploading ? <Loader2 className="spin" size={16} /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

export default function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [contextStatus, setContextStatus] = useState(() => normalizeContextStatus(DEFAULT_STATUS.context));
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activityClockNow, setActivityClockNow] = useState(() => Date.now());
  const [completedSessionIds, setCompletedSessionIds] = useState({});
  const [previewImage, setPreviewImage] = useState(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsError, setDocsError] = useState('');
  const [gitPanel, setGitPanel] = useState({ open: false, action: 'commit' });
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [fileMentions, setFileMentions] = useState([]);
  const [queueDrafts, setQueueDrafts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [notificationPermission, setNotificationPermission] = useState(() => browserNotificationPermission());
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => notificationPreferenceEnabled());
  const [uploading, setUploading] = useState(false);
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_STATUS.model);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(() => {
    const defaultVersion = localStorage.getItem('codexmobile.reasoningDefaultVersion');
    if (defaultVersion !== REASONING_DEFAULT_VERSION) {
      localStorage.setItem('codexmobile.reasoningDefaultVersion', REASONING_DEFAULT_VERSION);
      localStorage.setItem('codexmobile.reasoningEffort', DEFAULT_REASONING_EFFORT);
      return DEFAULT_REASONING_EFFORT;
    }
    return localStorage.getItem('codexmobile.reasoningEffort') || DEFAULT_REASONING_EFFORT;
  });
  const [selectedSkillPaths, setSelectedSkillPaths] = useState(() =>
    safeStoredJsonArray(SELECTED_SKILLS_KEY).filter((item) => typeof item === 'string' && item.trim())
  );
  const [runningById, setRunningById] = useState({});
  const [threadRuntimeById, setThreadRuntimeById] = useState({});
  const [theme, setTheme] = useState(() =>
    localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  );
  const [syncing, setSyncing] = useState(false);
  const [connectionState, setConnectionState] = useState(() => (getToken() ? 'connecting' : 'disconnected'));
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const messagesRef = useRef([]);
  const autoTitleSyncRef = useRef(new Set());
  const runningByIdRef = useRef({});
  const activePollsRef = useRef(new Set());
  const turnRefreshTimersRef = useRef(new Map());
  const sessionLivePollRef = useRef(false);
  const desktopIpcPendingRunsRef = useRef(new Map());
  const voiceDialogRecorderRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const voiceDialogChunksRef = useRef([]);
  const voiceDialogStreamRef = useRef(null);
  const voiceDialogTimerRef = useRef(null);
  const voiceDialogSilenceFrameRef = useRef(null);
  const voiceDialogAudioContextRef = useRef(null);
  const voiceDialogAudioSourceRef = useRef(null);
  const voiceDialogSpeechStartedRef = useRef(false);
  const voiceDialogLastSoundAtRef = useRef(0);
  const voiceDialogAudioRef = useRef(null);
  const voiceDialogAudioUnlockedRef = useRef(false);
  const voiceDialogAudioUrlRef = useRef('');
  const voiceDialogAwaitingTurnRef = useRef(null);
  const voiceDialogLastSpokenRef = useRef('');
  const voiceDialogAutoListenRef = useRef(false);
  const voiceDialogOpenRef = useRef(false);
  const voiceDialogStateRef = useRef('idle');
  const voiceDialogRealtimeRef = useRef(false);
  const voiceRealtimeSocketRef = useRef(null);
  const voiceRealtimeStreamRef = useRef(null);
  const voiceRealtimeAudioContextRef = useRef(null);
  const voiceRealtimeAudioSourceRef = useRef(null);
  const voiceRealtimeProcessorRef = useRef(null);
  const voiceRealtimePlaybackContextRef = useRef(null);
  const voiceRealtimePlaybackSourcesRef = useRef(new Set());
  const voiceRealtimePlayheadRef = useRef(0);
  const voiceRealtimeAssistantTextRef = useRef('');
  const voiceRealtimeSpeechStartedRef = useRef(false);
  const voiceRealtimeTurnStartedAtRef = useRef(0);
  const voiceRealtimeLastSoundAtRef = useRef(0);
  const voiceRealtimeAwaitingResponseRef = useRef(false);
  const voiceRealtimeBargeInStartedAtRef = useRef(0);
  const voiceRealtimeSuppressAssistantAudioRef = useRef(false);
  const voiceDialogIdeaBufferRef = useRef([]);
  const voiceDialogHandoffDraftRef = useRef('');
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [voiceDialogState, setVoiceDialogState] = useState('idle');
  const [voiceDialogError, setVoiceDialogError] = useState('');
  const [voiceDialogTranscript, setVoiceDialogTranscript] = useState('');
  const [voiceDialogAssistantText, setVoiceDialogAssistantText] = useState('');
  const [voiceDialogHandoffDraft, setVoiceDialogHandoffDraft] = useState('');

  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const updateViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const height = Math.round(viewport?.height || window.innerHeight || 0);
        const width = Math.round(viewport?.width || window.innerWidth || 0);
        const layoutHeight = Math.round(document.documentElement.clientHeight || window.innerHeight || 0);
        const keyboardOpen = height > 0 && layoutHeight > 0 && layoutHeight - height > 120;
        if (height > 0) {
          root.style.setProperty('--app-height', `${height}px`);
        }
        if (width > 0) {
          root.style.setProperty('--app-width', `${width}px`);
        }
        root.dataset.keyboard = keyboardOpen ? 'open' : 'closed';
        if (window.scrollX || window.scrollY) {
          window.scrollTo(0, 0);
        }
      });
    };

    updateViewport();
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);

    return () => {
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-width');
      delete root.dataset.keyboard;
    };
  }, []);

  const running = hasRunningKey(runningById, selectedRunKeys(selectedSession));
  const selectedRuntime = selectedRunKeys(selectedSession)
    .map((key) => threadRuntimeById[key])
    .find(Boolean) || null;
  const hasRunningActivity = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === 'activity' &&
          (message.status === 'running' || message.status === 'queued')
      ),
    [messages]
  );
  const composerRunStatus = useMemo(
    () => buildComposerRunStatus(messages, running, activityClockNow),
    [messages, running, activityClockNow]
  );

  useEffect(() => {
    loadQueueDrafts(selectedSession).catch(() => null);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!running && !hasRunningActivity) {
      return undefined;
    }
    setActivityClockNow(Date.now());
    const timer = window.setInterval(() => setActivityClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, hasRunningActivity]);

  function setVoiceDialogMode(next) {
    voiceDialogStateRef.current = next;
    setVoiceDialogState(next);
  }

  function setVoiceDialogHandoffDraftValue(next) {
    const value = String(next || '');
    voiceDialogHandoffDraftRef.current = value;
    setVoiceDialogHandoffDraft(value);
  }

  function clearVoiceDialogTimer() {
    if (voiceDialogTimerRef.current) {
      window.clearTimeout(voiceDialogTimerRef.current);
      voiceDialogTimerRef.current = null;
    }
  }

  function clearVoiceDialogSilenceDetection() {
    if (voiceDialogSilenceFrameRef.current) {
      window.cancelAnimationFrame(voiceDialogSilenceFrameRef.current);
      voiceDialogSilenceFrameRef.current = null;
    }
    voiceDialogAudioSourceRef.current?.disconnect?.();
    voiceDialogAudioSourceRef.current = null;
    const context = voiceDialogAudioContextRef.current;
    voiceDialogAudioContextRef.current = null;
    if (context && context.state !== 'closed') {
      const closePromise = context.close?.();
      closePromise?.catch?.(() => null);
    }
    voiceDialogSpeechStartedRef.current = false;
    voiceDialogLastSoundAtRef.current = 0;
  }

  function stopVoiceDialogStream() {
    clearVoiceDialogSilenceDetection();
    voiceDialogStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceDialogStreamRef.current = null;
  }

  function setupVoiceDialogSilenceDetection(stream, recorder) {
    clearVoiceDialogSilenceDetection();
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    try {
      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      voiceDialogAudioContextRef.current = context;
      voiceDialogAudioSourceRef.current = source;
      voiceDialogSpeechStartedRef.current = false;

      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      voiceDialogLastSoundAtRef.current = startedAt;

      const tick = (now) => {
        if (!voiceDialogOpenRef.current || recorder.state !== 'recording') {
          return;
        }

        analyser.getByteTimeDomainData(samples);
        let total = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const value = (samples[index] - 128) / 128;
          total += value * value;
        }
        const level = Math.sqrt(total / samples.length);
        if (level >= VOICE_DIALOG_LEVEL_THRESHOLD) {
          voiceDialogSpeechStartedRef.current = true;
          voiceDialogLastSoundAtRef.current = now;
        }

        const heardSpeech = voiceDialogSpeechStartedRef.current;
        const recordingLongEnough = now - startedAt >= VOICE_DIALOG_MIN_RECORDING_MS;
        const silentLongEnough = now - voiceDialogLastSoundAtRef.current >= VOICE_DIALOG_SILENCE_MS;
        if (heardSpeech && recordingLongEnough && silentLongEnough) {
          setVoiceDialogMode('transcribing');
          recorder.stop();
          return;
        }

        voiceDialogSilenceFrameRef.current = window.requestAnimationFrame(tick);
      };

      const resumePromise = context.resume?.();
      resumePromise?.catch?.(() => null);
      voiceDialogSilenceFrameRef.current = window.requestAnimationFrame(tick);
    } catch {
      clearVoiceDialogSilenceDetection();
    }
  }

  function ensureVoiceDialogAudio() {
    if (!voiceDialogAudioRef.current) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      voiceDialogAudioRef.current = audio;
    }
    return voiceDialogAudioRef.current;
  }

  function unlockVoiceDialogAudio() {
    if (voiceDialogAudioUnlockedRef.current) {
      return;
    }
    try {
      const audio = ensureVoiceDialogAudio();
      audio.muted = true;
      audio.src = VOICE_DIALOG_SILENCE_AUDIO;
      const playPromise = audio.play();
      playPromise
        ?.then?.(() => {
          audio.pause();
          audio.muted = false;
          audio.removeAttribute('src');
          audio.load?.();
          voiceDialogAudioUnlockedRef.current = true;
        })
        ?.catch?.(() => {
          audio.muted = false;
        });
    } catch {
      voiceDialogAudioUnlockedRef.current = false;
    }
  }

  function clearVoiceDialogAudio({ release = false } = {}) {
    const audio = voiceDialogAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load?.();
      if (release) {
        voiceDialogAudioRef.current = null;
        voiceDialogAudioUnlockedRef.current = false;
      }
    }
    if (voiceDialogAudioUrlRef.current) {
      URL.revokeObjectURL(voiceDialogAudioUrlRef.current);
      voiceDialogAudioUrlRef.current = '';
    }
    window.speechSynthesis?.cancel?.();
  }

  function stopRealtimePlayback({ release = false } = {}) {
    for (const source of voiceRealtimePlaybackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    voiceRealtimePlaybackSourcesRef.current.clear();
    const context = voiceRealtimePlaybackContextRef.current;
    voiceRealtimePlayheadRef.current = context?.currentTime || 0;
    if (release && context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
      voiceRealtimePlaybackContextRef.current = null;
      voiceRealtimePlayheadRef.current = 0;
    }
  }

  function stopRealtimeVoiceDialog({ keepPanel = false } = {}) {
    const socket = voiceRealtimeSocketRef.current;
    voiceRealtimeSocketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.send(JSON.stringify({ type: 'close' }));
      } catch {
        // Socket may already be closed.
      }
      try {
        socket.close();
      } catch {
        // Socket may already be closed.
      }
    }

    voiceRealtimeProcessorRef.current?.disconnect?.();
    voiceRealtimeProcessorRef.current = null;
    voiceRealtimeAudioSourceRef.current?.disconnect?.();
    voiceRealtimeAudioSourceRef.current = null;
    voiceRealtimeStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceRealtimeStreamRef.current = null;
    const context = voiceRealtimeAudioContextRef.current;
    voiceRealtimeAudioContextRef.current = null;
    if (context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
    }
    voiceRealtimeAssistantTextRef.current = '';
    voiceRealtimeSpeechStartedRef.current = false;
    voiceRealtimeTurnStartedAtRef.current = 0;
    voiceRealtimeLastSoundAtRef.current = 0;
    voiceRealtimeAwaitingResponseRef.current = false;
    voiceRealtimeBargeInStartedAtRef.current = 0;
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    stopRealtimePlayback({ release: true });
    if (!keepPanel) {
      voiceDialogRealtimeRef.current = false;
    }
  }

  function playRealtimeAudioDelta(delta) {
    if (!delta) {
      return;
    }
    const samples = pcm16Base64ToFloat(delta);
    if (!samples.length) {
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }
    let context = voiceRealtimePlaybackContextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContextCtor();
      voiceRealtimePlaybackContextRef.current = context;
      voiceRealtimePlayheadRef.current = context.currentTime;
    }
    context.resume?.().catch?.(() => null);
    const outputSampleRate = Number(status.voiceRealtime?.outputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
    const buffer = context.createBuffer(1, samples.length, outputSampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    voiceRealtimePlaybackSourcesRef.current.add(source);
    source.onended = () => {
      voiceRealtimePlaybackSourcesRef.current.delete(source);
      if (
        voiceDialogOpenRef.current &&
        voiceDialogRealtimeRef.current &&
        voiceRealtimePlaybackSourcesRef.current.size === 0 &&
        voiceDialogStateRef.current === 'speaking'
      ) {
        voiceRealtimeAwaitingResponseRef.current = false;
        setVoiceDialogMode('listening');
      }
    };
    const startAt = Math.max(voiceRealtimePlayheadRef.current, context.currentTime + 0.03);
    source.start(startAt);
    voiceRealtimePlayheadRef.current = startAt + buffer.duration;
  }

  function appendVoiceDialogIdeaTranscript(transcript) {
    const text = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return;
    }
    const buffer = voiceDialogIdeaBufferRef.current;
    if (buffer[buffer.length - 1] === text) {
      return;
    }
    buffer.push(text);
    if (buffer.length > 30) {
      buffer.splice(0, buffer.length - 30);
    }
  }

  function requestVoiceHandoffSummary(triggerText = '') {
    const socket = voiceRealtimeSocketRef.current;
    const transcripts = voiceDialogIdeaBufferRef.current.filter(Boolean);
    if (!transcripts.length) {
      setVoiceDialogErrorBriefly('还没有可整理的语音内容');
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setVoiceDialogErrorBriefly('实时语音连接不可用');
      return;
    }
    stopRealtimePlayback();
    voiceRealtimeSuppressAssistantAudioRef.current = true;
    voiceRealtimeAwaitingResponseRef.current = false;
    voiceRealtimeBargeInStartedAtRef.current = 0;
    voiceRealtimeAssistantTextRef.current = '';
    setVoiceDialogAssistantText('');
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    setVoiceDialogMode('summarizing');
    socket.send(JSON.stringify({
      type: 'voice.handoff.summarize',
      transcripts,
      trigger: triggerText
    }));
  }

  async function startRealtimeMicrophone(socket) {
    if (!window.isSecureContext) {
      throw new Error('请使用 HTTPS 地址');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持录音');
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('当前浏览器不支持实时音频');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const context = new AudioContextCtor();
    await context.resume?.().catch?.(() => null);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(REALTIME_VOICE_BUFFER_SIZE, 1, 1);
    const inputSampleRate = Number(status.voiceRealtime?.inputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
    const useClientVad = Boolean(status.voiceRealtime?.clientTurnDetection);
    const silenceMs = Number(status.voiceRealtime?.clientVadSilenceMs) || VOICE_DIALOG_SILENCE_MS;
    const commitCurrentTurn = () => {
      if (!voiceRealtimeSpeechStartedRef.current || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      voiceRealtimeSpeechStartedRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      voiceRealtimeAwaitingResponseRef.current = true;
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      setVoiceDialogMode('waiting');
      socket.send(JSON.stringify({ type: 'input_audio.commit' }));
    };
    const beginBargeIn = () => {
      voiceRealtimeSuppressAssistantAudioRef.current = true;
      socket.send(JSON.stringify({ type: 'response.cancel' }));
      socket.send(JSON.stringify({ type: 'input_audio.clear' }));
      stopRealtimePlayback();
      voiceRealtimeAwaitingResponseRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      voiceRealtimeAssistantTextRef.current = '';
      setVoiceDialogAssistantText('');
      setVoiceDialogMode('listening');
    };
    processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      if (
        !voiceDialogOpenRef.current ||
        !voiceDialogRealtimeRef.current ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (voiceDialogStateRef.current === 'summarizing' || voiceDialogStateRef.current === 'handoff') {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleAudio(input, context.sampleRate, inputSampleRate);
      if (!useClientVad) {
        socket.send(JSON.stringify({
          type: 'input_audio.append',
          audio: floatToPcm16Base64(downsampled)
        }));
        return;
      }

      const now = performance.now();
      const level = audioLevel(downsampled);
      const hasSound = level >= VOICE_DIALOG_LEVEL_THRESHOLD;
      if (voiceRealtimeAwaitingResponseRef.current) {
        const playbackActive =
          voiceRealtimePlaybackSourcesRef.current.size > 0 ||
          voiceDialogStateRef.current === 'speaking';
        if (playbackActive) {
          const bargeInCandidate = level >= REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD;
          if (!bargeInCandidate) {
            voiceRealtimeBargeInStartedAtRef.current = 0;
            return;
          }
          if (!voiceRealtimeBargeInStartedAtRef.current) {
            voiceRealtimeBargeInStartedAtRef.current = now;
            return;
          }
          if (now - voiceRealtimeBargeInStartedAtRef.current < REALTIME_VOICE_BARGE_IN_SUSTAIN_MS) {
            return;
          }
          beginBargeIn();
        } else if (hasSound) {
          beginBargeIn();
        } else {
          voiceRealtimeBargeInStartedAtRef.current = 0;
          return;
        }
      }

      if (hasSound) {
        if (!voiceRealtimeSpeechStartedRef.current) {
          voiceRealtimeSpeechStartedRef.current = true;
          voiceRealtimeTurnStartedAtRef.current = now;
          setVoiceDialogMode('listening');
        }
        voiceRealtimeLastSoundAtRef.current = now;
      }

      if (!voiceRealtimeSpeechStartedRef.current) {
        return;
      }

      socket.send(JSON.stringify({
        type: 'input_audio.append',
        audio: floatToPcm16Base64(downsampled)
      }));

      const turnLongEnough = now - voiceRealtimeTurnStartedAtRef.current >= REALTIME_VOICE_MIN_TURN_MS;
      const silentLongEnough = now - voiceRealtimeLastSoundAtRef.current >= silenceMs;
      if (turnLongEnough && silentLongEnough) {
        commitCurrentTurn();
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
    voiceRealtimeStreamRef.current = stream;
    voiceRealtimeAudioContextRef.current = context;
    voiceRealtimeAudioSourceRef.current = source;
    voiceRealtimeProcessorRef.current = processor;
  }

  function handleRealtimeVoiceEvent(payload) {
    if (!voiceDialogOpenRef.current || !voiceDialogRealtimeRef.current) {
      return;
    }
    if (payload.type === 'voice.realtime.connecting') {
      setVoiceDialogMode('waiting');
      return;
    }
    if (payload.type === 'voice.realtime.ready') {
      const socket = voiceRealtimeSocketRef.current;
      if (!socket || voiceRealtimeStreamRef.current) {
        setVoiceDialogMode('listening');
        return;
      }
      startRealtimeMicrophone(socket)
        .then(() => {
          setVoiceDialogError('');
          setVoiceDialogMode('listening');
        })
        .catch((error) => {
          setVoiceDialogErrorBriefly(error.message || '实时语音启动失败');
          stopRealtimeVoiceDialog({ keepPanel: true });
        });
      return;
    }
    if (payload.type === 'voice.realtime.cancel_ignored') {
      voiceRealtimeAwaitingResponseRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      setVoiceDialogError('');
      setVoiceDialogMode('listening');
      return;
    }
    if (payload.type === 'voice.handoff.summarizing') {
      stopRealtimePlayback();
      voiceRealtimeSuppressAssistantAudioRef.current = true;
      voiceRealtimeAssistantTextRef.current = '';
      setVoiceDialogAssistantText('');
      setVoiceDialogError('');
      setVoiceDialogMode('summarizing');
      return;
    }
    if (payload.type === 'voice.handoff.summary_delta') {
      return;
    }
    if (payload.type === 'voice.handoff.summary_done') {
      const draft = String(payload.message || payload.rawText || '').trim();
      if (!draft) {
        setVoiceDialogErrorBriefly('没有整理出可交给 Codex 的任务');
        return;
      }
      setVoiceDialogHandoffDraftValue(draft);
      setVoiceDialogAssistantText('');
      setVoiceDialogError(payload.parsed ? '' : '整理结果不是标准 JSON，已作为草稿保留');
      setVoiceDialogMode('handoff');
      return;
    }
    if (payload.type === 'voice.handoff.summary_error') {
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      setVoiceDialogErrorBriefly(payload.error || '语音任务整理失败');
      return;
    }
    if (payload.type === 'response.created') {
      if (voiceDialogStateRef.current === 'summarizing' || voiceDialogStateRef.current === 'handoff') {
        return;
      }
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      voiceRealtimeAwaitingResponseRef.current = true;
      return;
    }
    if (payload.type === 'voice.realtime.error' || payload.type === 'error') {
      if (isBenignRealtimeCancelError(payload)) {
        voiceRealtimeAwaitingResponseRef.current = false;
        voiceRealtimeBargeInStartedAtRef.current = 0;
        setVoiceDialogError('');
        setVoiceDialogMode('listening');
        return;
      }
      const message = payload.error?.message || payload.error || '实时语音连接失败';
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogErrorBriefly(message);
      stopRealtimeVoiceDialog({ keepPanel: true });
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_started') {
      stopRealtimePlayback();
      voiceRealtimeAssistantTextRef.current = '';
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogAssistantText('');
      setVoiceDialogMode('listening');
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_stopped') {
      setVoiceDialogMode('waiting');
      return;
    }
    if (
      payload.type === 'conversation.item.input_audio_transcription.completed' &&
      payload.transcript
    ) {
      const transcript = String(payload.transcript || '').trim();
      setVoiceDialogTranscript(transcript);
      if (isVoiceHandoffCommand(transcript)) {
        requestVoiceHandoffSummary(transcript);
        return;
      }
      appendVoiceDialogIdeaTranscript(transcript);
      return;
    }
    if (
      (payload.type === 'response.audio_transcript.delta' ||
        payload.type === 'response.output_audio_transcript.delta') &&
      payload.delta
    ) {
      if (voiceRealtimeSuppressAssistantAudioRef.current) {
        return;
      }
      voiceRealtimeAssistantTextRef.current += payload.delta;
      setVoiceDialogAssistantText(voiceRealtimeAssistantTextRef.current.trim());
      return;
    }
    if (
      (payload.type === 'response.audio.delta' ||
        payload.type === 'response.output_audio.delta') &&
      payload.delta
    ) {
      if (voiceRealtimeSuppressAssistantAudioRef.current) {
        return;
      }
      voiceRealtimeAwaitingResponseRef.current = true;
      setVoiceDialogMode('speaking');
      playRealtimeAudioDelta(payload.delta);
      return;
    }
    if (
      payload.type === 'response.done' &&
      voiceDialogStateRef.current !== 'summarizing' &&
      voiceDialogStateRef.current !== 'handoff' &&
      voiceRealtimePlaybackSourcesRef.current.size === 0
    ) {
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogMode('listening');
    }
  }

  function startRealtimeVoiceDialog() {
    if (!status.voiceRealtime?.configured) {
      setVoiceDialogErrorBriefly('未配置实时语音');
      return;
    }
    if (voiceRealtimeSocketRef.current) {
      return;
    }
    clearVoiceDialogAudio();
    stopRealtimeVoiceDialog({ keepPanel: true });
    voiceDialogRealtimeRef.current = true;
    voiceRealtimeAssistantTextRef.current = '';
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('waiting');

    const socket = new WebSocket(realtimeVoiceWebsocketUrl());
    voiceRealtimeSocketRef.current = socket;
    socket.onopen = () => {
      setVoiceDialogMode('waiting');
    };
    socket.onmessage = (event) => {
      try {
        handleRealtimeVoiceEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed proxy events.
      }
    };
    socket.onerror = () => {
      setVoiceDialogErrorBriefly('实时语音连接失败');
      stopRealtimeVoiceDialog({ keepPanel: true });
    };
    socket.onclose = () => {
      if (voiceDialogOpenRef.current && voiceDialogRealtimeRef.current) {
        stopRealtimeVoiceDialog({ keepPanel: true });
        setVoiceDialogMode('idle');
      }
    };
  }

  function voiceDialogMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) {
      return '';
    }
    return VOICE_MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  function setVoiceDialogErrorBriefly(message) {
    setVoiceDialogError(message);
    setVoiceDialogMode('error');
  }

  async function transcribeVoiceDialogBlob(blob) {
    if (!blob?.size) {
      throw new Error('没有录到声音');
    }
    if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
      throw new Error('录音超过 10MB');
    }

    const formData = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', blob, `voice-dialog.${extension}`);
    const result = await apiFetch('/api/voice/transcribe', {
      method: 'POST',
      body: formData
    });
    const text = String(result.text || '').trim();
    if (!text) {
      throw new Error('没有识别到文字');
    }
    return text;
  }

  function playAudioBlob(blob) {
    return new Promise((resolve, reject) => {
      clearVoiceDialogAudio();
      const url = URL.createObjectURL(blob);
      const audio = ensureVoiceDialogAudio();
      voiceDialogAudioUrlRef.current = url;
      audio.muted = false;
      audio.src = url;
      audio.playsInline = true;
      audio.onended = () => {
        voiceDialogAudioUnlockedRef.current = true;
        resolve();
      };
      audio.onerror = () => reject(new Error('播放失败'));
      audio.load?.();
      audio.play().catch(reject);
    });
  }

  function speakWithBrowser(text) {
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        reject(new Error('当前浏览器不支持朗读'));
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = resolve;
      utterance.onerror = () => reject(new Error('朗读失败'));
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  function scheduleNextVoiceDialogTurn() {
    if (!voiceDialogOpenRef.current || !voiceDialogAutoListenRef.current) {
      setVoiceDialogMode('idle');
      return;
    }
    setVoiceDialogMode('idle');
    window.setTimeout(() => {
      if (voiceDialogOpenRef.current && voiceDialogAutoListenRef.current) {
        startVoiceDialogRecording();
      }
    }, 220);
  }

  async function playVoiceDialogReply(message) {
    const text = spokenReplyText(message?.content);
    if (!text) {
      scheduleNextVoiceDialogTurn();
      return;
    }

    setVoiceDialogAssistantText(text);
    setVoiceDialogError('');
    setVoiceDialogMode('speaking');

    try {
      const blob = await apiBlobFetch('/api/voice/speech', {
        method: 'POST',
        body: { text }
      });
      await playAudioBlob(blob);
    } catch (error) {
      try {
        await speakWithBrowser(text);
      } catch {
        setVoiceDialogError(error.message || '朗读失败');
      }
    } finally {
      clearVoiceDialogAudio();
      scheduleNextVoiceDialogTurn();
    }
  }

  async function startVoiceDialogRecording() {
    if (voiceDialogRealtimeRef.current) {
      startRealtimeVoiceDialog();
      return;
    }
    if (!voiceDialogOpenRef.current) {
      return;
    }
    if (['transcribing', 'sending', 'waiting', 'speaking'].includes(voiceDialogStateRef.current)) {
      return;
    }
    clearVoiceDialogTimer();
    clearVoiceDialogAudio();
    unlockVoiceDialogAudio();
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');

    if (!selectedProjectRef.current && !selectedProject) {
      setVoiceDialogErrorBriefly('请先选择项目');
      return;
    }
    if (!window.isSecureContext) {
      setVoiceDialogErrorBriefly('请使用 HTTPS 地址');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceDialogErrorBriefly('当前浏览器不支持录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = voiceDialogMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceDialogStreamRef.current = stream;
      voiceDialogChunksRef.current = [];
      voiceDialogRecorderRef.current = recorder;
      setupVoiceDialogSilenceDetection(stream, recorder);

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceDialogChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        clearVoiceDialogTimer();
        stopVoiceDialogStream();
        voiceDialogRecorderRef.current = null;
        setVoiceDialogErrorBriefly('录音失败');
      };
      recorder.onstop = async () => {
        clearVoiceDialogTimer();
        stopVoiceDialogStream();
        const recordedType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(voiceDialogChunksRef.current, { type: recordedType });
        voiceDialogChunksRef.current = [];
        voiceDialogRecorderRef.current = null;

        try {
          setVoiceDialogMode('transcribing');
          const transcript = await transcribeVoiceDialogBlob(blob);
          setVoiceDialogTranscript(transcript);
          setVoiceDialogMode('sending');
          const turn = await handleVoiceSubmit(transcript);
          voiceDialogAwaitingTurnRef.current = {
            turnId: turn?.turnId,
            message: transcript,
            startedAt: Date.now()
          };
          setVoiceDialogMode('waiting');
        } catch (error) {
          voiceDialogAwaitingTurnRef.current = null;
          setVoiceDialogErrorBriefly(error.message || '语音对话失败');
        }
      };

      recorder.start();
      setVoiceDialogMode('listening');
      voiceDialogTimerRef.current = window.setTimeout(() => {
        if (voiceDialogRecorderRef.current?.state === 'recording') {
          setVoiceDialogMode('transcribing');
          voiceDialogRecorderRef.current.stop();
        }
      }, VOICE_MAX_RECORDING_MS);
    } catch (error) {
      clearVoiceDialogTimer();
      stopVoiceDialogStream();
      voiceDialogRecorderRef.current = null;
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setVoiceDialogErrorBriefly(denied ? '麦克风权限被拒绝' : '录音启动失败');
    }
  }

  function stopVoiceDialogRecording() {
    if (voiceDialogRealtimeRef.current) {
      stopRealtimeVoiceDialog({ keepPanel: true });
      setVoiceDialogMode('idle');
      return;
    }
    if (voiceDialogRecorderRef.current?.state === 'recording') {
      setVoiceDialogError('');
      setVoiceDialogMode('transcribing');
      voiceDialogRecorderRef.current.stop();
      return;
    }
    clearVoiceDialogTimer();
    stopVoiceDialogStream();
    setVoiceDialogMode('idle');
  }

  function continueVoiceHandoffCollection() {
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    setVoiceDialogAssistantText('');
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    setVoiceDialogMode('listening');
  }

  function cancelVoiceHandoffConfirmation() {
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    setVoiceDialogMode('listening');
  }

  async function submitVoiceHandoffToCodex() {
    const message = voiceDialogHandoffDraftRef.current.trim();
    if (!message) {
      return;
    }
    if (!selectedProjectRef.current && !selectedProject) {
      setVoiceDialogError('请先选择项目');
      setVoiceDialogMode('handoff');
      return;
    }
    try {
      setVoiceDialogError('');
      setVoiceDialogMode('sending');
      await submitCodexMessage({ message });
      voiceDialogIdeaBufferRef.current = [];
      setVoiceDialogHandoffDraftValue('');
      closeVoiceDialog();
    } catch (error) {
      setVoiceDialogError(error.message || '发送给 Codex 失败');
      setVoiceDialogMode('handoff');
    }
  }

  function openVoiceDialog() {
    unlockVoiceDialogAudio();
    voiceDialogOpenRef.current = true;
    voiceDialogRealtimeRef.current = Boolean(status.voiceRealtime?.configured);
    voiceDialogAutoListenRef.current = !voiceDialogRealtimeRef.current;
    voiceDialogAwaitingTurnRef.current = null;
    voiceDialogIdeaBufferRef.current = [];
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogOpen(true);
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('idle');
    window.setTimeout(() => {
      if (voiceDialogOpenRef.current) {
        if (voiceDialogRealtimeRef.current) {
          startRealtimeVoiceDialog();
        } else {
          startVoiceDialogRecording();
        }
      }
    }, 80);
  }

  function closeVoiceDialog() {
    voiceDialogAutoListenRef.current = false;
    voiceDialogOpenRef.current = false;
    voiceDialogAwaitingTurnRef.current = null;
    voiceDialogIdeaBufferRef.current = [];
    setVoiceDialogHandoffDraftValue('');
    stopRealtimeVoiceDialog();
    if (voiceDialogRecorderRef.current?.state === 'recording') {
      voiceDialogRecorderRef.current.onstop = null;
      voiceDialogRecorderRef.current.stop();
    }
    voiceDialogRecorderRef.current = null;
    clearVoiceDialogTimer();
    stopVoiceDialogStream();
    clearVoiceDialogAudio({ release: true });
    setVoiceDialogOpen(false);
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('idle');
  }

  function runtimeKeysForPayload(payload) {
    const keys = new Set(payloadRunKeys(payload));
    const current = selectedSessionRef.current;
    if (current) {
      const sameProject = !payload?.projectId || !current.projectId || payload.projectId === current.projectId;
      const matchesCurrent =
        keys.has(current.id) ||
        keys.has(current.turnId) ||
        (payload?.turnId && current.turnId === payload.turnId) ||
        (current.draft && sameProject);
      if (matchesCurrent) {
        if (current.id) {
          keys.add(current.id);
        }
        if (current.turnId) {
          keys.add(current.turnId);
        }
      }
    }
    return Array.from(keys).filter(Boolean);
  }

  function markRun(payload) {
    const keys = runtimeKeysForPayload(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = {
          status: 'running',
          steerable: payload.steerable !== false,
          updatedAt: payload.timestamp || payload.startedAt || new Date().toISOString()
        };
      }
      return next;
    });
  }

  function clearRun(payload) {
    const keys = runtimeKeysForPayload(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (next[key]?.status === 'running') {
          delete next[key];
        }
      }
      return next;
    });
  }

  function markSessionCompleteNotice(payload) {
    const ids = runtimeKeysForPayload(payload).filter((id) => !isDraftSession(id));
    if (!ids.length) {
      return;
    }
    setCompletedSessionIds((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = true;
      }
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = {
          status: 'completed',
          updatedAt: payload.completedAt || payload.timestamp || new Date().toISOString()
        };
      }
      return next;
    });
  }

  function clearSessionCompleteNotice(sessionId) {
    if (!sessionId) {
      return;
    }
    setCompletedSessionIds((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setThreadRuntimeById((current) => {
      if (current[sessionId]?.status !== 'completed') {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function syncActiveRunsFromStatus(nextStatus) {
    const activeRuns = Array.isArray(nextStatus?.activeRuns) ? nextStatus.activeRuns : [];
    const shouldPreserveLocalRuns =
      activePollsRef.current.size > 0 ||
      turnRefreshTimersRef.current.size > 0;

    if (!activeRuns.length) {
      if (!shouldPreserveLocalRuns) {
        setRunningById(() => {
          runningByIdRef.current = {};
          return {};
        });
        setThreadRuntimeById((current) => {
          const next = { ...current };
          for (const [key, value] of Object.entries(next)) {
            if (value?.status === 'running') {
              delete next[key];
            }
          }
          return next;
        });
      }
      setMessages((current) => {
        if (shouldPreserveLocalRuns) {
          return current;
        }
        return current.filter(
          (message) => !(message.role === 'activity' && (message.status === 'running' || message.status === 'queued'))
        );
      });
      return;
    }

    const nextRunning = {};
    const nextRuntime = {};
    for (const run of activeRuns) {
      for (const key of payloadRunKeys(run)) {
        nextRunning[key] = true;
        nextRuntime[key] = {
          status: 'running',
          steerable: run.steerable !== false,
          updatedAt: run.startedAt || new Date().toISOString()
        };
      }
    }
    setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      runningByIdRef.current = next;
      return next;
    });
    setThreadRuntimeById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRuntime } : nextRuntime;
      return next;
    });
  }

  function payloadMatchesCurrentConversation(payload) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    const keys = payloadRunKeys(payload);
    return keys.includes(current.id) || keys.includes(current.turnId);
  }

  function clearTurnRefreshTimer(turnId) {
    if (!turnId) {
      return;
    }
    const timer = turnRefreshTimersRef.current.get(turnId);
    if (timer) {
      window.clearTimeout(timer);
      turnRefreshTimersRef.current.delete(turnId);
    }
  }

  function rememberDesktopIpcPendingRun(sessionId, pending) {
    if (!sessionId || !pending?.message) {
      return;
    }
    desktopIpcPendingRunsRef.current.set(sessionId, {
      ...pending,
      sessionId,
      startedAt: pending.startedAt || new Date().toISOString()
    });
  }

  function completeDesktopIpcPendingRun(sessionId) {
    const pending = desktopIpcPendingRunsRef.current.get(sessionId);
    if (!pending) {
      return false;
    }
    desktopIpcPendingRunsRef.current.delete(sessionId);
    const completedPayload = {
      sessionId,
      turnId: selectedSessionRef.current?.turnId || pending.clientTurnId || pending.turnId || null,
      completedAt: new Date().toISOString()
    };
    clearRun(completedPayload);
    if (pending.turnId && pending.turnId !== completedPayload.turnId) {
      clearRun({ ...completedPayload, turnId: pending.turnId });
    }
    if (pending.clientTurnId && pending.clientTurnId !== completedPayload.turnId) {
      clearRun({ ...completedPayload, turnId: pending.clientTurnId });
    }
    markSessionCompleteNotice(completedPayload);
    return true;
  }

  async function refreshMessagesForPayload(payload) {
    if (!payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(sessionMessagesApiPath(payload.sessionId));
      if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, payload)) {
        setContextStatus((current) => mergeContextStatus(current, data.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
        setMessages((current) => mergeLoadedMessagesPreservingActivity(current, data.messages, payload));
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function finalizeTurnWithoutAssistant(payload) {
    if (!payload?.turnId) {
      return;
    }
    clearTurnRefreshTimer(payload.turnId);
    setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'completed',
        label: '任务已完成',
        detail: payload.error || payload.detail || ''
      })
    );
    clearRun(payload);
  }

  function markTurnCompleted(payload, detail = '结果同步中') {
    if (!payload?.turnId) {
      return;
    }
    const completedAt = payload.completedAt || payload.timestamp || new Date().toISOString();
    setMessages((current) => {
      if (hasAssistantMessageForTurn(current, payload)) {
        return completeActivityMessagesForTurn(current, { ...payload, completedAt });
      }
      return upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'completed',
        label: '任务已完成',
        detail,
        completedAt
      });
    });
  }

  function scheduleTurnRefresh(payload, attempt = 0) {
    const turnId = payload?.turnId;
    if (!turnId || !payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return;
    }
    clearTurnRefreshTimer(turnId);
    const delays = [300, 800, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000, 30000];
    const delay = delays[attempt];
    if (delay === undefined) {
      finalizeTurnWithoutAssistant(payload);
      return;
    }

    const timer = window.setTimeout(async () => {
      if (!payloadMatchesCurrentConversation(payload)) {
        return;
      }
      const loaded = await refreshMessagesForPayload(payload);
      if (loaded) {
        clearTurnRefreshTimer(turnId);
        clearRun(payload);
        return;
      }
      scheduleTurnRefresh(payload, attempt + 1);
    }, delay);
    turnRefreshTimersRef.current.set(turnId, timer);
  }

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!authenticated || !selectedSession?.id || isDraftSession(selectedSession)) {
      return undefined;
    }

    const sessionId = selectedSession.id;
    let stopped = false;
    async function pollSelectedSession() {
      if (stopped || sessionLivePollRef.current) {
        return;
      }
      const hasSelectedRunning = hasRunningKey(
        runningByIdRef.current || {},
        selectedRunKeys(selectedSessionRef.current || selectedSession)
      );
      const hasExternalThreadRefresh = Boolean(desktopIpcPendingRunsRef.current.get(sessionId));
      if (!shouldPollSelectedSessionMessages({
        hasSelectedRunning,
        desktopBridge: status.desktopBridge,
        hasExternalThreadRefresh
      })) {
        return;
      }
      sessionLivePollRef.current = true;
      try {
        const data = await apiFetch(sessionMessagesApiPath(sessionId));
        if (!stopped && selectedSessionRef.current?.id === sessionId && Array.isArray(data.messages)) {
          const pendingDesktopRun = desktopIpcPendingRunsRef.current.get(sessionId) || null;
          const shouldCompleteDesktopRun =
            hasSelectedRunning &&
            status.desktopBridge?.mode === 'desktop-ipc' &&
            (
              desktopThreadHasAssistantAfterPendingSend(pendingDesktopRun, data.messages) ||
              desktopThreadHasAssistantAfterLocalSend(messagesRef.current, data.messages)
            );
          setContextStatus((current) => mergeContextStatus(current, data.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
          setMessages((current) =>
            messageStreamSignature(current) === messageStreamSignature(data.messages)
              ? current
              : mergeLiveSelectedThreadMessages(current, data.messages)
          );
          if (shouldCompleteDesktopRun) {
            completeDesktopIpcPendingRun(sessionId);
          }
        }
      } catch {
        // Keep the currently rendered conversation if a transient poll fails.
      } finally {
        sessionLivePollRef.current = false;
      }
    }

    const intervalMs = hasRunningActivity || running ? 700 : 1600;
    const timer = window.setInterval(pollSelectedSession, intervalMs);
    pollSelectedSession();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [authenticated, selectedSession?.id, hasRunningActivity, running, status.desktopBridge]);

  useEffect(() => () => closeVoiceDialog(), []);

  useEffect(
    () => () => {
      for (const timer of turnRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      turnRefreshTimersRef.current.clear();
    },
    []
  );

  useEffect(
    () => () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    },
    []
  );

  useEffect(() => {
    const awaiting = voiceDialogAwaitingTurnRef.current;
    if (!voiceDialogOpen || !awaiting?.turnId || voiceDialogStateRef.current !== 'waiting') {
      return;
    }
    if (runningById[awaiting.turnId]) {
      return;
    }

    const reversed = [...messages].reverse();
    let reply = reversed.find(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === awaiting.turnId &&
        String(message.content || '').trim()
    );

    if (!reply) {
      let userIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
          message.role === 'user' &&
          (message.turnId === awaiting.turnId || String(message.content || '').trim() === awaiting.message)
        ) {
          userIndex = index;
          break;
        }
      }
      if (userIndex >= 0) {
        reply = [...messages.slice(userIndex + 1)].reverse().find(
          (message) => message.role === 'assistant' && String(message.content || '').trim()
        );
      }
    }

    const speechText = spokenReplyText(reply?.content);
    if (!reply || !speechText) {
      return;
    }

    const speechKey = `${awaiting.turnId}:${reply.id}:${speechText.length}`;
    if (voiceDialogLastSpokenRef.current === speechKey) {
      return;
    }
    voiceDialogLastSpokenRef.current = speechKey;
    voiceDialogAwaitingTurnRef.current = null;
    playVoiceDialogReply(reply);
  }, [messages, runningById, voiceDialogOpen]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (selectedReasoningEffort) {
      localStorage.setItem('codexmobile.reasoningEffort', selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    localStorage.setItem(SELECTED_SKILLS_KEY, JSON.stringify(selectedSkillPaths));
  }, [selectedSkillPaths]);

  useEffect(() => {
    if (!Array.isArray(status.skills) || !status.skills.length || !selectedSkillPaths.length) {
      return;
    }
    const available = new Set(status.skills.map((skill) => skill.path));
    const next = selectedSkillPaths.filter((item) => available.has(item));
    if (next.length !== selectedSkillPaths.length) {
      setSelectedSkillPaths(next);
    }
  }, [selectedSkillPaths, status.skills]);

  useEffect(() => {
    if (status.model && selectedModel === DEFAULT_STATUS.model) {
      setSelectedModel(status.model);
    }
  }, [selectedModel, status.model]);

  useEffect(() => {
    const saved = localStorage.getItem('codexmobile.reasoningEffort');
    if (!saved && status.reasoningEffort && !selectedReasoningEffort) {
      setSelectedReasoningEffort(status.reasoningEffort);
    }
  }, [selectedReasoningEffort, status.reasoningEffort]);

  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    setStatus(data);
    setAuthenticated(Boolean(data.auth?.authenticated));
    syncActiveRunsFromStatus(data);
    return data;
  }, []);

  const loadSessions = useCallback(async (project, options = true) => {
    const settings =
      typeof options === 'boolean'
        ? { chooseLatest: options, preserveSelection: false }
        : {
          chooseLatest: options?.chooseLatest ?? true,
          preserveSelection: Boolean(options?.preserveSelection)
        };
    if (!project) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setMessages([]);
      setContextStatus(emptyContextStatus());
      return;
    }
    setLoadingProjectId(project.id);
    try {
      const data = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`);
      const apiSessions = data.sessions || [];
      const currentSession = selectedSessionRef.current;
      const preserveCurrent =
        settings.preserveSelection &&
        currentSession?.projectId === project.id &&
        (isDraftSession(currentSession) || apiSessions.some((session) => session.id === currentSession.id));
      const nextSessions =
        preserveCurrent && isDraftSession(currentSession)
          ? [currentSession, ...apiSessions.filter((session) => session.id !== currentSession.id)]
          : apiSessions;
      setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));

      if (preserveCurrent) {
        if (isDraftSession(currentSession)) {
          selectedSessionRef.current = currentSession;
          setSelectedSession(currentSession);
          setMessages([]);
          setContextStatus(emptyContextStatus());
          return;
        }
        const refreshed = nextSessions.find((session) => session.id === currentSession.id);
        if (refreshed) {
          setSelectedSession((current) => (current?.id === refreshed.id ? { ...current, ...refreshed } : current));
          setContextStatus(normalizeContextStatus(refreshed.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
          const messageData = await apiFetch(sessionMessagesApiPath(refreshed.id));
          if (selectedSessionRef.current?.id === refreshed.id) {
            setMessages(messageData.messages || []);
            setContextStatus(
              normalizeContextStatus(messageData.context || refreshed.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context)
            );
          }
          return;
        }
      }

      if (settings.chooseLatest) {
        const next = nextSessions[0] || null;
        selectedSessionRef.current = next;
        setSelectedSession(next);
        if (next) {
          setContextStatus(normalizeContextStatus(next.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
          const messageData = await apiFetch(sessionMessagesApiPath(next.id));
          if (selectedSessionRef.current?.id === next.id) {
            setMessages(messageData.messages || []);
            setContextStatus(normalizeContextStatus(messageData.context || next.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
          }
        } else {
          setMessages([]);
          setContextStatus(emptyContextStatus());
        }
      } else {
        selectedSessionRef.current = null;
        setSelectedSession(null);
        setMessages([]);
        setContextStatus(emptyContextStatus());
      }
    } finally {
      setLoadingProjectId((current) => (current === project.id ? null : current));
    }
  }, []);

  const loadProjects = useCallback(async (options = {}) => {
    const preserveSelection = Boolean(options?.preserveSelection);
    const data = await apiFetch('/api/projects');
    const list = data.projects || [];
    setProjects(list);
    const currentProject = selectedProjectRef.current;
    const preferred =
      (preserveSelection && currentProject
        ? list.find((project) => project.id === currentProject.id)
        : null) ||
      list.find((project) => project.name.toLowerCase() === 'codexmobile') ||
      list.find((project) => project.path.toLowerCase().includes('codexmobile')) ||
      list[0] ||
      null;
    setSelectedProject(preferred);
    if (preferred) {
      setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
    }
    await loadSessions(preferred, {
      chooseLatest: !preserveSelection || !selectedSessionRef.current,
      preserveSelection
    });
  }, [loadSessions]);

  const bootstrap = useCallback(async () => {
    try {
      const currentStatus = await loadStatus();
      if (currentStatus.auth?.authenticated) {
        await loadProjects();
        setSyncing(true);
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            await loadProjects({ preserveSelection: true });
          })
          .catch(() => null)
          .finally(() => setSyncing(false));
      }
    } catch (error) {
      if (String(error.message).includes('Pairing')) {
        clearToken();
        setAuthenticated(false);
      }
    }
  }, [loadProjects, loadStatus]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!authenticated || !getToken()) {
      setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    let reconnectTimer = null;

    const connect = () => {
      setConnectionState('connecting');
      const ws = new WebSocket(websocketUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnectionState('connecting');
      ws.onclose = () => {
        setConnectionState('disconnected');
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 1200);
        }
      };
      ws.onerror = () => setConnectionState('disconnected');
      ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'connected') {
        setStatus(payload.status || DEFAULT_STATUS);
        setConnectionState(payload.status?.connected ? 'connected' : 'disconnected');
        syncActiveRunsFromStatus(payload.status || DEFAULT_STATUS);
        return;
      }
      if (payload.type === 'chat-started') {
        markRun(payload);
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (!selectedSessionRef.current && payload.sessionId) {
          setSelectedSession({ id: payload.sessionId, projectId: payload.projectId, title: '新对话' });
        }
        return;
      }
      if (payload.type === 'thread-started' && payload.sessionId) {
        const projectId = payload.projectId || selectedProjectRef.current?.id || selectedSessionRef.current?.projectId;
        const currentSession = selectedSessionRef.current;
        const nextSession = {
          ...(currentSession || {}),
          id: payload.sessionId,
          projectId,
          title: currentSession?.title || '新对话',
          turnId: payload.turnId || currentSession?.turnId || null,
          updatedAt: new Date().toISOString(),
          draft: false
        };
        markRun(payload);
        setSelectedSession((current) => {
          if (!current) {
            return nextSession;
          }
          const shouldReplace =
            current.id === payload.previousSessionId ||
            current.id === payload.sessionId ||
            current.turnId === payload.turnId ||
            (current.draft && current.projectId === projectId);
          return shouldReplace ? { ...current, ...nextSession } : current;
        });
        setSessionsByProject((current) =>
          upsertSessionInProject(current, projectId, nextSession, payload.previousSessionId)
        );
        setMessages((current) =>
          current.map((message) =>
            message.turnId === payload.turnId || message.sessionId === payload.previousSessionId
              ? { ...message, sessionId: payload.sessionId }
              : message
          )
        );
        return;
      }
      if (payload.type === 'message-deleted') {
        if (payloadMatchesCurrentConversation(payload)) {
          setMessages((current) => current.filter((message) => String(message.id) !== String(payload.messageId)));
        }
        return;
      }
      if (payload.type === 'session-renamed') {
        const sessionId = payload.sessionId || payload.session?.id;
        const projectId = payload.projectId || payload.session?.projectId;
        const title = String(payload.title || payload.session?.title || '').trim();
        if (!sessionId || !projectId || !title) {
          return;
        }
        setSessionsByProject((current) => applySessionRenameToProjectSessions(current, payload));
        setSelectedSession((current) => {
          if (!current || String(current.id) !== String(sessionId)) {
            return current;
          }
          return {
            ...current,
            ...(payload.session || {}),
            id: sessionId,
            projectId,
            title,
            titleLocked: payload.titleLocked ?? payload.session?.titleLocked ?? true,
            updatedAt: payload.updatedAt || payload.session?.updatedAt || current.updatedAt
          };
        });
        return;
      }
      if (payload.type === 'user-message') {
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        setMessages((current) => {
          const alreadyShown = current.some(
            (message) => message.role === 'user' && message.content === payload.message.content
          );
          if (alreadyShown) {
            return current;
          }
          return [...current, payload.message];
        });
        return;
      }
      if (payload.type === 'assistant-update') {
        if (!payload.content?.trim()) {
          return;
        }
        markRun(payload);
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (payload.phase === 'commentary') {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              kind: payload.kind || 'agent_message',
              label: String(payload.content || '').trim(),
              status: payload.status || 'running'
            })
          );
          return;
        }
        setMessages((current) => upsertAssistantMessage(current, payload));
        if (payload.done !== false) {
          applyAutoSessionTitle(payload, payload.content);
        }
        return;
      }
      if (payload.type === 'status-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        notifyFromPayload(payload);
        if (payload.status === 'queued' && payloadMatchesCurrentConversation(payload)) {
          loadQueueDrafts(selectedSessionRef.current).catch(() => null);
        }
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (payload.kind === 'turn' && payload.status === 'completed') {
          markTurnCompleted(payload);
          return;
        }
        setMessages((current) => upsertStatusMessage(current, payload));
        return;
      }
      if (payload.type === 'activity-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        notifyFromPayload(payload);
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        setMessages((current) => upsertActivityMessage(current, payload));
        return;
      }
      if (payload.type === 'context-status-update') {
        markRun(payload);
        if (payloadMatchesCurrentConversation(payload)) {
          setContextStatus((current) => mergeContextStatus(current, payload, DEFAULT_STATUS.context));
        }
        return;
      }
      if (payload.type === 'chat-complete' || payload.type === 'chat-error' || payload.type === 'chat-aborted') {
        notifyFromPayload(payload);
        loadQueueDrafts(selectedSessionRef.current).catch(() => null);
        if (!payloadMatchesCurrentConversation(payload)) {
          clearRun(payload);
          return;
        }
        if (payload.type === 'chat-complete') {
          if (payload.context) {
            setContextStatus((current) => mergeContextStatus(current, payload.context, DEFAULT_STATUS.context));
          }
          markSessionCompleteNotice(payload);
          clearRun(payload);
          markTurnCompleted(payload);
          scheduleTurnRefresh(payload);
          return;
        }
        clearRun(payload);
        if (payload.type === 'chat-error' && payload.error) {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              status: 'failed',
              label: '任务失败',
              detail: payload.error
            })
          );
        } else if (payload.type === 'chat-aborted') {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              status: 'completed',
              label: '已中止'
            })
          );
        }
        return;
      }
      if (payload.type === 'sync-complete' && payload.projects) {
        setProjects(payload.projects);
        const project = selectedProjectRef.current;
        if (!project?.id) {
          const preferred =
            payload.projects.find((item) => item.name.toLowerCase() === 'codexmobile') ||
            payload.projects.find((item) => item.path.toLowerCase().includes('codexmobile')) ||
            payload.projects[0] ||
            null;
          if (preferred) {
            setSelectedProject(preferred);
            setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
            loadSessions(preferred, {
              chooseLatest: true,
              preserveSelection: false
            }).catch(() => null);
          }
          return;
        }
        if (project?.id) {
          apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
            .then((data) => {
              const nextSessions = data.sessions || [];
              setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
              const currentSession = selectedSessionRef.current;
              const refreshedSession = nextSessions.find((session) => session.id === currentSession?.id);
              if (refreshedSession) {
                setSelectedSession((current) => (current?.id === refreshedSession.id ? { ...current, ...refreshedSession } : current));
                setContextStatus(normalizeContextStatus(refreshedSession.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
              }
            })
            .catch(() => null);
        }
      }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      wsRef.current?.close();
      setConnectionState('disconnected');
    };
  }, [authenticated]);

  async function handleSync() {
    setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      await loadStatus();
      await loadProjects({ preserveSelection: true });
      showToast({ level: 'success', title: '同步完成', body: '线程和状态已经刷新。' });
    } catch (error) {
      showToast({ level: 'error', title: '同步失败', body: error.message || '无法刷新同步。' });
    } finally {
      setSyncing(false);
    }
  }

  async function handleRetryConnection() {
    try {
      await loadStatus();
      showToast({ level: 'success', title: '连接已刷新', body: '已重新读取本机服务状态。' });
    } catch (error) {
      showToast({ level: 'error', title: '连接失败', body: error.message || '本机服务暂时不可达。' });
    }
  }

  function handleResetPairing() {
    clearToken();
    setAuthenticated(false);
    setConnectionState('disconnected');
  }

  function handleShowConnectionStatus() {
    showToast({
      level: status.desktopBridge?.connected ? 'info' : 'warning',
      title: bridgeConnectionLabel(connectionState, status.desktopBridge).label,
      body: status.desktopBridge?.reason || status.desktopBridge?.mode || 'CodexMobile 状态已读取。'
    });
  }

  async function handleToggleProject(project) {
    const isExpanded = Boolean(expandedProjectIds[project.id]);
    if (isExpanded) {
      setExpandedProjectIds((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }

    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    const projectChanged = selectedProject?.id !== project.id;
    setSelectedProject(project);
    if (projectChanged) {
      setSelectedSession(null);
      setMessages([]);
      setContextStatus(emptyContextStatus());
    }
    if (!sessionsByProject[project.id]) {
      await loadSessions(project, false);
    }
  }

  async function handleSelectSession(session) {
    clearSessionCompleteNotice(session?.id);
    selectedSessionRef.current = session;
    setSelectedSession(session);
    const requestedSessionId = session?.id || null;
    if (isDraftSession(session)) {
      setMessages([]);
      setContextStatus(emptyContextStatus());
      setDrawerOpen(false);
      return;
    }
    setContextStatus(normalizeContextStatus(session?.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
    const data = await apiFetch(sessionMessagesApiPath(session.id));
    if (selectedSessionRef.current?.id !== requestedSessionId) {
      return;
    }
    setMessages(data.messages || []);
    setContextStatus(normalizeContextStatus(data.context || session.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
    setDrawerOpen(false);
  }

  async function refreshProjectSessions(project) {
    if (!project?.id) {
      return;
    }
    const [projectData, sessionData] = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
    ]);
    const nextProjects = projectData.projects || [];
    setProjects(nextProjects);
    setSessionsByProject((current) => ({ ...current, [project.id]: sessionData.sessions || [] }));
    const nextSelectedProject = nextProjects.find((item) => item.id === selectedProjectRef.current?.id);
    if (nextSelectedProject) {
      setSelectedProject(nextSelectedProject);
    }
  }

  function firstUserMessageForTurn(turnId) {
    const scoped = (messagesRef.current || []).filter((message) => !turnId || message.turnId === turnId);
    return scoped.find((message) => message.role === 'user' && String(message.content || '').trim())?.content || '';
  }

  function applyAutoSessionTitle(payload, assistantContent) {
    const currentSession = selectedSessionRef.current;
    const projectId = payload.projectId || selectedProjectRef.current?.id || currentSession?.projectId;
    if (!currentSession || !projectId || currentSession.titleLocked) {
      return;
    }
    const userMessage = firstUserMessageForTurn(payload.turnId);
    const nextTitle = sessionTitleFromConversation({
      userMessage,
      assistantMessage: assistantContent
    });
    if (!nextTitle || nextTitle === currentSession.title) {
      return;
    }

    const ids = new Set([currentSession.id, payload.sessionId, payload.previousSessionId, payload.turnId].filter(Boolean));
    const patch = autoTitlePatch(nextTitle, 'completed');
    selectedSessionRef.current = { ...currentSession, ...patch };
    setSelectedSession((current) => (current && ids.has(current.id) ? { ...current, ...patch } : current));
    setSessionsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] || []).map((item) => (ids.has(item.id) ? { ...item, ...patch } : item))
    }));

    const sessionId = payload.sessionId || (!isDraftSession(currentSession) ? currentSession.id : '');
    if (!sessionId || isDraftSession(sessionId)) {
      return;
    }
    const syncKey = `${projectId}:${sessionId}:${nextTitle}`;
    if (autoTitleSyncRef.current.has(syncKey)) {
      return;
    }
    autoTitleSyncRef.current.add(syncKey);
    apiFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: { title: nextTitle, auto: true }
    }).catch(() => {
      autoTitleSyncRef.current.delete(syncKey);
    });
  }

  async function handleRenameSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const currentTitle = session.title || '对话';
    const nextTitle = window.prompt('重命名线程', currentTitle)?.trim().slice(0, 52);
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }

    const applyLocalTitle = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === session.id ? { ...item, title: nextTitle, titleLocked: true } : item
        )
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession((current) => (current ? { ...current, title: nextTitle, titleLocked: true } : current));
      }
    };

    if (isDraftSession(session)) {
      applyLocalTitle();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: { title: nextTitle }
      });
      applyLocalTitle();
      await refreshProjectSessions(project);
    } catch (error) {
      window.alert(`重命名失败：${error.message}`);
    }
  }

  async function handleDeleteSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const title = session.title || '\u5bf9\u8bdd';
    const confirmed = window.confirm(
      `\u5f52\u6863\u7ebf\u7a0b\u201c${title}\u201d\uff1f\u8fd9\u4f1a\u540c\u6b65\u5f52\u6863\u7535\u8111\u7aef Codex App \u91cc\u7684\u540c\u4e00\u4e2a\u5bf9\u8bdd\u3002`
    );
    if (!confirmed) {
      return;
    }

    const removeLocalSession = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).filter((item) => item.id !== session.id)
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession(null);
        setMessages([]);
        setAttachments([]);
        setInput('');
      }
    };

    if (isDraftSession(session)) {
      removeLocalSession();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE'
      });
      removeLocalSession();
      await refreshProjectSessions(project);
    } catch (error) {
      const message = String(error.message || '');
      window.alert(
        message.toLowerCase().includes('running')
          ? '\u7ebf\u7a0b\u6b63\u5728\u8fd0\u884c\uff0c\u7a0d\u540e\u518d\u5f52\u6863\u3002'
          : `\u5f52\u6863\u5931\u8d25\uff1a${message}`
      );
    }
  }

  async function handleDeleteMessage(message) {
    if (!message?.id) {
      return;
    }
    if (!window.confirm('删除这条消息？')) {
      return;
    }

    const messageId = String(message.id);
    const sessionId = selectedSessionRef.current?.id || message.sessionId || '';
    const existingIndex = messages.findIndex((item) => String(item.id) === messageId);
    const removedMessage = existingIndex >= 0 ? messages[existingIndex] : message;
    setMessages((current) => current.filter((item) => String(item.id) !== messageId));

    if (!sessionId || isDraftSession({ id: sessionId })) {
      return;
    }

    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
    } catch (error) {
      setMessages((current) => {
        if (current.some((item) => String(item.id) === messageId)) {
          return current;
        }
        const next = [...current];
        const insertAt = existingIndex >= 0 ? Math.min(existingIndex, next.length) : next.length;
        next.splice(insertAt, 0, removedMessage);
        return next;
      });
      window.alert(`删除失败：${error.message}`);
    }
  }

  function handleNewConversation() {
    if (!desktopBridgeCanCreateThread(status.desktopBridge)) {
      setMessages((current) => [
        ...current,
        {
          id: `desktop-create-unavailable-${Date.now()}`,
          role: 'activity',
          content: status.desktopBridge?.capabilities?.createThreadReason || '当前桌面端还没有开放从手机新建同源对话的入口。请先在桌面端新建或打开一个对话，再从手机继续发送。',
          timestamp: new Date().toISOString()
        }
      ]);
      setDrawerOpen(false);
      return;
    }
    const project = selectedProject || projects[0];
    if (!project) {
      return;
    }
    const draft = createDraftSession(project);
    setSelectedProject(project);
    setSelectedSession(draft);
    setContextStatus(emptyContextStatus());
    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    setSessionsByProject((current) => upsertSessionInProject(current, project.id, draft));
    setMessages([]);
    setAttachments([]);
    setDrawerOpen(false);
  }

  async function handleUploadFiles(files) {
    setUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const result = await apiFetch('/api/uploads', {
          method: 'POST',
          body: formData
        });
        setAttachments((current) => [...current, result.upload]);
      }
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `upload-error-${Date.now()}`,
          role: 'activity',
          content: error.message,
          timestamp: new Date().toISOString()
        }
      ]);
    } finally {
      setUploading(false);
    }
  }

  function handleRemoveAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function turnMatchesCurrentSelection(turnId, optimisticSessionId, realSessionId, previousSessionId) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    return (
      current.id === optimisticSessionId ||
      current.id === realSessionId ||
      current.id === previousSessionId ||
      current.turnId === turnId ||
      current.draft
    );
  }

  function applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId) {
    const sessionIdText = String(turn.sessionId || '');
    const realSessionId =
      sessionIdText && !sessionIdText.startsWith('draft-') && !sessionIdText.startsWith('codex-')
        ? sessionIdText
        : null;
    if (!realSessionId) {
      return null;
    }

    const currentSession = selectedSessionRef.current;
    const nextSession = {
      ...(currentSession || {}),
      id: realSessionId,
      projectId,
      title: currentSession?.title || '新对话',
      turnId: turn.turnId || currentSession?.turnId || null,
      updatedAt: turn.completedAt || turn.updatedAt || new Date().toISOString(),
      draft: false
    };

    setSelectedSession((current) => {
      if (!current) {
        return nextSession;
      }
      if (!turnMatchesCurrentSelection(turn.turnId, optimisticSessionId, realSessionId, previousSessionId)) {
        return current;
      }
      return { ...current, ...nextSession };
    });
    setSessionsByProject((current) =>
      upsertSessionInProject(current, projectId, nextSession, previousSessionId || optimisticSessionId)
    );
    setMessages((current) =>
      current.map((message) =>
        message.turnId === turn.turnId || message.sessionId === optimisticSessionId || message.sessionId === previousSessionId
          ? { ...message, sessionId: realSessionId }
          : message
      )
    );
    if (turn.status === 'running' || turn.status === 'queued') {
      markRun({ turnId: turn.turnId, sessionId: realSessionId, previousSessionId: previousSessionId || optimisticSessionId });
    }
    return realSessionId;
  }

  async function loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId) {
    if (!realSessionId) {
      return false;
    }
    const current = selectedSessionRef.current;
    if (
      current &&
      current.id !== realSessionId &&
      current.id !== optimisticSessionId &&
      current.id !== previousSessionId &&
      current.turnId !== turnId
    ) {
      return false;
    }
    const data = await apiFetch(sessionMessagesApiPath(realSessionId));
    if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, { turnId })) {
      setContextStatus((current) => mergeContextStatus(current, data.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context));
      setMessages((currentMessages) =>
        mergeLoadedMessagesPreservingActivity(currentMessages, data.messages, {
          sessionId: realSessionId,
          previousSessionId,
          turnId
        })
      );
      return true;
    }
    return false;
  }

  async function pollTurnUntilComplete({ turnId, optimisticSessionId, projectId, previousSessionId }) {
    if (!turnId || activePollsRef.current.has(turnId)) {
      return;
    }
    activePollsRef.current.add(turnId);
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < 1800000) {
        await new Promise((resolve) => window.setTimeout(resolve, 1400));
        let turn = null;
        try {
          const result = await apiFetch(`/api/chat/turns/${encodeURIComponent(turnId)}`);
          turn = result.turn;
        } catch {
          continue;
        }
        if (!turn) {
          continue;
        }

        const realSessionId = applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId);
        if (turn.status === 'failed') {
          clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              kind: 'turn',
              status: 'failed',
              label: '任务失败',
              detail: turn.error || turn.detail || '任务失败'
            })
          );
          break;
        }
        if (turn.status === 'aborted') {
          clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              kind: 'turn',
              status: 'completed',
              label: '已中止'
            })
          );
          break;
        }
        if (turn.status === 'completed') {
          const terminalPayload = {
            sessionId: realSessionId || optimisticSessionId,
            turnId,
            previousSessionId,
            startedAt: turn.startedAt || '',
            completedAt: turn.completedAt || turn.updatedAt || '',
            durationMs: turn.durationMs || null,
            detail: turn.detail || ''
          };
          if (turn.context) {
            setContextStatus((current) => mergeContextStatus(current, turn.context, DEFAULT_STATUS.context));
          }
          markSessionCompleteNotice(terminalPayload);
          markTurnCompleted(terminalPayload);
          const loaded = await loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId);
          if (loaded) {
            clearRun(terminalPayload);
          } else {
            scheduleTurnRefresh({
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              previousSessionId,
              startedAt: turn.startedAt || '',
              completedAt: turn.completedAt || turn.updatedAt || '',
              durationMs: turn.durationMs || null,
              hadAssistantText: turn.hadAssistantText || Boolean(turn.assistantPreview),
              usage: turn.usage || null
            });
          }
          break;
        }
      }
    } finally {
      activePollsRef.current.delete(turnId);
    }
  }

  function selectedSkillsForTurn() {
    const selected = new Set(selectedSkillPaths);
    return (Array.isArray(status.skills) ? status.skills : [])
      .filter((skill) => selected.has(skill.path))
      .map((skill) => ({
        name: skill.name || skill.label,
        path: skill.path
      }));
  }

  function dismissToast(id) {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function showToast(toast) {
    const id = toast.id || `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const nextToast = {
      id,
      level: toast.level || 'info',
      title: toast.title || '提醒',
      body: toast.body || ''
    };
    setToasts((current) => [nextToast, ...current.filter((item) => item.id !== id)].slice(0, 4));
    if (toastTimersRef.current.has(id)) {
      window.clearTimeout(toastTimersRef.current.get(id));
    }
    const timer = window.setTimeout(() => dismissToast(id), toast.durationMs || 5200);
    toastTimersRef.current.set(id, timer);
    return id;
  }

  function maybeSendWebNotification(notification) {
    if (!notification) {
      return;
    }
    if (browserPushSupported()) {
      return;
    }
    if (!shouldUseWebNotification({
      enabled: notificationsEnabled,
      permission: notificationPermission,
      visibilityState: document.visibilityState,
      standalone: isStandalonePwa()
    })) {
      return;
    }
    try {
      new Notification(notification.title, {
        body: notification.body,
        tag: `codexmobile-${notification.title}`,
        silent: false
      });
    } catch {
      // Browser notification support varies across mobile browsers.
    }
  }

  function notifyFromPayload(payload) {
    const notification = notificationFromPayload(payload);
    if (!notification) {
      return;
    }
    showToast(notification);
    maybeSendWebNotification(notification);
  }

  async function enableNotifications() {
    const pushSupported = browserPushSupported();
    const standalone = isStandalonePwa();
    const secureContext = Boolean(window.isSecureContext);
    if (!pushSupported || !secureContext || !standalone) {
      showToast({
        level: 'warning',
        title: '通知不可用',
        body: notificationEnablementMessage({ supported: pushSupported, secureContext, standalone }),
        durationMs: 7000
      });
      return;
    }
    try {
      const result = await registerWebPush({ apiFetch });
      setNotificationPermission(result.permission);
      setNotificationsEnabled(true);
      setNotificationPreferenceEnabled(true);
      showToast({
        level: 'success',
        title: '完成通知已开启',
        body: notificationEnablementMessage({ supported: true, secureContext: true, standalone: true })
      });
    } catch (error) {
      setNotificationPermission(browserNotificationPermission());
      setNotificationsEnabled(false);
      setNotificationPreferenceEnabled(false);
      showToast({
        level: error.code === 'permission-denied' ? 'warning' : 'error',
        title: error.code === 'permission-denied' ? '未开启通知' : '通知开启失败',
        body: error.message || '无法请求 Web Push 通知权限。',
        durationMs: 7000
      });
    }
  }

  function toggleSelectedSkill(path) {
    const value = String(path || '').trim();
    if (!value) {
      return;
    }
    setSelectedSkillPaths((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    );
  }

  function selectSkill(path) {
    const value = String(path || '').trim();
    if (!value) {
      return;
    }
    setSelectedSkillPaths((current) => current.includes(value) ? current : [...current, value]);
  }

  function clearSelectedSkills() {
    setSelectedSkillPaths([]);
  }

  function addFileMention(file) {
    const pathValue = String(file?.path || '').trim();
    if (!pathValue) {
      return;
    }
    setFileMentions((current) => {
      if (current.some((item) => item.path === pathValue)) {
        return current;
      }
      return [
        ...current,
        {
          name: file.name || pathValue.split('/').pop() || pathValue,
          path: pathValue,
          relativePath: file.relativePath || file.name || pathValue
        }
      ].slice(0, 12);
    });
  }

  function removeFileMention(pathValue) {
    setFileMentions((current) => current.filter((item) => item.path !== pathValue));
  }

  function queueQueryForSession(session = selectedSessionRef.current) {
    if (!session?.id) {
      return '';
    }
    if (isDraftSession(session)) {
      return `draftSessionId=${encodeURIComponent(session.id)}`;
    }
    return `sessionId=${encodeURIComponent(session.id)}`;
  }

  async function loadQueueDrafts(session = selectedSessionRef.current) {
    const query = queueQueryForSession(session);
    if (!query) {
      setQueueDrafts([]);
      return;
    }
    try {
      const result = await apiFetch(`/api/chat/queue?${query}`);
      setQueueDrafts(Array.isArray(result.drafts) ? result.drafts : []);
    } catch {
      setQueueDrafts([]);
    }
  }

  async function removeQueueDraft(draftId) {
    const session = selectedSessionRef.current;
    const body = {
      sessionId: isDraftSession(session) ? null : session?.id,
      draftSessionId: isDraftSession(session) ? session?.id : null,
      draftId
    };
    await apiFetch('/api/chat/queue', { method: 'DELETE', body }).catch(() => null);
    await loadQueueDrafts(session);
  }

  async function restoreQueueDraft(draftId) {
    const session = selectedSessionRef.current;
    const body = {
      sessionId: isDraftSession(session) ? null : session?.id,
      draftSessionId: isDraftSession(session) ? session?.id : null,
      draftId
    };
    const result = await apiFetch('/api/chat/queue/restore', { method: 'POST', body }).catch(() => null);
    const draft = result?.draft;
    if (!draft) {
      await loadQueueDrafts(session);
      return;
    }
    setInput(draft.text || '');
    setAttachments(Array.isArray(draft.attachments) ? draft.attachments : []);
    setFileMentions(Array.isArray(draft.fileMentions) ? draft.fileMentions : []);
    setSelectedSkillPaths((Array.isArray(draft.selectedSkills) ? draft.selectedSkills : [])
      .map((skill) => skill.path)
      .filter(Boolean));
    await loadQueueDrafts(session);
  }

  async function steerQueueDraft(draftId) {
    const session = selectedSessionRef.current;
    const body = {
      projectId: selectedProjectRef.current?.id || selectedProject?.id,
      sessionId: isDraftSession(session) ? null : session?.id,
      draftSessionId: isDraftSession(session) ? session?.id : null,
      draftId
    };
    await apiFetch('/api/chat/queue/steer', { method: 'POST', body }).catch(() => null);
    await loadQueueDrafts(session);
  }

  async function submitCodexMessage({
    message,
    attachmentsForTurn = [],
    fileMentionsForTurn = [],
    clearComposer = false,
    restoreTextOnError = false,
    sendMode = 'start'
  }) {
    const project = selectedProject || selectedProjectRef.current;
    const selectedAttachments = Array.isArray(attachmentsForTurn) ? attachmentsForTurn : [];
    const selectedFileMentions = Array.isArray(fileMentionsForTurn) ? fileMentionsForTurn : [];
    const displayMessage =
      String(message || '').trim() ||
      (selectedAttachments.length ? '请查看附件。' : (selectedFileMentions.length ? '请查看引用文件。' : ''));
    if ((!displayMessage && !selectedAttachments.length && !selectedFileMentions.length) || !project) {
      if (restoreTextOnError && displayMessage) {
        restoreVoiceTextToInput(displayMessage);
      }
      throw new Error(project ? 'message or attachments are required' : '请先选择项目');
    }

    let sessionForTurn = selectedSession;
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(project);
      setSelectedSession(sessionForTurn);
      setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
      setSessionsByProject((current) => upsertSessionInProject(current, project.id, sessionForTurn));
    }

    const turnId = createClientTurnId();
    const draftSessionId = isDraftSession(sessionForTurn) ? sessionForTurn.id : null;
    const outgoingSessionId = draftSessionId ? null : sessionForTurn?.id || null;
    const optimisticSessionId = draftSessionId || outgoingSessionId || turnId;
    const initialTitle = draftSessionId && !sessionForTurn.titleLocked
      ? titleFromFirstMessage(displayMessage)
      : null;
    const optimisticContent = contentWithAttachmentPreviews(displayMessage, selectedAttachments);

    if (clearComposer) {
      setInput('');
      setAttachments([]);
      setFileMentions([]);
    }

    markRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
    setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, turnId, ...autoTitlePatch(initialTitle) }
        : current
    );
    setSessionsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] || []).map((item) =>
        item.id === sessionForTurn.id
          ? { ...item, turnId, ...autoTitlePatch(initialTitle) }
          : item
      )
    }));
    const submittedAt = new Date().toISOString();
    setMessages((current) =>
      upsertStatusMessage(
        [
          ...current,
          {
            id: `local-${Date.now()}`,
            role: 'user',
            content: optimisticContent,
            timestamp: submittedAt,
            sessionId: optimisticSessionId,
            turnId
          }
        ],
        {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'reasoning',
          status: 'running',
          label: '正在思考中',
          timestamp: submittedAt,
          startedAt: submittedAt
        }
      )
    );

    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: project.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          message: displayMessage,
          permissionMode,
          model: selectedModel || status.model,
          reasoningEffort: selectedReasoningEffort || status.reasoningEffort || DEFAULT_REASONING_EFFORT,
          selectedSkills: selectedSkillsForTurn(),
          attachments: selectedAttachments,
          fileMentions: selectedFileMentions,
          sendMode
        }
      });
      const resultTurnId = result.turnId || turnId;
      const resultSessionId = result.sessionId || optimisticSessionId;
      if (result.desktopBridge?.mode === 'desktop-ipc') {
        rememberDesktopIpcPendingRun(resultSessionId, {
          message: displayMessage,
          turnId: resultTurnId,
          clientTurnId: turnId,
          previousSessionId: draftSessionId || outgoingSessionId,
          startedAt: submittedAt
        });
        markRun({
          turnId: resultTurnId,
          sessionId: resultSessionId,
          previousSessionId: draftSessionId || outgoingSessionId
        });
        return {
          turnId: resultTurnId,
          optimisticSessionId,
          projectId: project.id,
          previousSessionId: draftSessionId || outgoingSessionId
        };
      }
      pollTurnUntilComplete({
        turnId: resultTurnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      });
      return {
        turnId: resultTurnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      };
    } catch (error) {
      clearRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
      if (clearComposer) {
        setAttachments(selectedAttachments);
        setFileMentions(selectedFileMentions);
        if (String(message || '').trim()) {
          setInput(String(message).trim());
        }
      }
      if (restoreTextOnError) {
        restoreVoiceTextToInput(displayMessage);
      }
      setMessages((current) =>
        upsertStatusMessage(current, {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'turn',
          status: 'failed',
          label: '发送失败',
          detail: error.message,
          timestamp: new Date().toISOString()
        })
      );
      throw error;
    }
  }

  async function abortCurrentRun() {
    const abortId =
      selectedSessionRef.current?.id ||
      selectedSessionRef.current?.turnId ||
      Object.keys(runningByIdRef.current || runningById)[0];
    if (!abortId) {
      return false;
    }
    await apiFetch('/api/chat/abort', {
      method: 'POST',
      body: { sessionId: abortId, turnId: selectedSessionRef.current?.turnId || null }
    }).catch(() => null);
    desktopIpcPendingRunsRef.current.delete(abortId);
    clearRun({ sessionId: abortId, turnId: selectedSessionRef.current?.turnId || null });
    return true;
  }

  async function handleSubmit({ mode = 'start' } = {}) {
    const message = input.trim();
    if ((!message && !attachments.length && !fileMentions.length) || !selectedProject) {
      return;
    }
    try {
      await submitCodexMessage({
        message,
        attachmentsForTurn: attachments,
        fileMentionsForTurn: fileMentions,
        clearComposer: true,
        sendMode: mode === 'guide' ? 'interrupt' : mode
      });
      await loadQueueDrafts(selectedSessionRef.current);
    } catch {
      // submitCodexMessage already reflects the failure in the chat UI.
    }
  }

  async function handleGitAction(action) {
    if (!selectedProject || running) {
      return;
    }
    setGitPanel({ open: true, action });
  }

  function restoreVoiceTextToInput(text) {
    const value = String(text || '').trim();
    if (!value) {
      return;
    }
    setInput((current) => {
      const base = String(current || '').trimEnd();
      if (!base) {
        return value;
      }
      if (base.includes(value)) {
        return current;
      }
      return `${base}\n${value}`;
    });
  }

  async function handleVoiceSubmit(transcript) {
    const message = String(transcript || '').trim();
    if (!message) {
      throw new Error('没有识别到文字');
    }
    return submitCodexMessage({
      message,
      attachmentsForTurn: [],
      restoreTextOnError: true
    });
  }

  async function handleAbort() {
    await abortCurrentRun();
  }

  async function handleConnectDocs() {
    if (docsBusy) {
      return;
    }
    setDocsBusy(true);
    setDocsError('');
    try {
      const result = await apiFetch('/api/feishu/cli/auth/start', { method: 'POST' });
      if (result.docs) {
        setStatus((current) => ({ ...current, docs: result.docs }));
      }
      if (!result.verificationUrl) {
        throw new Error('没有收到飞书授权地址');
      }
      window.location.assign(result.verificationUrl);
    } catch (error) {
      setDocsError(error.message || '飞书连接失败');
      setDocsBusy(false);
    }
  }

  async function handleDisconnectDocs() {
    if (docsBusy) {
      return;
    }
    setDocsBusy(true);
    setDocsError('');
    try {
      await apiFetch('/api/feishu/cli/auth/logout', { method: 'POST' });
      await loadStatus();
    } catch (error) {
      setDocsError(error.message || '断开飞书失败');
    } finally {
      setDocsBusy(false);
    }
  }

  async function handleRefreshDocs() {
    if (docsBusy) {
      return;
    }
    setDocsBusy(true);
    setDocsError('');
    try {
      await loadStatus();
    } catch (error) {
      setDocsError(error.message || '刷新飞书状态失败');
    } finally {
      setDocsBusy(false);
    }
  }

  function handleOpenDocsHome() {
    const docsUrl = String(status.docs?.homeUrl || 'https://docs.feishu.cn/').trim();
    if (docsUrl) {
      window.location.assign(docsUrl);
    }
  }

  function handleOpenDocsAuth(url) {
    const authUrl = String(url || '').trim();
    if (authUrl) {
      window.location.assign(authUrl);
    }
  }

  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);
  const visibleContextStatus = useMemo(
    () => {
      if (!selectedSession || isDraftSession(selectedSession)) {
        return emptyContextStatus();
      }
      return normalizeContextStatus(contextStatus || selectedSession.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context);
    },
    [contextStatus, selectedSession]
  );
  const canCreateThreadFromMobile = desktopBridgeCanCreateThread(status.desktopBridge);
  const createThreadUnavailableReason =
    status.desktopBridge?.capabilities?.createThreadReason ||
    '当前桌面端还没有开放从手机新建同源对话的入口';
  const notificationSupported = browserPushSupported();
  const recoveryState = connectionRecoveryState({
    authenticated,
    connectionState,
    desktopBridge: status.desktopBridge,
    syncing
  });

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} />;
  }

  return (
    <div className={shellClass}>
      <TopBar
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        connectionState={connectionState}
        desktopBridge={status.desktopBridge}
        onMenu={() => setDrawerOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
        onGitAction={handleGitAction}
        notificationSupported={notificationSupported}
        notificationEnabled={notificationsEnabled && notificationPermission === 'granted'}
        onEnableNotifications={enableNotifications}
        gitDisabled={!selectedProject || running}
      />
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        projects={projects}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        expandedProjectIds={expandedProjectIds}
        sessionsByProject={sessionsByProject}
        loadingProjectId={loadingProjectId}
        runningById={runningById}
        threadRuntimeById={threadRuntimeById}
        completedSessionIds={completedSessionIds}
        onToggleProject={handleToggleProject}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onNewConversation={handleNewConversation}
        onSync={handleSync}
        syncing={syncing}
        theme={theme}
        setTheme={setTheme}
        canCreateThread={canCreateThreadFromMobile}
        createThreadUnavailableReason={createThreadUnavailableReason}
      />
      <DocsPanel
        open={docsOpen}
        docs={status.docs}
        busy={docsBusy}
        error={docsError}
        onClose={() => setDocsOpen(false)}
        onConnect={handleConnectDocs}
        onDisconnect={handleDisconnectDocs}
        onOpenHome={handleOpenDocsHome}
        onOpenAuth={handleOpenDocsAuth}
        onRefresh={handleRefreshDocs}
      />
      <GitPanel
        open={gitPanel.open}
        action={gitPanel.action}
        project={selectedProject}
        onToast={showToast}
        onClose={() => setGitPanel((current) => ({ ...current, open: false }))}
      />
      <ConnectionRecoveryCard
        state={recoveryState}
        onRetry={handleRetryConnection}
        onSync={handleSync}
        onPair={handleResetPairing}
        onStatus={handleShowConnectionStatus}
      />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ChatPane
        messages={messages}
        selectedSession={selectedSession}
        running={running}
        now={activityClockNow}
        onPreviewImage={setPreviewImage}
        onDeleteMessage={handleDeleteMessage}
      />
      <Composer
        input={input}
        setInput={setInput}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        onSubmit={handleSubmit}
        running={running}
        onAbort={handleAbort}
        models={status.models}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        selectedReasoningEffort={selectedReasoningEffort}
        onSelectReasoningEffort={setSelectedReasoningEffort}
        skills={status.skills}
        selectedSkillPaths={selectedSkillPaths}
        onToggleSkill={toggleSelectedSkill}
        onSelectSkill={selectSkill}
        onClearSkills={clearSelectedSkills}
        permissionMode={permissionMode}
        onSelectPermission={setPermissionMode}
        attachments={attachments}
        onUploadFiles={handleUploadFiles}
        onRemoveAttachment={handleRemoveAttachment}
        fileMentions={fileMentions}
        onAddFileMention={addFileMention}
        onRemoveFileMention={removeFileMention}
        uploading={uploading}
        contextStatus={visibleContextStatus}
        runStatus={composerRunStatus ? { ...composerRunStatus, steerable: selectedRuntime?.steerable !== false } : null}
        desktopBridge={status.desktopBridge}
        queueDrafts={queueDrafts}
        onRestoreQueueDraft={restoreQueueDraft}
        onRemoveQueueDraft={removeQueueDraft}
        onSteerQueueDraft={steerQueueDraft}
      />
      <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
