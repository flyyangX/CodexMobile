import { useCallback } from 'react';
import { apiFetch, clearToken } from '../api.js';
import {
  emptyContextStatus,
  isDraftSession,
  sessionMessagesApiPath
} from './session-utils.js';
import { normalizeContextStatus } from './context-status.js';

export function useAppBootstrap({
  defaultStatus,
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
}) {
  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    setStatus(data);
    setAuthenticated(Boolean(data.auth?.authenticated));
    syncActiveRunsFromStatus(data);
    return data;
  }, [setAuthenticated, setStatus, syncActiveRunsFromStatus]);

  const loadSessions = useCallback(async (project, options = true) => {
    const settings =
      typeof options === 'boolean'
        ? { chooseLatest: options, preserveSelection: false }
        : {
          chooseLatest: options?.chooseLatest ?? true,
          preserveSelection: Boolean(options?.preserveSelection),
          silent: Boolean(options?.silent)
        };
    if (!project) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setMessages([]);
      setContextStatus(emptyContextStatus());
      return;
    }
    if (!settings.silent) {
      setLoadingProjectId(project.id);
    }
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
          setContextStatus(normalizeContextStatus(refreshed.context || defaultStatus.context, defaultStatus.context));
          const messageData = await apiFetch(sessionMessagesApiPath(refreshed.id));
          if (selectedSessionRef.current?.id === refreshed.id) {
            setMessages(messageData.messages || []);
            setContextStatus(
              normalizeContextStatus(messageData.context || refreshed.context || defaultStatus.context, defaultStatus.context)
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
          setContextStatus(normalizeContextStatus(next.context || defaultStatus.context, defaultStatus.context));
          const messageData = await apiFetch(sessionMessagesApiPath(next.id));
          if (selectedSessionRef.current?.id === next.id) {
            setMessages(messageData.messages || []);
            setContextStatus(normalizeContextStatus(messageData.context || next.context || defaultStatus.context, defaultStatus.context));
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
      if (!settings.silent) {
        setLoadingProjectId((current) => (current === project.id ? null : current));
      }
    }
  }, [
    defaultStatus,
    selectedSessionRef,
    setContextStatus,
    setLoadingProjectId,
    setMessages,
    setSelectedSession,
    setSessionsByProject
  ]);

  const loadProjects = useCallback(async (options = {}) => {
    const preserveSelection = Boolean(options?.preserveSelection);
    const refreshSessions = options?.refreshSessions !== false;
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
    if (refreshSessions) {
      await loadSessions(preferred, {
        chooseLatest: !preserveSelection || !selectedSessionRef.current,
        preserveSelection,
        silent: Boolean(options?.silent)
      });
    }
  }, [loadSessions, selectedProjectRef, selectedSessionRef, setExpandedProjectIds, setProjects, setSelectedProject]);

  const bootstrap = useCallback(async () => {
    try {
      const currentStatus = await loadStatus();
      if (currentStatus.auth?.authenticated) {
        await loadProjects();
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            await loadProjects({ preserveSelection: true, refreshSessions: false });
          })
          .catch(() => null);
      }
    } catch (error) {
      if (String(error.message).includes('Pairing')) {
        clearToken();
        setAuthenticated(false);
      }
    }
  }, [loadProjects, loadStatus, setAuthenticated]);

  return {
    loadStatus,
    loadSessions,
    loadProjects,
    bootstrap
  };
}
