import fs from 'node:fs/promises';
import path from 'node:path';

function isContinuationMessage(message) {
  return /^(继续|中断了|又中断了|断了|重新来|重新生成|重新发送|再来|再试一次|retry|continue)$/i.test(String(message || '').trim());
}

export function createImagePromptStore({
  statePath,
  isImageRequest,
  listProjectSessions,
  warn = (message) => console.warn(message)
}) {
  const recentPromptsByProject = new Map();

  async function load() {
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [projectId, entry] of Object.entries(parsed.projects || {})) {
        if (entry?.prompt) {
          recentPromptsByProject.set(projectId, entry.prompt);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        warn(`[image] Failed to load prompt state: ${error.message}`);
      }
    }
  }

  function persist(projectId, prompt) {
    if (!projectId || !prompt) {
      return;
    }
    fs.mkdir(path.dirname(statePath), { recursive: true })
      .then(async () => {
        let state = { version: 1, projects: {} };
        try {
          state = JSON.parse(await fs.readFile(statePath, 'utf8'));
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
        await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
      })
      .catch((error) => warn(`[image] Failed to persist prompt state: ${error.message}`));
  }

  function remember(projectId, prompt) {
    if (projectId && prompt && isImageRequest(prompt, [])) {
      recentPromptsByProject.set(projectId, prompt);
      persist(projectId, prompt);
    }
  }

  function resolveContinuation(projectId, message) {
    if (!isContinuationMessage(message)) {
      return '';
    }
    const remembered = recentPromptsByProject.get(projectId);
    if (remembered) {
      return remembered;
    }
    const sessions = listProjectSessions(projectId);
    const recentImageSession = sessions.find((session) =>
      isImageRequest(session.summary || session.title || '', [])
    );
    return recentImageSession?.summary || recentImageSession?.title || '';
  }

  return {
    load,
    remember,
    resolveContinuation
  };
}
