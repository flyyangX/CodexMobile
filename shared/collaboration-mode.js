const VALID_COLLABORATION_MODES = new Set(['plan', 'default']);
const VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function normalizeComposerMode(value) {
  return String(value || '').trim().toLowerCase() === 'plan' ? 'plan' : 'chat';
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').trim();
  return VALID_REASONING_EFFORTS.has(effort) ? effort : null;
}

export function normalizeCollaborationMode(value, {
  model = '',
  reasoningEffort = ''
} = {}) {
  if (!value) {
    return null;
  }
  const mode = String(value.mode || '').trim();
  if (!VALID_COLLABORATION_MODES.has(mode)) {
    throw new Error(`Unsupported collaboration mode: ${mode || 'empty'}`);
  }
  if (mode === 'default') {
    return null;
  }
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : {};
  const selectedModel = String(settings.model || model || '').trim();
  if (!selectedModel) {
    throw new Error('Plan mode requires a model');
  }
  return {
    mode: 'plan',
    settings: {
      model: selectedModel,
      reasoning_effort: normalizeReasoningEffort(settings.reasoning_effort || reasoningEffort),
      developer_instructions: null
    }
  };
}

export function collaborationModeForComposer({
  composerMode = 'chat',
  model = '',
  reasoningEffort = ''
} = {}) {
  if (normalizeComposerMode(composerMode) !== 'plan') {
    return null;
  }
  return normalizeCollaborationMode({
    mode: 'plan',
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null
    }
  }, { model, reasoningEffort });
}
