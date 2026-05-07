import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClientCollaborationMode } from './plan-mode-client.js';

test('buildClientCollaborationMode returns plan payload only for new plan turns', () => {
  assert.deepEqual(buildClientCollaborationMode({
    composerMode: 'plan',
    sendMode: 'start',
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
  assert.equal(buildClientCollaborationMode({
    composerMode: 'plan',
    sendMode: 'steer',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh'
  }), null);
});
