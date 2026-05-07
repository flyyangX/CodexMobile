import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { apiFetch, getToken } from '../api.js';
import { desktopBridgeCanCreateThread } from '../send-state.js';
import { DEFAULT_PERMISSION_MODE } from '../composer/Composer.jsx';
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
import {
  buildComposerRunStatus,
  emptyContextStatus,
  hasRunningKey,
  isDraftSession,
  selectedRunKeys,
  upsertSessionInProject
} from './session-utils.js';
import { AppShell } from './AppShell.jsx';
import PairingScreen from './PairingScreen.jsx';

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
  const [activityClockNow, setActivityClockNow] = useState(() => Date.now());
  const [completedSessionIds, setCompletedSessionIds] = useState({});
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
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
  const bootstrapStartedRef = useRef(false);
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

  useViewportSizing();

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

  const {
    markRun,
    clearRun,
    markSessionCompleteNotice,
    clearSessionCompleteNotice,
    syncActiveRunsFromStatus,
    payloadMatchesCurrentConversation,
    rememberDesktopIpcPendingRun,
    completeDesktopIpcPendingRun,
    markTurnCompleted,
    scheduleTurnRefresh
  } = useTurnRuntime({
    defaultStatus: DEFAULT_STATUS,
    activePollsRef,
    turnRefreshTimersRef,
    desktopIpcPendingRunsRef,
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
    messagesRef.current = messages;
  }, [messages]);

  useSessionLivePolling({
    authenticated,
    selectedSession,
    hasRunningActivity,
    running,
    desktopBridge: status.desktopBridge,
    defaultStatus: DEFAULT_STATUS,
    sessionLivePollRef,
    selectedSessionRef,
    runningByIdRef,
    desktopIpcPendingRunsRef,
    messagesRef,
    setContextStatus,
    setMessages,
    completeDesktopIpcPendingRun
  });

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
    bootstrap();
  }, [bootstrap]);

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
    loadSessions
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
    handleAbort
  } = useTurnSubmission({
    defaultStatus: DEFAULT_STATUS,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    selectedProject,
    selectedProjectRef,
    selectedSession,
    selectedSessionRef,
    selectedSkillPaths,
    status,
    permissionMode,
    selectedModel,
    selectedReasoningEffort,
    input,
    attachments,
    fileMentions,
    activePollsRef,
    desktopIpcPendingRunsRef,
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
    rememberDesktopIpcPendingRun
  });

  async function handleGitAction(action) {
    if (!selectedProject || running) {
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
  const canCreateThreadFromMobile = desktopBridgeCanCreateThread(status.desktopBridge);
  const createThreadUnavailableReason =
    status.desktopBridge?.capabilities?.createThreadReason ||
    '当前桌面端还没有开放从手机新建同源对话的入口';
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
    <AppShell
      shellClass={shellClass}
      status={status}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      connectionState={connectionState}
      running={running}
      drawerOpen={drawerOpen}
      docsOpen={docsOpen}
      docsBusy={docsBusy}
      docsError={docsError}
      gitPanel={gitPanel}
      theme={theme}
      projects={projects}
      expandedProjectIds={expandedProjectIds}
      sessionsByProject={sessionsByProject}
      loadingProjectId={loadingProjectId}
      runningById={runningById}
      threadRuntimeById={threadRuntimeById}
      completedSessionIds={completedSessionIds}
      syncing={syncing}
      canCreateThreadFromMobile={canCreateThreadFromMobile}
      createThreadUnavailableReason={createThreadUnavailableReason}
      recoveryState={recoveryState}
      toasts={toasts}
      messages={messages}
      activityClockNow={activityClockNow}
      input={input}
      setInput={setInput}
      selectedModel={selectedModel}
      setSelectedModel={setSelectedModel}
      selectedReasoningEffort={selectedReasoningEffort}
      setSelectedReasoningEffort={setSelectedReasoningEffort}
      selectedSkillPaths={selectedSkillPaths}
      permissionMode={permissionMode}
      setPermissionMode={setPermissionMode}
      attachments={attachments}
      fileMentions={fileMentions}
      uploading={uploading}
      visibleContextStatus={visibleContextStatus}
      composerRunStatus={composerRunStatus}
      selectedRuntime={selectedRuntime}
      queueDrafts={queueDrafts}
      previewImage={previewImage}
      notificationSupported={notificationSupported}
      notificationEnabled={notificationEnabled}
      enableNotifications={enableNotifications}
      dismissToast={dismissToast}
      showToast={showToast}
      setDrawerOpen={setDrawerOpen}
      setDocsOpen={setDocsOpen}
      setGitPanel={setGitPanel}
      setTheme={setTheme}
      setPreviewImage={setPreviewImage}
      toggleSelectedSkill={toggleSelectedSkill}
      selectSkill={selectSkill}
      clearSelectedSkills={clearSelectedSkills}
      addFileMention={addFileMention}
      removeFileMention={removeFileMention}
      restoreQueueDraft={restoreQueueDraft}
      removeQueueDraft={removeQueueDraft}
      steerQueueDraft={steerQueueDraft}
      handleGitAction={handleGitAction}
      handleToggleProject={handleToggleProject}
      handleSelectSession={handleSelectSession}
      handleRenameSession={handleRenameSession}
      handleDeleteSession={handleDeleteSession}
      handleNewConversation={handleNewConversation}
      handleSync={handleSync}
      handleConnectDocs={handleConnectDocs}
      handleDisconnectDocs={handleDisconnectDocs}
      handleOpenDocsHome={handleOpenDocsHome}
      handleOpenDocsAuth={handleOpenDocsAuth}
      handleRefreshDocs={handleRefreshDocs}
      handleRetryConnection={handleRetryConnection}
      handleResetPairing={handleResetPairing}
      handleShowConnectionStatus={handleShowConnectionStatus}
      handleDeleteMessage={handleDeleteMessage}
      handleSubmit={handleSubmit}
      handleAbort={handleAbort}
      handleUploadFiles={handleUploadFiles}
      handleRemoveAttachment={handleRemoveAttachment}
    />
  );
}
