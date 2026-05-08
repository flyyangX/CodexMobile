export const PERMISSION_OPTIONS = [
  { value: 'default', label: '默认权限', shortLabel: '默认' },
  { value: 'acceptEdits', label: '自动接受编辑', shortLabel: '自动' },
  { value: 'bypassPermissions', label: '完全访问', shortLabel: '全权', danger: true }
];

export const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

export function permissionLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.label || '默认权限';
}

export function permissionShortLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.shortLabel || '默认';
}
