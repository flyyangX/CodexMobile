import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THEME_META_COLORS,
  THEME_OPTIONS,
  applyThemeToDocument,
  normalizeThemePreference,
  resolveThemePreference
} from './theme-preference.js';

test('theme preference normalizes stored values', () => {
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('unexpected'), 'system');
  assert.equal(normalizeThemePreference(null, 'light'), 'light');
});

test('system theme resolves from the OS preference', () => {
  assert.equal(resolveThemePreference('system', true), 'dark');
  assert.equal(resolveThemePreference('system', false), 'light');
  assert.equal(resolveThemePreference('dark', false), 'dark');
  assert.equal(resolveThemePreference('light', true), 'light');
});

test('theme options expose auto, light, and dark choices', () => {
  assert.deepEqual(THEME_OPTIONS.map((option) => [option.value, option.label]), [
    ['system', '自动'],
    ['light', '白色'],
    ['dark', '黑色']
  ]);
});

test('applyThemeToDocument updates dataset and theme-color meta', () => {
  const meta = { content: '', setAttribute(name, value) { this[name] = value; } };
  const document = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      return selector === 'meta[name="theme-color"]' ? meta : null;
    }
  };

  applyThemeToDocument(document, 'dark');

  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(meta.content, THEME_META_COLORS.dark);
});
