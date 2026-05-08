export const THEME_OPTIONS = [
  { value: 'system', label: '自动' },
  { value: 'light', label: '白色' },
  { value: 'dark', label: '黑色' }
];

export const THEME_META_COLORS = {
  light: '#f7f7f4',
  dark: '#171717'
};

const THEME_VALUES = new Set(THEME_OPTIONS.map((option) => option.value));

export function normalizeThemePreference(preference, fallback = 'system') {
  if (THEME_VALUES.has(preference)) {
    return preference;
  }
  return THEME_VALUES.has(fallback) ? fallback : 'system';
}

export function resolveThemePreference(preference, systemPrefersDark = false) {
  const normalized = normalizeThemePreference(preference);
  if (normalized === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return normalized;
}

export function applyThemeToDocument(document, effectiveTheme) {
  if (!document?.documentElement) {
    return;
  }
  const theme = effectiveTheme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector?.('meta[name="theme-color"]');
  themeColor?.setAttribute('content', THEME_META_COLORS[theme]);
}
