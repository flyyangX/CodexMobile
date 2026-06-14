/**
 * 聊天中的「生图回合」分支：续画检测、runImageTurn 编排与状态回填。
 *
 * Keywords: chat-image, image-turn, dalle, attachments
 *
 * Exports:
 * - createChatImageHandler — 返回图片处理钩子集合。
 *
 * Inward（本模块依赖/组装的关键符号）: Node fs/crypto/path；注入 runImageTurn、isImageRequest、broadcast。
 *
 * Outward（谁在用/调用场景）: chat-service。
 *
 * 不负责: 底层 image-generator HTTP/CLI（由注入方实现）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSyncEventPayload } from './sync/sync-events.js';

function isContinuationMessage(message) {
  return /^(继续|中断了|又中断了|断了|重新来|重新生成|重新发送|再来|再试一次|retry|continue)$/i.test(String(message || '').trim());
}

export function createChatImageHandler({
  imagePromptState,
  runImageTurn,
  isImageRequest,
  listProjectSessions,
  refreshCodexCache,
  broadcast,
  rememberTurn,
  emitJobEvent
}) {
  const recentImagePromptsByProject = new Map();
  const activeImageRuns = new Map();

  function getActiveImageRuns() {
    return [...activeImageRuns.values()].map((run) => ({
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId,
      startedAt: run.startedAt,
      status: run.status,
      turnId: run.turnId,
      kind: 'image_generation_call',
      label: run.label
    }));
  }

  async function loadRecentImagePrompts() {
    try {
      const raw = await fs.readFile(imagePromptState, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [projectId, entry] of Object.entries(parsed.projects || {})) {
        if (entry?.prompt) {
          recentImagePromptsByProject.set(projectId, entry.prompt);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[image] Failed to load prompt state:', error.message);
      }
    }
  }

  function persistRecentImagePrompt(projectId, prompt) {
    if (!projectId || !prompt) {
      return;
    }
    fs.mkdir(path.dirname(imagePromptState), { recursive: true })
      .then(async () => {
        let state = { version: 1, projects: {} };
        try {
          state = JSON.parse(await fs.readFile(imagePromptState, 'utf8'));
        } catch {
          // Start a fresh state file.
        }
        state.version = 1;
        state.projects = {
          ...(state.projects || {}),
          [projectId]: {
            prompt,
            updatedAt: new Date().toISOString()
          }
        };
        await fs.writeFile(imagePromptState, JSON.stringify(state, null, 2), 'utf8');
      })
      .catch((error) => console.warn('[image] Failed to persist prompt state:', error.message));
  }

  function rememberImagePrompt(projectId, prompt) {
    if (projectId && prompt && isImageRequest(prompt, [])) {
      recentImagePromptsByProject.set(projectId, prompt);
      persistRecentImagePrompt(projectId, prompt);
    }
  }

  function resolveContinuationImagePrompt(projectId, message) {
    if (!isContinuationMessage(message)) {
      return '';
    }
    const remembered = recentImagePromptsByProject.get(projectId);
    if (remembered) {
      return remembered;
    }
    const sessions = listProjectSessions(projectId);
    const recentImageSession = sessions.find((session) =>
      isImageRequest(session.summary || session.title || '', [])
    );
    return recentImageSession?.summary || recentImageSession?.title || '';
  }

  function resolveImagePrompt({ enabled, projectId, displayMessage, attachments }) {
    if (!enabled) {
      return null;
    }
    return isImageRequest(displayMessage, attachments)
      ? displayMessage
      : resolveContinuationImagePrompt(projectId, displayMessage);
  }

  function startImageChat({
    project,
    selectedSessionId,
    conversationSessionId,
    draftSessionId,
    turnId,
    imagePrompt,
    attachments,
    config,
    bridge
  }) {
    rememberImagePrompt(project.id, imagePrompt);
    const imageSessionId = selectedSessionId || `mobile-image-${crypto.randomUUID()}`;
    const previousSessionId = imageSessionId === conversationSessionId ? draftSessionId : conversationSessionId;
    const imageLabel = attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片';
    activeImageRuns.set(turnId, {
      turnId,
      sessionId: imageSessionId,
      previousSessionId,
      startedAt: new Date().toISOString(),
      status: 'running',
      label: imageLabel
    });
    console.log(`[chat] accepted image turn=${turnId} session=${imageSessionId} project=${project.name}`);
    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: imageSessionId,
      previousSessionId,
      status: 'running',
      kind: 'image_generation_call',
      label: imageLabel
    });
    runImageTurn(
      {
        sessionId: imageSessionId,
        previousSessionId,
        projectPath: project.path,
        projectless: project.projectless,
        message: imagePrompt,
        attachments,
        config,
        turnId,
        persistMobileSession: true
      },
      (payload) => {
        const event = payload?.type === 'sync-event' ? payload.event : null;
        const payloadTurnId = event?.turnId || event?.clientTurnId;
        if (payloadTurnId && activeImageRuns.has(payloadTurnId)) {
          const existing = activeImageRuns.get(payloadTurnId);
          activeImageRuns.set(payloadTurnId, {
            ...existing,
            sessionId: event.sessionId || existing.sessionId,
            previousSessionId: event.previousSessionId || existing.previousSessionId,
            status: event.status || event.activity?.status || existing.status,
            label: event.label || event.activity?.label || existing.label
          });
        }
        emitJobEvent({ project }, payload);
      }
    ).then(async (finalSessionId) => {
      rememberTurn(turnId, {
        projectId: project.id,
        sessionId: finalSessionId,
        previousSessionId
      });
      try {
        const snapshot = await refreshCodexCache();
        broadcast(createSyncEventPayload('sessions.synced', {
          source: 'image-generator',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }, {
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects
        }));
      } catch (error) {
        console.warn('[sync] Failed to refresh after image chat:', error.message);
      }
    }).catch((error) => {
      const errorMessage = error?.message || '图片生成失败';
      activeImageRuns.delete(turnId);
      rememberTurn(turnId, {
        projectId: project.id,
        sessionId: imageSessionId,
        previousSessionId,
        status: 'failed',
        error: errorMessage,
        label: '图片生成失败'
      });
      emitJobEvent({ project }, createSyncEventPayload('turn.failed', {
        sessionId: imageSessionId,
        previousSessionId,
        turnId,
        error: errorMessage,
        detail: errorMessage,
        status: 'failed'
      }));
    }).finally(() => {
      activeImageRuns.delete(turnId);
    });
    return {
      accepted: true,
      queued: false,
      sessionId: imageSessionId,
      draftSessionId,
      turnId,
      mode: 'image',
      delivery: 'started',
      desktopBridge: bridge
    };
  }

  return {
    getActiveImageRuns,
    loadRecentImagePrompts,
    resolveImagePrompt,
    startImageChat
  };
}
