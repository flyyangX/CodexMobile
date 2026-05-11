import { apiFetch } from '../api.js';
import { contentWithAttachmentPreviews } from '../chat/MarkdownContent.jsx';
import { serviceTierForModelSpeed } from '../composer/composer-options.js';
import {
  dismissPlanImplementationPrompts,
  mergeLoadedMessagesPreservingActivity,
  upsertStatusMessage
} from '../chat/activity-model.js';
import { mergeContextStatus } from './context-status.js';
import {
  autoTitlePatch,
  createClientTurnId,
  createDraftSession,
  hasVisibleAssistantForTurn,
  isDraftSession,
  sessionMessagesApiPath,
  titleFromFirstMessage
} from './session-utils.js';
import {
  displayMessageForTurn,
  completeLocalAbortMessages,
  implementationPromptForPlan,
  localHandoffStatusPayload,
  prepareComposerSubmission,
  projectForTurnSelection,
  realSessionIdFromTurn,
  restoredComposerText,
  sessionForTurnSelection,
  selectedSkillsForPaths,
  shouldPollTurnEndpointAfterSend,
  turnMatchesSelection,
  userMessageMetadataForSendMode
} from './turn-submission-utils.js';

export function useTurnSubmission({
  defaultStatus,
  defaultReasoningEffort,
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
  onPermissionModeRejected = () => {}
}) {
  function applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId) {
    const realSessionId = realSessionIdFromTurn(turn);
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

    if (turnMatchesSelection(currentSession, { turnId: turn.turnId, optimisticSessionId, realSessionId, previousSessionId })) {
      selectedSessionRef.current = nextSession;
    }
    setSelectedSession((current) => {
      if (!current) {
        return nextSession;
      }
      if (!turnMatchesSelection(current, { turnId: turn.turnId, optimisticSessionId, realSessionId, previousSessionId })) {
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
      setContextStatus((currentContext) => mergeContextStatus(currentContext, data.context || defaultStatus.context, defaultStatus.context));
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
            setContextStatus((current) => mergeContextStatus(current, turn.context, defaultStatus.context));
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

  function restoreTextToInput(text) {
    setInput((current) => restoredComposerText(current, text));
  }

  async function submitCodexMessage({
    message,
    attachmentsForTurn = [],
    fileMentionsForTurn = [],
    clearComposer = false,
    restoreTextOnError = false,
    sendMode = 'start',
    collaborationMode = null,
    visibleMessageOverride = null,
    codexMessageOverride = null
  }) {
    const project = projectForTurnSelection(selectedProject, selectedProjectRef, selectedSession, selectedSessionRef, projects);
    const selectedAttachments = Array.isArray(attachmentsForTurn) ? attachmentsForTurn : [];
    const selectedFileMentions = Array.isArray(fileMentionsForTurn) ? fileMentionsForTurn : [];
    const displayMessage = displayMessageForTurn(visibleMessageOverride ?? message, selectedAttachments, selectedFileMentions);
    const requestMessage = String(codexMessageOverride || displayMessage || '').trim();
    if ((!displayMessage && !selectedAttachments.length && !selectedFileMentions.length) || !project) {
      if (restoreTextOnError && displayMessage) {
        restoreTextToInput(displayMessage);
      }
      throw new Error(project ? 'message or attachments are required' : '请先选择项目');
    }

    let sessionForTurn = sessionForTurnSelection(selectedSession, selectedSessionRef);
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(project);
      selectedSessionRef.current = sessionForTurn;
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
    const optimisticSessionPatch = { turnId, ...autoTitlePatch(initialTitle) };
    selectedSessionRef.current = { ...sessionForTurn, ...optimisticSessionPatch };
    setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, ...optimisticSessionPatch }
        : current
    );
    setSessionsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] || []).map((item) =>
        item.id === sessionForTurn.id
          ? { ...item, ...optimisticSessionPatch }
          : item
      )
    }));
    const submittedAt = new Date().toISOString();
    const localUserMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: optimisticContent,
      ...userMessageMetadataForSendMode(sendMode),
      timestamp: submittedAt,
      sessionId: optimisticSessionId,
      turnId
    };
    setMessages((current) => {
      const next = [...current, localUserMessage];
      if (!draftSessionId || outgoingSessionId) {
        return next;
      }
      return upsertStatusMessage(next, localHandoffStatusPayload({
        sessionId: optimisticSessionId,
        previousSessionId: draftSessionId,
        turnId,
        timestamp: submittedAt
      }));
    });

    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: project.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          message: requestMessage,
          visibleMessage: displayMessage,
          permissionMode,
          model: selectedModel || status.model,
          serviceTier: serviceTierForModelSpeed(selectedModelSpeed),
          reasoningEffort: selectedReasoningEffort || status.reasoningEffort || defaultReasoningEffort,
          selectedSkills: selectedSkillsForPaths(status.skills, selectedSkillPaths),
          attachments: selectedAttachments,
          fileMentions: selectedFileMentions,
          sendMode,
          collaborationMode
        }
      });
      const resultTurnId = result.turnId || turnId;
      const resultSessionId = result.sessionId || optimisticSessionId;
      const resultBridgeMode = result.desktopBridge?.mode || null;
      const resultRuntimeSource =
        resultBridgeMode === 'desktop-ipc'
          ? 'desktop-ipc'
          : resultBridgeMode === 'headless-local'
            ? 'headless-local'
            : null;
      if (resultTurnId !== turnId || resultSessionId !== optimisticSessionId || resultRuntimeSource) {
        markRun({
          turnId: resultTurnId,
          sessionId: resultSessionId,
          previousSessionId: draftSessionId || outgoingSessionId,
          clientTurnId: turnId,
          source: resultRuntimeSource,
          steerable: resultBridgeMode === 'desktop-ipc' ? false : undefined
        });
      }
      if (shouldPollTurnEndpointAfterSend(result)) {
        pollTurnUntilComplete({
          turnId: resultTurnId,
          optimisticSessionId,
          projectId: project.id,
          previousSessionId: draftSessionId || outgoingSessionId
        });
      }
      return {
        turnId: resultTurnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      };
    } catch (error) {
      clearRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
      if (error?.code === 'CODEXMOBILE_DANGER_FULL_ACCESS_DISABLED') {
        onPermissionModeRejected();
      }
      if (clearComposer) {
        setAttachments(selectedAttachments);
        setFileMentions(selectedFileMentions);
        if (String(message || '').trim()) {
          setInput(String(message).trim());
        }
      }
      if (restoreTextOnError) {
        restoreTextToInput(displayMessage);
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
    const currentSession = selectedSessionRef.current;
    const abortId =
      currentSession?.turnId ||
      currentSession?.id ||
      Object.keys(runningByIdRef.current || runningById)[0];
    if (!abortId) {
      return false;
    }
    const completedAt = new Date().toISOString();
    const abortPayload = {
      sessionId: currentSession?.id || abortId,
      turnId: currentSession?.turnId || null,
      previousSessionId: currentSession?.previousSessionId || null,
      completedAt,
      timestamp: completedAt
    };
    try {
      await apiFetch('/api/chat/abort', {
        method: 'POST',
        body: { sessionId: currentSession?.id || abortId, turnId: currentSession?.turnId || null }
      });
    } catch (error) {
      setMessages((current) =>
        upsertStatusMessage(current, {
          ...abortPayload,
          kind: 'turn',
          status: 'failed',
          label: '中止失败',
          detail: error.message || '桌面端没有确认中止，请在电脑端查看。',
          timestamp: new Date().toISOString()
        })
      );
      return false;
    }
    clearRun(abortPayload);
    setMessages((current) => completeLocalAbortMessages(current, abortPayload));
    return true;
  }

  async function handleSubmit({ mode = 'start' } = {}) {
    const prepared = prepareComposerSubmission(input, attachments, fileMentions);
    const project = projectForTurnSelection(selectedProject, selectedProjectRef, selectedSession, selectedSessionRef, projects);
    if ((!prepared.message && !attachments.length && !fileMentions.length) || !project) {
      return;
    }
    try {
      await submitCodexMessage({
        message: prepared.message,
        attachmentsForTurn: attachments,
        fileMentionsForTurn: fileMentions,
        clearComposer: true,
        sendMode: mode === 'guide' ? 'interrupt' : mode,
        collaborationMode: prepared.collaborationMode
      });
      await loadQueueDrafts(selectedSessionRef.current);
    } catch {
      // submitCodexMessage already reflects the failure in the chat UI.
    }
  }

  async function handleAbort() {
    await abortCurrentRun();
  }

  async function handleImplementPlan(planImplementation) {
    const planContent = String(planImplementation?.planContent || '').trim();
    const prompt = implementationPromptForPlan(planContent);
    if (!prompt) {
      return false;
    }
    try {
      await submitCodexMessage({
        message: '执行计划',
        visibleMessageOverride: '执行计划',
        codexMessageOverride: prompt,
        clearComposer: false,
        sendMode: 'start',
        collaborationMode: null
      });
      const requestId = String(planImplementation?.requestId || '').trim();
      const requestTurnId = String(planImplementation?.turnId || '').trim();
      setMessages((current) =>
        dismissPlanImplementationPrompts(current, {
          ...planImplementation,
          requestId,
          turnId: requestTurnId
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async function handleAdjustPlan(message, planImplementation = null) {
    const text = String(message || '').trim();
    if (!text) {
      return false;
    }
    try {
      await submitCodexMessage({
        message: text,
        clearComposer: false,
        sendMode: 'start',
        collaborationMode: null
      });
      if (planImplementation) {
        setMessages((current) => dismissPlanImplementationPrompts(current, planImplementation));
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    submitCodexMessage,
    handleSubmit,
    handleImplementPlan,
    handleAdjustPlan,
    handleAbort,
    abortCurrentRun,
    pollTurnUntilComplete
  };
}
