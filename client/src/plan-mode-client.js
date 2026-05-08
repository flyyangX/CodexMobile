import { collaborationModeForComposer } from '../../shared/collaboration-mode.js';

export function buildClientCollaborationMode({
  composerMode = 'chat',
  sendMode = 'start',
  model = '',
  reasoningEffort = ''
} = {}) {
  if (sendMode === 'steer') {
    return null;
  }
  return collaborationModeForComposer({ composerMode, model, reasoningEffort });
}
