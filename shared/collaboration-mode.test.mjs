import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationModeForComposer,
  normalizeCollaborationMode,
  normalizeComposerMode
} from './collaboration-mode.js';

test('normalizeComposerMode only preserves plan explicitly', () => {
  assert.equal(normalizeComposerMode('plan'), 'plan');
  assert.equal(normalizeComposerMode('chat'), 'chat');
  assert.equal(normalizeComposerMode(''), 'chat');
  assert.equal(normalizeComposerMode('default'), 'chat');
});

test('collaborationModeForComposer returns null for chat mode', () => {
  assert.equal(collaborationModeForComposer({
    composerMode: 'chat',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh'
  }), null);
});

test('collaborationModeForComposer builds the official plan payload', () => {
  assert.deepEqual(collaborationModeForComposer({
    composerMode: 'plan',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh'
  }), {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      developer_instructions: null
    }
  });
});

test('normalizeCollaborationMode rejects unsupported modes', () => {
  assert.throws(
    () => normalizeCollaborationMode({ mode: 'review' }, { model: 'gpt-5.5', reasoningEffort: 'medium' }),
    /Unsupported collaboration mode/
  );
});

test('normalizeCollaborationMode fills settings from selected send options', () => {
  assert.deepEqual(normalizeCollaborationMode({
    mode: 'plan',
    settings: { model: '', reasoning_effort: null, developer_instructions: 'ignored for v1' }
  }, {
    model: 'gpt-5.4',
    reasoningEffort: 'high'
  }), {
    mode: 'plan',
    settings: {
      model: 'gpt-5.4',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
});
