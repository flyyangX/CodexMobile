export const DEFAULT_MODEL_SPEED = 'standard';

export const MODEL_SPEED_OPTIONS = [
  {
    value: 'standard',
    label: '标准',
    description: '默认速度，常规用量'
  },
  {
    value: 'fast',
    label: '快速',
    description: '1.5 倍速，用量增加'
  }
];

export function normalizeModelSpeed(value) {
  return value === 'fast' ? 'fast' : DEFAULT_MODEL_SPEED;
}

export function modelSpeedLabel(value) {
  const normalized = normalizeModelSpeed(value);
  return MODEL_SPEED_OPTIONS.find((option) => option.value === normalized)?.label || '标准';
}

export function serviceTierForModelSpeed(value) {
  return normalizeModelSpeed(value) === 'fast' ? 'fast' : null;
}
