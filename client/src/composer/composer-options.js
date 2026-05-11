export const PERMISSION_OPTIONS = [
  { value: 'default', label: '默认权限' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'bypassPermissions', label: '完全访问', danger: true }
];

export const DEFAULT_PERMISSION_MODE = 'default';

export const DEFAULT_MODEL_SPEED = 'standard';

export const MODEL_SPEED_OPTIONS = [
  { value: 'standard', label: '标准', description: '默认速度与稳定性' },
  { value: 'fast', label: '快速', description: '优先使用快速服务通道' }
];

export const REASONING_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }
];

export function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

export function shortModelName(model) {
  if (!model) {
    return '5.5';
  }
  return model
    .replace(/^gpt-/i, '')
    .replace(/-codex.*$/i, '')
    .replace(/-mini$/i, ' mini');
}

export function permissionLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.label || '默认权限';
}

export function permissionOptionsForSecurity(security = {}) {
  if (security?.dangerFullAccessEnabled) {
    return PERMISSION_OPTIONS;
  }
  return PERMISSION_OPTIONS.filter((option) => option.value !== 'bypassPermissions');
}

export function permissionModeForSecurity(value, security = {}) {
  const requested = String(value || '').trim();
  const allowed = new Set(permissionOptionsForSecurity(security).map((option) => option.value));
  return allowed.has(requested) ? requested : DEFAULT_PERMISSION_MODE;
}

export function reasoningLabel(value) {
  return REASONING_OPTIONS.find((option) => option.value === value)?.label || '超高';
}

export function normalizeModelSpeed(value) {
  return value === 'fast' ? 'fast' : DEFAULT_MODEL_SPEED;
}

export function modelSpeedLabel(value) {
  return MODEL_SPEED_OPTIONS.find((option) => option.value === normalizeModelSpeed(value))?.label || '标准';
}

export function serviceTierForModelSpeed(value) {
  return normalizeModelSpeed(value) === 'fast' ? 'fast' : null;
}

export function selectedSkillSummary(selectedSkills) {
  if (!selectedSkills?.length) {
    return '技能';
  }
  if (selectedSkills.length === 1) {
    return selectedSkills[0]?.label || selectedSkills[0]?.name || '技能';
  }
  return `技能 ${selectedSkills.length}`;
}
