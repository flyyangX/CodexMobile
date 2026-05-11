import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MODEL_SPEED,
  permissionModeForSecurity,
  permissionOptionsForSecurity,
  modelSpeedLabel,
  normalizeModelSpeed,
  serviceTierForModelSpeed
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

test('danger full access is only selectable when enabled by server status', () => {
  assert.deepEqual(
    permissionOptionsForSecurity({ dangerFullAccessEnabled: false }).map((option) => option.value),
    ['default', 'acceptEdits']
  );
  assert.deepEqual(
    permissionOptionsForSecurity({ dangerFullAccessEnabled: true }).map((option) => option.value),
    ['default', 'acceptEdits', 'bypassPermissions']
  );
});

test('disabled danger full access selection falls back to default permission', () => {
  assert.equal(permissionModeForSecurity('bypassPermissions', { dangerFullAccessEnabled: false }), 'default');
  assert.equal(permissionModeForSecurity('bypassPermissions', { dangerFullAccessEnabled: true }), 'bypassPermissions');
  assert.equal(permissionModeForSecurity('acceptEdits', { dangerFullAccessEnabled: false }), 'acceptEdits');
});
