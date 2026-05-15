/**
 * CodexMobile Web：根级应用编排——认证门禁、服务端状态与 WS、会话域数据流、把 props 下发给 Shell。
 *
 * Keywords: pairing, websocket, bootstrap, session-orchestration, composer-props
 *
 * Exports:
 * - default — `App`（入口挂载的根组件）。
 *
 * Inward（本模块组装）: `PairingScreen`, `AppShell`；多处 `use*` hooks（bootstrap / session / submit / runtime / uploads 等）；
 *   `session-utils`、`api`、`AppState` reducer。
 *
 * Outward（谁消费）: 应用入口（如 `main`）仅挂载本 default；DOM 拼装见 `AppShell.jsx`。
 *
 * 不负责: 页面区域的具体布局与样式、`Composer`/`ChatPane` 内部交互实现。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { apiFetch, clearToken, getToken } from '../api.js';
import {
  DEFAULT_MODEL_SPEED,
  normalizeModelSpeed,
  normalizePermissionModeForSecurity,
  readStoredPermissionMode,
  writeStoredPermissionMode
} from '../composer/composer-options.js';
import { useComposerSelections } from '../composer/useComposerSelections.js';
import { useQueueDrafts } from '../composer/useQueueDrafts.js';
import { connectionRecoveryState } from '../connection-recovery.js';
import { mergeContextStatus, normalizeContextStatus } from './context-status.js';
import { DEFAULT_REASONING_EFFORT, DEFAULT_STATUS, REASONING_DEFAULT_VERSION } from './defaults.js';
import { appReducer, createInitialUiState, THEME_KEY } from './AppState.js';
import { useNotifications } from '../panels/useNotifications.js';
import { useAppBootstrap } from './useAppBootstrap.js';
import { useConnectionActions } from './useConnectionActions.js';
import { useDocsActions } from './useDocsActions.js';
import { useFileUploads } from './useFileUploads.js';
import { useAppWebSocket } from './useAppWebSocket.js';
import { upsertActivityMessage } from '../chat/activity-model.js';
import { useSessionLivePolling } from './useSessionLivePolling.js';
import { useSessionActions } from './useSessionActions.js';
import { useTurnSubmission } from './useTurnSubmission.js';
import { useTurnRuntime } from './useTurnRuntime.js';
import { useViewportSizing } from './useViewportSizing.js';
import { usePwaUpdate } from './pwa-update.js';
import { applyPwaTheme } from './pwa-theme.js';
import { mergeModelSettingsIntoStatus, nextSyncedComposerSettings } from './model-sync.js';
import { rememberSelectedSession } from './selection-persistence.js';
import {
  emptyContextStatus,
  emptyMessagePage,
  hasRunningKey,
  isDraftSession,
  reconcileThreadRuntimeWithSessions,
  resolveComposerGitProject,
  selectedRunKeys,
  selectedSessionIsRunning,
  upsertSessionInProject
} from './session-utils.js';
import { AppShell } from './AppShell.jsx';
import PairingScreen from './PairingScreen.jsx';
import {
  selectRuntimeForSession,
  syncRunningByIdFromRuntime
} from '../sync/sync-selectors.js';

const MODEL_SPEED_KEY = 'codexmobile.modelSpeed';
const DESKTOP_SHELL_MEDIA = '(min-width: 1024px)';

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

function gitChangedFileCount(status = {}) {
  if (Number.isFinite(status.fileCount)) {
    return status.fileCount;
  }
  return Array.isArray(status.files) ? status.files.length : 0;
}

function gitNeedsExplicitConfirm(status = {}) {
  return gitChangedFileCount(status) > 50 || (status.branch && !String(status.branch).startsWith('codex/'));
}

export default function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [contextStatus, setContextStatus] = useState(() => normalizeContextStatus(DEFAULT_STATUS.context));
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [uiState, dispatchUi] = useReducer(appReducer, undefined, () => createInitialUiState());
  const setDrawerOpen = useCallback((value) => dispatchUi({ type: 'ui/drawerOpen', value }), []);
  const setPreviewImage = useCallback((value) => dispatchUi({ type: 'ui/previewImage', value }), []);
  const setDocsOpen = useCallback((value) => dispatchUi({ type: 'ui/docsOpen', value }), []);
  const setDocsBusy = useCallback((value) => dispatchUi({ type: 'ui/docsBusy', value }), []);
  const setDocsError = useCallback((value) => dispatchUi({ type: 'ui/docsError', value }), []);
  const setGitPanel = useCallback((value) => dispatchUi({ type: 'ui/gitPanel', value }), []);
  const setTheme = useCallback((value) => dispatchUi({ type: 'ui/theme', value }), []);
  const { drawerOpen, previewImage, docsOpen, docsBusy, docsError, gitPanel, theme } = uiState;
  const {
    toasts,
    notificationSupported,
    notificationEnabled,
    dismissToast,
    showToast,
    enableNotifications
  } = useNotifications();
  const pwaUpdate = usePwaUpdate();
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagePage, setMessagePage] = useState(() => emptyMessagePage());
  const [sessionLoadingId, setSessionLoadingId] = useState(null);
  const [sessionLoadError, setSessionLoadError] = useState('');
  const [activityClockNow, setActivityClockNow] = useState(() => Date.now());
  const [completedSessionIds, setCompletedSessionIds] = useState({});
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [permissionMode, setPermissionMode] = useState(() => readStoredPermissionMode());
  const [selectedModel, setSelectedModel] = useState(DEFAULT_STATUS.model);
  const [selectedModelSpeed, setSelectedModelSpeed] = useState(() => normalizeModelSpeed(localStorage.getItem(MODEL_SPEED_KEY)));
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState(null);
  const [gitQuickDialog, setGitQuickDialog] = useState(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(() => {
    const defaultVersion = localStorage.getItem('codexmobile.reasoningDefaultVersion');
    if (defaultVersion !== REASONING_DEFAULT_VERSION) {
      localStorage.setItem('codexmobile.reasoningDefaultVersion', REASONING_DEFAULT_VERSION);
      localStorage.setItem('codexmobile.reasoningEffort', DEFAULT_REASONING_EFFORT);
      return DEFAULT_REASONING_EFFORT;
    }
    return localStorage.getItem('codexmobile.reasoningEffort') || DEFAULT_REASONING_EFFORT;
  });
  const {
    fileMentions,
    setFileMentions,
    selectedSkillPaths,
    setSelectedSkillPaths,
    toggleSelectedSkill,
    selectSkill,
    clearSelectedSkills,
    addFileMention,
    removeFileMention
  } = useComposerSelections(status);
  const [runningById, setRunningById] = useState({});
  const [threadRuntimeById, setThreadRuntimeById] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [desktopHandoffPending, setDesktopHandoffPending] = useState(false);
  const [homeExiting, setHomeExiting] = useState(false);
  const [connectionState, setConnectionState] = useState(() => (getToken() ? 'connecting' : 'disconnected'));
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const messagesRef = useRef([]);
  const autoTitleSyncRef = useRef(new Set());
  const runningByIdRef = useRef({});
  const turnRefreshTimersRef = useRef(new Map());
  const homeWasVisibleRef = useRef(false);
  const lastStatusSettingsRef = useRef({
    model: DEFAULT_STATUS.model,
    reasoningEffort: DEFAULT_STATUS.reasoningEffort || DEFAULT_REASONING_EFFORT
  });
  const selectedModelRef = useRef(selectedModel);
  const selectedReasoningEffortRef = useRef(selectedReasoningEffort);
  const modelSettingsRequestRef = useRef(0);
  const modelSettingsSyncQueueRef = useRef(Promise.resolve());
  const sessionLivePollRef = useRef(false);
  const bootstrapStartedRef = useRef(false);
  const drawerSyncAtRef = useRef(0);
  const desktopDrawerSeededRef = useRef(false);
  const composerRef = useRef(null);
  const gitQuickDialogResolverRef = useRef(null);

  const handleAuthRevoked = useCallback(() => {
    clearToken();
    setAuthenticated(false);
    setConnectionState('disconnected');
    showToast({
      level: 'warning',
      title: '设备已退出',
      body: '当前设备认证已失效，需要重新配对。'
    });
  }, [showToast]);

  const closeGitQuickDialog = useCallback((value = null) => {
    const resolver = gitQuickDialogResolverRef.current;
    gitQuickDialogResolverRef.current = null;
    setGitQuickDialog(null);
    resolver?.(value);
  }, []);

  const requestGitQuickDialog = useCallback((dialog) => new Promise((resolve) => {
    gitQuickDialogResolverRef.current?.(null);
    gitQuickDialogResolverRef.current = resolve;
    setGitQuickDialog({ ...dialog, busy: false });
  }), []);

  const requestGitInput = useCallback(
    (dialog) => requestGitQuickDialog({ ...dialog, mode: 'input' }),
    [requestGitQuickDialog]
  );
  const requestGitConfirm = useCallback(
    (dialog) => requestGitQuickDialog({ ...dialog, mode: 'confirm' }),
    [requestGitQuickDialog]
  );

  const {
    queueDrafts,
    loadQueueDrafts,
    removeQueueDraft,
    restoreQueueDraft,
    steerQueueDraft
  } = useQueueDrafts({
    selectedSessionRef,
    selectedProjectRef,
    selectedProject,
    setInput,
    setAttachments,
    setFileMentions,
    setSelectedSkillPaths
  });

  useViewportSizing(composerRef, { lockWindowScroll: authenticated });

  const activePermissionMode = useMemo(
    () => normalizePermissionModeForSecurity(permissionMode, status.security),
    [permissionMode, status.security]
  );

  const handleSelectPermission = useCallback((value) => {
    setPermissionMode(writeStoredPermissionMode(value));
  }, []);

  useEffect(() => {
    if (!authenticated || desktopDrawerSeededRef.current || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    desktopDrawerSeededRef.current = true;
    if (window.matchMedia(DESKTOP_SHELL_MEDIA).matches) {
      setDrawerOpen(true);
    }
  }, [authenticated, setDrawerOpen]);

  const syncRunningById = useMemo(() => syncRunningByIdFromRuntime(threadRuntimeById), [threadRuntimeById]);
  const selectedRuntime = selectRuntimeForSession(selectedSession, threadRuntimeById);
  const selectedSessionArchived = Boolean(selectedSession?.archived);
  const running =
    hasRunningKey(syncRunningById, selectedRunKeys(selectedSession)) ||
    selectedRuntime?.status === 'running' ||
    selectedRuntime?.status === 'queued';
  const selectedRunning = selectedSessionIsRunning({ running });
  const drawerRunningById = syncRunningById;
  useEffect(() => {
    loadQueueDrafts(selectedSession).catch(() => null);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!selectedSessionArchived) {
      return;
    }
    setInput('');
    setAttachments([]);
    setFileMentions([]);
    setSelectedCollaborationMode(null);
  }, [selectedSession?.id, selectedSessionArchived, setFileMentions]);

  useEffect(() => {
    setThreadRuntimeById((current) => {
      const next = reconcileThreadRuntimeWithSessions(current, sessionsByProject);
      return next === current ? current : next;
    });
  }, [sessionsByProject]);

  useEffect(() => {
    if (!selectedRunning) {
      return undefined;
    }
    setActivityClockNow(Date.now());
    const timer = window.setInterval(() => setActivityClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedRunning]);

  const {
    markRun,
    clearRun,
    markSessionCompleteNotice,
    clearSessionCompleteNotice,
    markTurnCompleted,
    scheduleTurnRefresh
  } = useTurnRuntime({
    defaultStatus: DEFAULT_STATUS,
    turnRefreshTimersRef,
    selectedSessionRef,
    runningByIdRef,
    setRunningById,
    setThreadRuntimeById,
    setCompletedSessionIds,
    setMessages,
    setContextStatus
  });

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    rememberSelectedSession(
      selectedSession?.projectId || selectedProject?.id
        ? { ...selectedSession, projectId: selectedSession?.projectId || selectedProject?.id }
        : selectedSession
    );
  }, [selectedProject?.id, selectedSession?.draft, selectedSession?.id, selectedSession?.projectId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useSessionLivePolling({
    authenticated,
    selectedSession,
    running,
    defaultStatus: DEFAULT_STATUS,
    sessionLivePollRef,
    selectedSessionRef,
    setContextStatus,
    setMessages
  });

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    applyPwaTheme(theme);
    if (theme !== 'system' || typeof window === 'undefined') {
      return undefined;
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) {
      return undefined;
    }
    const syncSystemTheme = () => applyPwaTheme('system');
    if (media.addEventListener) {
      media.addEventListener('change', syncSystemTheme);
    } else {
      media.addListener?.(syncSystemTheme);
    }
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', syncSystemTheme);
      } else {
        media.removeListener?.(syncSystemTheme);
      }
    };
  }, [theme]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    selectedReasoningEffortRef.current = selectedReasoningEffort;
    if (selectedReasoningEffort) {
      localStorage.setItem('codexmobile.reasoningEffort', selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    localStorage.setItem(MODEL_SPEED_KEY, normalizeModelSpeed(selectedModelSpeed || DEFAULT_MODEL_SPEED));
  }, [selectedModelSpeed]);

  useEffect(() => {
    const previous = lastStatusSettingsRef.current;
    const next = nextSyncedComposerSettings({
      currentModel: selectedModel,
      previousStatusModel: previous.model,
      statusModel: status.model,
      fallbackModel: DEFAULT_STATUS.model,
      currentReasoningEffort: selectedReasoningEffort,
      previousStatusReasoningEffort: previous.reasoningEffort,
      statusReasoningEffort: status.reasoningEffort,
      fallbackReasoningEffort: DEFAULT_REASONING_EFFORT
    });
    lastStatusSettingsRef.current = {
      model: status.model || previous.model,
      reasoningEffort: status.reasoningEffort || previous.reasoningEffort
    };
    if (next.model && next.model !== selectedModel) {
      setSelectedModel(next.model);
    }
    if (next.reasoningEffort && next.reasoningEffort !== selectedReasoningEffort) {
      setSelectedReasoningEffort(next.reasoningEffort);
    }
  }, [selectedModel, selectedReasoningEffort, status.model, status.reasoningEffort]);

  useEffect(() => {
    const model = selectedSession?.model;
    const reasoningEffort = selectedSession?.reasoningEffort;
    if (!model && !reasoningEffort) {
      return;
    }
    setStatus((current) =>
      mergeModelSettingsIntoStatus(current, {
        provider: selectedSession?.provider,
        model,
        reasoningEffort,
        sessionId: selectedSession?.id
      })
    );
  }, [selectedSession?.id, selectedSession?.model, selectedSession?.reasoningEffort, selectedSession?.provider]);

  const {
    loadStatus,
    loadSessions,
    loadProjects,
    bootstrap
  } = useAppBootstrap({
    defaultStatus: DEFAULT_STATUS,
    selectedProjectRef,
    selectedSessionRef,
    setStatus,
    setAuthenticated,
    setSelectedSession,
    setMessages,
    setMessagePage,
    setContextStatus,
    setLoadingProjectId,
    setSessionsByProject,
    setProjects,
    setSelectedProject,
    setExpandedProjectIds
  });

  const syncModelSettings = useCallback(async ({ model, reasoningEffort }) => {
    const next = {
      model: model || selectedModelRef.current || DEFAULT_STATUS.model,
      reasoningEffort: reasoningEffort || selectedReasoningEffortRef.current || DEFAULT_REASONING_EFFORT
    };
    const requestId = modelSettingsRequestRef.current + 1;
    modelSettingsRequestRef.current = requestId;
    setStatus((current) => mergeModelSettingsIntoStatus(current, next));
    const task = modelSettingsSyncQueueRef.current.catch(() => null).then(async () => {
      const data = await apiFetch('/api/model-settings', {
        method: 'POST',
        body: {
          ...next,
          sessionId: selectedSessionRef.current?.id || null
        }
      });
      if (modelSettingsRequestRef.current === requestId && data.settings) {
        setStatus((current) => mergeModelSettingsIntoStatus(current, data.settings));
      }
      if (data.desktopSync?.attempted && !data.desktopSync?.synced) {
        showToast({
          level: 'warning',
          title: '模型已保存',
          body: '桌面端当前线程没有立即接收模型设置，后续会按配置同步。'
        });
      }
    });
    modelSettingsSyncQueueRef.current = task;
    try {
      await task;
    } catch (error) {
      showToast({
        level: 'error',
        title: '模型同步失败',
        body: error.message || '无法同步模型设置。'
      });
      loadStatus().catch(() => null);
    }
  }, [loadStatus, showToast]);

  const handleSelectModel = useCallback((model) => {
    setSelectedModel(model);
    selectedModelRef.current = model;
    syncModelSettings({ model, reasoningEffort: selectedReasoningEffortRef.current });
  }, [syncModelSettings]);

  const handleSelectReasoningEffort = useCallback((reasoningEffort) => {
    setSelectedReasoningEffort(reasoningEffort);
    selectedReasoningEffortRef.current = reasoningEffort;
    syncModelSettings({ model: selectedModelRef.current, reasoningEffort });
  }, [syncModelSettings]);

  useEffect(() => {
    if (bootstrapStartedRef.current) {
      return;
    }
    bootstrapStartedRef.current = true;
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!drawerOpen || !authenticated) {
      return undefined;
    }
    const now = Date.now();
    if (now - drawerSyncAtRef.current < 6000) {
      return undefined;
    }
    drawerSyncAtRef.current = now;
    let stopped = false;
    apiFetch('/api/sync', { method: 'POST' })
      .then(async () => {
        if (stopped) {
          return;
        }
        await loadStatus();
        if (!stopped) {
          await loadProjects({ preserveSelection: true, silent: true });
        }
      })
      .catch(() => null);
    return () => {
      stopped = true;
    };
  }, [authenticated, drawerOpen, loadProjects, loadStatus]);

  const {
    handleToggleProject,
    handleSelectSession,
    handleLoadOlderMessages,
    handleRenameSession,
    handleDeleteSession,
    handleDeleteMessage,
    handleNewConversation
  } = useSessionActions({
    defaultStatus: DEFAULT_STATUS,
    selectedProject,
    selectedProjectRef,
    selectedSessionRef,
    projects,
    sessionsByProject,
    expandedProjectIds,
    messages,
    messagesRef,
    autoTitleSyncRef,
    setExpandedProjectIds,
    setProjects,
    setSelectedProject,
    setSelectedSession,
    setSessionsByProject,
    setMessages,
    setMessagePage,
    setSessionLoadingId,
    setSessionLoadError,
    setContextStatus,
    setAttachments,
    setInput,
    setDrawerOpen,
    loadSessions,
    upsertSessionInProject,
    clearSessionCompleteNotice
  });

  useAppWebSocket({
    useEffect,
    authenticated: authenticated && Boolean(status.auth?.authenticated),
    defaultStatus: DEFAULT_STATUS,
    wsRef,
    selectedProjectRef,
    selectedSessionRef,
    setConnectionState,
    setStatus,
    markRun,
    clearRun,
    markSessionCompleteNotice,
    markTurnCompleted,
    scheduleTurnRefresh,
    upsertSessionInProject,
    setRunningById,
    runningByIdRef,
    setThreadRuntimeById,
    setSelectedSession,
    setSessionsByProject,
    setMessages,
    setContextStatus,
    setProjects,
    setSelectedProject,
    setExpandedProjectIds,
    loadSessions,
    onAuthRevoked: handleAuthRevoked
  });

  const {
    handleSync,
    handleRetryConnection,
    handleResetPairing,
    handleShowConnectionStatus
  } = useConnectionActions({
    apiFetch,
    status,
    connectionState,
    setAuthenticated,
    setConnectionState,
    setSyncing,
    loadStatus,
    loadProjects,
    showToast
  });

  const {
    handleUploadFiles,
    handleRemoveAttachment
  } = useFileUploads({
    setUploading,
    setAttachments,
    setMessages
  });

  const {
    handleSubmit,
    handleImplementPlan,
    handleAdjustPlan,
    handleAbort
  } = useTurnSubmission({
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    selectedProject,
    selectedProjectRef,
    selectedSession,
    selectedSessionRef,
    projects,
    selectedSkillPaths,
    status,
    permissionMode: activePermissionMode,
    selectedModel,
    selectedModelSpeed,
    selectedReasoningEffort,
    input,
    attachments,
    fileMentions,
    runningById: syncRunningById,
    runningByIdRef,
    setInput,
    setAttachments,
    setFileMentions,
    setSelectedSession,
    setExpandedProjectIds,
    setSessionsByProject,
    setMessages,
    upsertSessionInProject,
    markRun,
    clearRun,
    loadQueueDrafts
  });

  async function createGitBranchFromDialog(project = selectedProject) {
    if (!project?.id) return null;
    const branchName = await requestGitInput({
      kind: 'branch',
      title: '创建分支',
      label: '分支名',
      defaultValue: gitBranchDraft(project),
      confirmText: '创建'
    });
    if (!branchName?.trim()) return null;
    showToast({ level: 'info', title: '创建分支', body: '正在创建并切换分支...' });
    const result = await apiFetch('/api/git/branch', {
      method: 'POST',
      body: { projectId: project.id, branchName: branchName.trim() }
    });
    showToast({ level: 'success', title: '创建分支', body: `已切换到 ${result.branch || branchName.trim()}` });
    return result;
  }

  async function handleGitAction(action) {
    if (!selectedProject || selectedRunning) {
      return;
    }
    const projectId = selectedProject.id;
    try {
      if (action === 'branch') {
        await createGitBranchFromDialog(selectedProject);
        return;
      }

      if (action === 'commit') {
        const data = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
        const gitStatus = data.status || {};
        if (!gitStatus.canCommit) {
          showToast({ level: 'warning', title: '提交', body: '没有可提交的改动。' });
          return;
        }
        const count = gitChangedFileCount(gitStatus);
        if (gitNeedsExplicitConfirm(gitStatus)) {
          const ok = await requestGitConfirm({
            kind: 'commit',
            title: '确认提交',
            message: `当前在 ${gitStatus.branch || '未知分支'}，工作区有 ${count} 个改动文件。确认提交整个工作区吗？`,
            confirmText: '确认提交'
          });
          if (!ok) return;
        }
        const message = await requestGitInput({
          kind: 'commit',
          title: '提交',
          label: '提交信息',
          defaultValue: gitStatus.defaultCommitMessage || '更新项目',
          confirmText: '提交'
        });
        if (!message?.trim()) return;
        showToast({ level: 'info', title: '提交', body: '正在提交 Git 改动...' });
        const result = await apiFetch('/api/git/commit', {
          method: 'POST',
          timeoutMs: 70_000,
          body: { projectId, message: message.trim() }
        });
        showToast({ level: 'success', title: '提交', body: result.hash ? `已提交 ${result.hash}` : 'Git 提交已完成。' });
        return;
      }

      if (action === 'push') {
        const data = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
        const gitStatus = data.status || {};
        if (!gitStatus.branch) {
          showToast({ level: 'warning', title: '推送', body: '当前不在有效 Git 分支上。' });
          return;
        }
        if (gitStatus.branch === 'main' || gitStatus.branch === 'master') {
          const ok = await requestGitConfirm({
            kind: 'push',
            title: '确认推送',
            message: `当前分支是 ${gitStatus.branch}，确认推送吗？`,
            confirmText: '确认推送'
          });
          if (!ok) return;
        }
        showToast({ level: 'info', title: '推送', body: '正在推送当前分支...' });
        const result = await apiFetch('/api/git/push', {
          method: 'POST',
          timeoutMs: 130_000,
          body: { projectId }
        });
        showToast({ level: 'success', title: '推送', body: result.branch ? `已推送 ${result.branch}` : 'Git 推送已完成。' });
      }
    } catch (error) {
      const title = action === 'branch' ? '创建分支' : action === 'push' ? '推送' : '提交';
      showToast({ level: 'error', title, body: error.message || 'Git 操作失败。' });
    }
  }

  const {
    handleConnectDocs,
    handleDisconnectDocs,
    handleRefreshDocs,
    handleOpenDocsHome,
    handleOpenDocsAuth
  } = useDocsActions({
    docsBusy,
    status,
    setStatus,
    setDocsBusy,
    setDocsError,
    loadStatus
  });

  const sessionLoading = Boolean(sessionLoadingId && selectedSession?.id === sessionLoadingId);
  const homeVisible = !sessionLoading && !sessionLoadError && messages.length === 0 && (!selectedSession || isDraftSession(selectedSession));
  const homePaneVisible = homeVisible || homeExiting;
  const composerGitProject = useMemo(
    () => resolveComposerGitProject({ homeVisible, projects, selectedProject, selectedSession }),
    [homeVisible, projects, selectedProject, selectedSession]
  );
  const shellClass = useMemo(() => {
    const classes = ['app-shell'];
    if (drawerOpen) {
      classes.push('drawer-active');
    }
    if (homeVisible) {
      classes.push('is-home');
    }
    if (homeExiting) {
      classes.push('is-home-exiting');
    }
    return classes.join(' ');
  }, [drawerOpen, homeExiting, homeVisible]);

  useEffect(() => {
    if (homeVisible) {
      homeWasVisibleRef.current = true;
      setHomeExiting(false);
      return undefined;
    }
    if (!homeWasVisibleRef.current) {
      return undefined;
    }
    homeWasVisibleRef.current = false;
    setHomeExiting(true);
    const timer = window.setTimeout(() => setHomeExiting(false), 280);
    return () => window.clearTimeout(timer);
  }, [homeVisible]);
  const visibleContextStatus = useMemo(
    () => {
      if (!selectedSession || isDraftSession(selectedSession)) {
        return emptyContextStatus();
      }
      return normalizeContextStatus(contextStatus || selectedSession.context || DEFAULT_STATUS.context, DEFAULT_STATUS.context);
    },
    [contextStatus, selectedSession]
  );
  const recoveryState = connectionRecoveryState({
    authenticated,
    connectionState,
    desktopBridge: status.desktopBridge,
    syncing
  });
  const topBarRuntime = selectedRuntime || (selectedRunning ? { status: 'running' } : null);
  const handleToggleDrawer = useCallback(() => {
    const desktopShell = typeof window !== 'undefined' && window.matchMedia?.(DESKTOP_SHELL_MEDIA)?.matches;
    setDrawerOpen((current) => (desktopShell ? !current : true));
  }, [setDrawerOpen]);

  const handleComposerSubmit = useCallback(async (options = {}) => {
    if ((selectedSessionRef.current || selectedSession)?.archived) {
      return;
    }
    const collaborationMode = options.collaborationMode || selectedCollaborationMode || null;
    const accepted = await handleSubmit({ ...options, collaborationMode });
    if (accepted && collaborationMode) {
      setSelectedCollaborationMode(null);
    }
  }, [handleSubmit, selectedCollaborationMode, selectedSession]);

  const handleCompactContext = useCallback(async () => {
    const project = selectedProjectRef.current || selectedProject;
    const session = selectedSessionRef.current || selectedSession;
    if (!project?.id || !session?.id || isDraftSession(session)) {
      showToast({
        level: 'warning',
        title: '无法压缩上下文',
        body: '请先打开一个已有线程。'
      });
      return false;
    }
    const actionId = globalThis.crypto?.randomUUID?.() || `manual-context-compaction-${Date.now()}`;
    const startedAt = new Date().toISOString();
    setMessages((current) => upsertActivityMessage(current, {
      projectId: project.id,
      sessionId: session.id,
      messageId: actionId,
      kind: 'context_compaction',
      status: 'running',
      label: '正在压缩上下文',
      startedAt,
      timestamp: startedAt
    }));
    showToast({
      level: 'info',
      title: '正在压缩上下文',
      body: '移动端会同步显示压缩进度。'
    });
    try {
      await apiFetch('/api/chat/compact', {
        method: 'POST',
        timeoutMs: 35_000,
        body: {
          projectId: project.id,
          sessionId: session.id,
          clientActionId: actionId
        }
      });
      const timestamp = new Date().toISOString();
      setMessages((current) => upsertActivityMessage(current, {
        projectId: project.id,
        sessionId: session.id,
        messageId: actionId,
        kind: 'context_compaction',
        status: 'completed',
        label: '上下文已压缩',
        startedAt,
        completedAt: timestamp,
        timestamp
      }));
      setContextStatus((current) => mergeContextStatus(current, {
        autoCompact: {
          detected: true,
          status: 'detected',
          lastCompactedAt: timestamp,
          reason: '手动压缩上下文'
        },
        updatedAt: timestamp
      }, DEFAULT_STATUS.context));
      showToast({
        level: 'success',
        title: '上下文已压缩',
        body: '当前线程的压缩结果已同步。'
      });
      return true;
    } catch (error) {
      const failedAt = new Date().toISOString();
      setMessages((current) => upsertActivityMessage(current, {
        projectId: project.id,
        sessionId: session.id,
        messageId: actionId,
        kind: 'context_compaction',
        status: 'failed',
        label: '上下文压缩失败',
        detail: error.message || '桌面端没有完成上下文压缩。',
        startedAt,
        completedAt: failedAt,
        timestamp: failedAt
      }));
      showToast({
        level: 'error',
        title: '压缩失败',
        body: error.message || '桌面端没有完成上下文压缩。'
      });
      return false;
    }
  }, [selectedProject, selectedSession, showToast]);

  const handleDesktopHandoff = useCallback(async () => {
    const session = selectedSessionRef.current || selectedSession;
    if (!session?.id || isDraftSession(session)) {
      showToast({
        level: 'warning',
        title: '暂时不能回到桌面',
        body: '请先打开一个已创建的对话。'
      });
      return false;
    }
    if (selectedRunning) {
      showToast({
        level: 'warning',
        title: '执行完成后再回到桌面',
        body: '当前对话还在执行中，完成后再打开桌面端更安全。'
      });
      return false;
    }
    setDesktopHandoffPending(true);
    try {
      await apiFetch('/api/desktop-handoff', {
        method: 'POST',
        timeoutMs: 12_000,
        body: { sessionId: session.id }
      });
      showToast({
        level: 'success',
        title: '已重启桌面端',
        body: 'Codex 桌面端会重新进入当前对话。'
      });
      return true;
    } catch (error) {
      showToast({
        level: 'error',
        title: '桌面端打开失败',
        body: error.message || '请确认 Mac 上已安装并可打开 Codex.app。'
      });
      return false;
    } finally {
      setDesktopHandoffPending(false);
    }
  }, [selectedSession, selectedRunning, showToast]);

  if (!authenticated) {
    return <PairingScreen pairing={status.pairing} onPaired={bootstrap} />;
  }

  const panelProps = {
    topBarProps: {
      selectedProject,
      selectedSession,
      connectionState,
      desktopBridge: status.desktopBridge,
      selectedRuntime: topBarRuntime,
      onMenu: handleToggleDrawer,
      onOpenDocs: () => setDocsOpen(true),
      onGitAction: handleGitAction,
      onDesktopHandoff: handleDesktopHandoff,
      desktopHandoffSupported: status.desktopRefresh?.supported !== false,
      desktopHandoffPending,
      notificationSupported,
      notificationEnabled,
      onEnableNotifications: enableNotifications,
      gitDisabled: !selectedProject || selectedRunning,
      homeMode: homePaneVisible
    },
    docsPanelProps: {
      open: docsOpen,
      docs: status.docs,
      busy: docsBusy,
      error: docsError,
      onClose: () => setDocsOpen(false),
      onConnect: handleConnectDocs,
      onDisconnect: handleDisconnectDocs,
      onOpenHome: handleOpenDocsHome,
      onOpenAuth: handleOpenDocsAuth,
      onRefresh: handleRefreshDocs
    },
    gitPanelProps: {
      open: gitPanel.open,
      action: gitPanel.action,
      project: selectedProject,
      onToast: showToast,
      onClose: () => setGitPanel((current) => ({ ...current, open: false }))
    },
    gitQuickDialogProps: {
      dialog: gitQuickDialog,
      onCancel: () => closeGitQuickDialog(null),
      onSubmit: closeGitQuickDialog
    },
    recoveryCardProps: {
      state: recoveryState,
      onRetry: handleRetryConnection,
      onSync: handleSync,
      onPair: handleResetPairing,
      onStatus: handleShowConnectionStatus
    },
    toastStackProps: {
      toasts,
      onDismiss: dismissToast
    },
    pwaUpdateProps: {
      available: pwaUpdate.available,
      onRefresh: pwaUpdate.refresh,
      onDismiss: pwaUpdate.dismiss
    },
    imagePreviewProps: {
      image: previewImage,
      onClose: () => setPreviewImage(null)
    }
  };
  const drawerProps = {
    open: drawerOpen,
    onClose: () => setDrawerOpen(false),
    projects,
    selectedProject,
    selectedSession,
    expandedProjectIds,
    sessionsByProject,
    loadingProjectId,
    runningById: drawerRunningById,
    threadRuntimeById,
    completedSessionIds,
    onToggleProject: handleToggleProject,
    onSelectSession: handleSelectSession,
    onRenameSession: handleRenameSession,
    onDeleteSession: handleDeleteSession,
    onNewConversation: handleNewConversation,
    onSync: handleSync,
    syncing,
    theme,
    setTheme,
    runtimeDebug: status.runtimeDebug,
    desktopRefresh: status.desktopRefresh,
    security: status.security,
    onLoggedOut: handleAuthRevoked,
    refreshStatus: loadStatus
  };
  const chatProps = {
    messages,
    selectedSession,
    loading: sessionLoading,
    loadError: sessionLoadError,
    running: selectedRunning,
    activeRuntimeStartedAt: selectedRuntime?.startedAt || selectedRuntime?.updatedAt || null,
    now: activityClockNow,
    hasMoreBefore: messagePage.hasMoreBefore,
    loadingOlder: messagePage.loadingOlder,
    onLoadOlderMessages: handleLoadOlderMessages,
    onPreviewImage: setPreviewImage,
    onDeleteMessage: handleDeleteMessage,
    onImplementPlan: selectedSessionArchived ? null : handleImplementPlan,
    onAdjustPlan: selectedSessionArchived ? null : handleAdjustPlan
  };
  const composerProps = {
    composerRef,
    input,
    setInput,
    selectedProject,
    gitProject: composerGitProject,
    selectedSession,
    onSubmit: handleComposerSubmit,
    running: selectedRunning,
    onAbort: handleAbort,
    models: status.models,
    selectedModel,
    onSelectModel: handleSelectModel,
    selectedModelSpeed,
    onSelectModelSpeed: (value) => setSelectedModelSpeed(normalizeModelSpeed(value)),
    selectedReasoningEffort,
    onSelectReasoningEffort: handleSelectReasoningEffort,
    selectedCollaborationMode,
    onSelectCollaborationMode: setSelectedCollaborationMode,
    skills: status.skills,
    selectedSkillPaths,
    onToggleSkill: toggleSelectedSkill,
    onSelectSkill: selectSkill,
    onClearSkills: clearSelectedSkills,
    permissionMode: activePermissionMode,
    onSelectPermission: handleSelectPermission,
    security: status.security,
    attachments,
    onUploadFiles: handleUploadFiles,
    onRemoveAttachment: handleRemoveAttachment,
    fileMentions,
    onAddFileMention: addFileMention,
    onRemoveFileMention: removeFileMention,
    uploading,
    contextStatus: visibleContextStatus,
    runSteerable: selectedRuntime?.steerable !== false,
    desktopBridge: status.desktopBridge,
    queueDrafts,
    onRestoreQueueDraft: restoreQueueDraft,
    onRemoveQueueDraft: removeQueueDraft,
    onSteerQueueDraft: steerQueueDraft,
    onCreateGitBranch: () => createGitBranchFromDialog(composerGitProject),
    onCompactContext: handleCompactContext,
    readOnly: selectedSessionArchived,
    readOnlyReason: '已归档线程只能查看，取消归档后才能继续对话',
    homeMode: homeVisible,
    projects,
    onSelectHomeProject: handleNewConversation
  };

  return (
    <AppShell
      shellClass={shellClass}
      panelProps={panelProps}
      drawerProps={drawerProps}
      chatProps={chatProps}
      composerProps={composerProps}
      homeVisible={homePaneVisible}
    />
  );
}
