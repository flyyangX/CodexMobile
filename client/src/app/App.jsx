import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { apiFetch } from '../api.js';
import { DEFAULT_PERMISSION_MODE } from '../composer/Composer.jsx';
import { DEFAULT_MODEL_SPEED, normalizeModelSpeed, permissionModeForSecurity } from '../composer/composer-options.js';
import { useComposerSelections } from '../composer/useComposerSelections.js';
import { useQueueDrafts } from '../composer/useQueueDrafts.js';
import { connectionRecoveryState } from '../connection-recovery.js';
import { normalizeContextStatus } from './context-status.js';
import { DEFAULT_REASONING_EFFORT, DEFAULT_STATUS, REASONING_DEFAULT_VERSION } from './defaults.js';
import { appReducer, createInitialUiState, THEME_KEY } from './AppState.js';
import { useNotifications } from '../panels/useNotifications.js';
import { useAppBootstrap } from './useAppBootstrap.js';
import { useConnectionActions } from './useConnectionActions.js';
import { useDocsActions } from './useDocsActions.js';
import { useFileUploads } from './useFileUploads.js';
import { useAppWebSocket } from './useAppWebSocket.js';
import { useSessionLivePolling } from './useSessionLivePolling.js';
import { useSessionActions } from './useSessionActions.js';
import { useTurnSubmission } from './useTurnSubmission.js';
import { useTurnRuntime } from './useTurnRuntime.js';
import { useViewportSizing } from './useViewportSizing.js';
import { applyPwaTheme } from './pwa-theme.js';
import { nextSyncedComposerSettings } from './model-sync.js';
import { rememberSelectedSession } from './selection-persistence.js';
import {
  buildComposerRunStatus,
  emptyContextStatus,
  hasRunningKey,
  isDraftSession,
  isLiveThreadRuntime,
  reconcileThreadRuntimeWithSessions,
  runningByIdWithSelectedActivity,
  selectedRunKeys,
  selectedSessionIsRunning,
  upsertSessionInProject
} from './session-utils.js';
import { AppShell } from './AppShell.jsx';
import PairingScreen from './PairingScreen.jsx';

const MODEL_SPEED_KEY = 'codexmobile.modelSpeed';

export default function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [contextStatus, setContextStatus] = useState(() => normalizeContextStatus(DEFAULT_STATUS.context));
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [uiState, dispatchUi] = useReducer(appReducer, undefined, () => createInitialUiState());
  const setDrawerOpen = useCallback((value) => dispatchUi({ type: 'ui/drawerOpen', value }), []);
  const setPreviewImage = useCallback((value) => dispatchUi({ type: 'ui/previewImage', value }), []);
  const setDocsOpen = useCallback((value) => dispatchUi({ type: 'ui/docsOpen', value }), []);
  const setDocsBusy = useCallback((value) => dispatchUi({ type: 'ui/docsBusy', value }), []);
  const setDocsError = useCallback((value) => dispatchUi({ type: 'ui/docsError', value }), []);
  const setGitPanel = useCallback((value) => dispatchUi({ type: 'ui/gitPanel', value }), []);
  const setTheme = useCallback((value) => dispatchUi({ type: 'ui/theme', value }), []);
  const { drawerOpen, previewImage, docsOpen, docsBusy, docsError, gitPanel, theme } = uiState;
  const [drawerRequestedView, setDrawerRequestedView] = useState('main');
  const {
    toasts,
    notificationSupported,
    notificationEnabled,
    dismissToast,
    showToast,
    notifyFromPayload,
    enableNotifications
  } = useNotifications();
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sessionLoadingId, setSessionLoadingId] = useState(null);
  const [sessionLoadError, setSessionLoadError] = useState('');
  const [activityClockNow, setActivityClockNow] = useState(() => Date.now());
  const [completedSessionIds, setCompletedSessionIds] = useState({});
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_STATUS.model);
  const [selectedModelSpeed, setSelectedModelSpeed] = useState(() => normalizeModelSpeed(localStorage.getItem(MODEL_SPEED_KEY)));
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
  const [connectionState, setConnectionState] = useState('disconnected');
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const messagesRef = useRef([]);
  const autoTitleSyncRef = useRef(new Set());
  const runningByIdRef = useRef({});
  const activePollsRef = useRef(new Set());
  const turnRefreshTimersRef = useRef(new Map());
  const lastStatusSettingsRef = useRef({
    model: DEFAULT_STATUS.model,
    reasoningEffort: DEFAULT_STATUS.reasoningEffort || DEFAULT_REASONING_EFFORT
  });
  const sessionLivePollRef = useRef(false);
  const bootstrapStartedRef = useRef(false);
  const drawerSyncAtRef = useRef(0);
  const composerRef = useRef(null);
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

  useViewportSizing(composerRef, { enabled: authenticated });

  const selectedRuntime = selectedRunKeys(selectedSession)
    .map((key) => threadRuntimeById[key])
    .find(isLiveThreadRuntime) || null;
  const running =
    hasRunningKey(runningById, selectedRunKeys(selectedSession)) ||
    selectedRuntime?.status === 'running';
  const hasRunningActivity = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === 'activity' &&
          (message.status === 'running' || message.status === 'queued')
      ),
    [messages]
  );
  const selectedRunning = selectedSessionIsRunning({ running, hasRunningActivity });
  const drawerRunningById = useMemo(
    () => runningByIdWithSelectedActivity(runningById, selectedSession, hasRunningActivity),
    [runningById, selectedSession, hasRunningActivity]
  );
  const composerRunStatus = useMemo(
    () => buildComposerRunStatus(messages, selectedRunning, activityClockNow),
    [messages, selectedRunning, activityClockNow]
  );

  useEffect(() => {
    loadQueueDrafts(selectedSession).catch(() => null);
  }, [selectedSession?.id]);

  useEffect(() => {
    const normalizedPermissionMode = permissionModeForSecurity(permissionMode, status.security || DEFAULT_STATUS.security);
    if (normalizedPermissionMode !== permissionMode) {
      setPermissionMode(normalizedPermissionMode);
    }
  }, [permissionMode, status.security?.dangerFullAccessEnabled]);

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
    syncActiveRunsFromStatus,
    payloadMatchesCurrentConversation,
    markTurnCompleted,
    scheduleTurnRefresh
  } = useTurnRuntime({
    defaultStatus: DEFAULT_STATUS,
    activePollsRef,
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
    hasRunningActivity,
    running,
    desktopBridge: status.desktopBridge,
    threadRuntimeById,
    defaultStatus: DEFAULT_STATUS,
    sessionLivePollRef,
    selectedSessionRef,
    runningByIdRef,
    messagesRef,
    markRun,
    clearRun,
    markSessionCompleteNotice,
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
    document.documentElement.dataset.codexRoute = !authChecked || !authenticated ? 'pairing' : 'app';
    return () => {
      delete document.documentElement.dataset.codexRoute;
    };
  }, [authChecked, authenticated]);

  useEffect(() => {
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

  const openDrawerMain = useCallback(() => {
    setDrawerRequestedView('main');
    setDrawerOpen(true);
  }, [setDrawerOpen]);

  const openSecuritySettings = useCallback(() => {
    setDrawerRequestedView('settings');
    setDrawerOpen(true);
  }, [setDrawerOpen]);

  useEffect(() => {
    if (!authChecked || !authenticated || window.location.pathname !== '/security') {
      return;
    }
    openSecuritySettings();
    window.history.replaceState({}, '', '/');
  }, [authChecked, authenticated, openSecuritySettings]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, [setDrawerOpen]);

  const handleSecurityLoggedOut = useCallback(() => {
    setAuthenticated(false);
    setConnectionState('disconnected');
    setDrawerRequestedView('main');
    setDrawerOpen(false);
  }, [setDrawerOpen]);

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
    syncActiveRunsFromStatus,
    setSelectedSession,
    setMessages,
    setContextStatus,
    setLoadingProjectId,
    setSessionsByProject,
    setProjects,
    setSelectedProject,
    setExpandedProjectIds
  });

  useEffect(() => {
    if (bootstrapStartedRef.current) {
      return;
    }
    bootstrapStartedRef.current = true;
    bootstrap().finally(() => setAuthChecked(true));
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
    handleRenameSession,
    handleDeleteSession,
    handleDeleteMessage,
    handleNewConversation,
    applyAutoSessionTitle
  } = useSessionActions({
    defaultStatus: DEFAULT_STATUS,
    status,
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
    authenticated,
    defaultStatus: DEFAULT_STATUS,
    wsRef,
    selectedProjectRef,
    selectedSessionRef,
    setConnectionState,
    setStatus,
    syncActiveRunsFromStatus,
    markRun,
    clearRun,
    markSessionCompleteNotice,
    markTurnCompleted,
    scheduleTurnRefresh,
    payloadMatchesCurrentConversation,
    upsertSessionInProject,
    setSelectedSession,
    setSessionsByProject,
    setMessages,
    setContextStatus,
    applyAutoSessionTitle,
    notifyFromPayload,
    loadQueueDrafts,
    setProjects,
    setSelectedProject,
    setExpandedProjectIds,
    loadSessions,
    onAuthenticationRevoked: handleSecurityLoggedOut
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
    defaultStatus: DEFAULT_STATUS,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    selectedProject,
    selectedProjectRef,
    selectedSession,
    selectedSessionRef,
    projects,
    selectedSkillPaths,
    status,
    permissionMode,
    selectedModel,
    selectedModelSpeed,
    selectedReasoningEffort,
    input,
    attachments,
    fileMentions,
    activePollsRef,
    runningById,
    runningByIdRef,
    setInput,
    setAttachments,
    setFileMentions,
    setSelectedSession,
    setExpandedProjectIds,
    setSessionsByProject,
    setMessages,
    setContextStatus,
    upsertSessionInProject,
    markRun,
    clearRun,
    markSessionCompleteNotice,
    markTurnCompleted,
    scheduleTurnRefresh,
    loadQueueDrafts,
    onPermissionModeRejected: () => setPermissionMode(DEFAULT_PERMISSION_MODE)
  });

  async function handleGitAction(action) {
    if (!selectedProject || selectedRunning) {
      return;
    }
    setGitPanel({ open: true, action });
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
  const recoveryState = connectionRecoveryState({
    authenticated,
    connectionState,
    desktopBridge: status.desktopBridge,
    syncing
  });
  const topBarRuntime = selectedRuntime || (selectedRunning ? { status: 'running' } : null);

  if (!authChecked) {
    return (
      <main className="pairing-screen">
        <div className="pairing-mark">
          <span className="pairing-loading-dot" />
        </div>
        <h1>CodexMobile</h1>
        <p className="pairing-lead">正在确认当前设备授权...</p>
      </main>
    );
  }

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} canPair={status.auth?.canPair !== false} />;
  }

  const sessionLoading = Boolean(sessionLoadingId && selectedSession?.id === sessionLoadingId);
  const composerRunStatusForShell = composerRunStatus
    ? { ...composerRunStatus, steerable: selectedRuntime?.steerable !== false }
    : null;
  const panelProps = {
    topBarProps: {
      selectedProject,
      selectedSession,
      connectionState,
      desktopBridge: status.desktopBridge,
      selectedRuntime: topBarRuntime,
      onMenu: openDrawerMain,
      onOpenDocs: () => setDocsOpen(true),
      onOpenSecurity: openSecuritySettings,
      onGitAction: handleGitAction,
      notificationSupported,
      notificationEnabled,
      onEnableNotifications: enableNotifications,
      gitDisabled: !selectedProject || selectedRunning
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
    imagePreviewProps: {
      image: previewImage,
      onClose: () => setPreviewImage(null)
    }
  };
  const drawerProps = {
    open: drawerOpen,
    onClose: closeDrawer,
    requestedView: drawerRequestedView,
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
    onLoggedOut: handleSecurityLoggedOut
  };
  const chatProps = {
    messages,
    selectedSession,
    loading: sessionLoading,
    loadError: sessionLoadError,
    running: selectedRunning,
    now: activityClockNow,
    onPreviewImage: setPreviewImage,
    onDeleteMessage: handleDeleteMessage,
    onImplementPlan: handleImplementPlan,
    onAdjustPlan: handleAdjustPlan
  };
  const composerProps = {
    composerRef,
    input,
    setInput,
    selectedProject,
    selectedSession,
    onSubmit: handleSubmit,
    running: selectedRunning,
    onAbort: handleAbort,
    models: status.models,
    selectedModel,
    onSelectModel: setSelectedModel,
    selectedModelSpeed,
    onSelectModelSpeed: (value) => setSelectedModelSpeed(normalizeModelSpeed(value)),
    selectedReasoningEffort,
    onSelectReasoningEffort: setSelectedReasoningEffort,
    skills: status.skills,
    selectedSkillPaths,
    onToggleSkill: toggleSelectedSkill,
    onSelectSkill: selectSkill,
    onClearSkills: clearSelectedSkills,
    permissionMode,
    onSelectPermission: setPermissionMode,
    attachments,
    onUploadFiles: handleUploadFiles,
    onRemoveAttachment: handleRemoveAttachment,
    fileMentions,
    onAddFileMention: addFileMention,
    onRemoveFileMention: removeFileMention,
    uploading,
    contextStatus: visibleContextStatus,
    runStatus: composerRunStatusForShell,
    desktopBridge: status.desktopBridge,
    security: status.security || DEFAULT_STATUS.security,
    queueDrafts,
    onRestoreQueueDraft: restoreQueueDraft,
    onRemoveQueueDraft: removeQueueDraft,
    onSteerQueueDraft: steerQueueDraft
  };

  return (
    <AppShell
      shellClass={shellClass}
      panelProps={panelProps}
      drawerProps={drawerProps}
      chatProps={chatProps}
      composerProps={composerProps}
    />
  );
}
