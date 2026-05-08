import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MODEL_SPEED,
  MODEL_SPEED_OPTIONS,
  normalizeModelSpeed,
  serviceTierForModelSpeed
} from './model-preferences.js';

test('model speed preference maps fast mode to the Codex service tier', () => {
  assert.equal(DEFAULT_MODEL_SPEED, 'standard');
  assert.deepEqual(MODEL_SPEED_OPTIONS.map((option) => option.value), ['standard', 'fast']);
  assert.equal(normalizeModelSpeed('fast'), 'fast');
  assert.equal(normalizeModelSpeed('anything-else'), 'standard');
  assert.equal(serviceTierForModelSpeed('standard'), null);
  assert.equal(serviceTierForModelSpeed('fast'), 'fast');
});
