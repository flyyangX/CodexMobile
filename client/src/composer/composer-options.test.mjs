/**
 * 验证 composer-options：模型速度、权限安全过滤与 Codex service tier 映射。
 *
 * Keywords: composer-options, model speed, permission, tests
 *
 * Exports: 无导出 / 内含用例
 *
 * Inward: composer-options.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MODEL_SPEED,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_KEY,
  modelSpeedLabel,
  normalizeModelSpeed,
  normalizePermissionModePreference,
  normalizePermissionModeForSecurity,
  permissionOptionsForSecurity,
  readStoredPermissionMode,
  serviceTierForModelSpeed,
  writeStoredPermissionMode
} from './composer-options.js';

test('model speed defaults to standard unless fast is selected', () => {
  assert.equal(DEFAULT_MODEL_SPEED, 'standard');
  assert.equal(normalizeModelSpeed('fast'), 'fast');
  assert.equal(normalizeModelSpeed('standard'), 'standard');
  assert.equal(normalizeModelSpeed('turbo'), 'standard');
  assert.equal(modelSpeedLabel('fast'), '快速');
  assert.equal(modelSpeedLabel('turbo'), '标准');
});

test('fast model speed maps to Codex service tier', () => {
  assert.equal(serviceTierForModelSpeed('fast'), 'fast');
  assert.equal(serviceTierForModelSpeed('standard'), null);
});

test('permission options hide danger full access unless backend enables it', () => {
  assert.equal(DEFAULT_PERMISSION_MODE, 'default');
  assert.deepEqual(permissionOptionsForSecurity({ dangerFullAccessEnabled: false }).map((option) => option.value), [
    'default',
    'acceptEdits'
  ]);
  assert.deepEqual(permissionOptionsForSecurity({ dangerFullAccessEnabled: true }).map((option) => option.value), [
    'default',
    'acceptEdits',
    'bypassPermissions'
  ]);
  assert.equal(normalizePermissionModeForSecurity('legacyExtraMode', { dangerFullAccessEnabled: false }), 'default');
  assert.equal(normalizePermissionModeForSecurity('bypassPermissions', { dangerFullAccessEnabled: false }), 'default');
});

test('permission mode preference is persisted separately from security filtering', () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value)
  };

  assert.equal(readStoredPermissionMode(storage), DEFAULT_PERMISSION_MODE);
  assert.equal(writeStoredPermissionMode('bypassPermissions', storage), 'bypassPermissions');
  assert.equal(data.get(PERMISSION_MODE_KEY), 'bypassPermissions');
  assert.equal(readStoredPermissionMode(storage), 'bypassPermissions');
  assert.equal(normalizePermissionModeForSecurity(readStoredPermissionMode(storage), { dangerFullAccessEnabled: false }), 'default');
  assert.equal(normalizePermissionModeForSecurity(readStoredPermissionMode(storage), { dangerFullAccessEnabled: true }), 'bypassPermissions');
  assert.equal(normalizePermissionModePreference('legacy'), DEFAULT_PERMISSION_MODE);
});
