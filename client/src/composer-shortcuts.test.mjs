import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPOSER_MODE_OPTIONS,
  SLASH_COMMANDS,
  composerModeLabel,
  detectComposerToken,
  filteredSlashCommands,
  migrateComposerMode,
  threadStartedComposerModeSourceIds,
  selectedComposerModeForSession,
  replaceComposerToken
} from './composer-shortcuts.js';

test('detectComposerToken finds slash, skill, and file tokens', () => {
  assert.deepEqual(detectComposerToken('/rev', 4), {
    type: 'slash',
    marker: '/',
    query: 'rev',
    start: 0,
    end: 4
  });
  assert.deepEqual(detectComposerToken('请用 $frontend', 12), {
    type: 'skill',
    marker: '$',
    query: 'frontend',
    start: 3,
    end: 12
  });
  assert.deepEqual(detectComposerToken('看 @server', 9), {
    type: 'file',
    marker: '@',
    query: 'server',
    start: 2,
    end: 9
  });
});

test('replaceComposerToken removes selected skill token without leaking it into text', () => {
  const text = '请用 $frontend 优化';
  const token = detectComposerToken(text, 12);
  assert.equal(replaceComposerToken(text, token, ''), '请用 优化');
});

test('filteredSlashCommands matches Chinese commands and English aliases', () => {
  assert.equal(filteredSlashCommands('状态')[0].id, 'status');
  assert.equal(filteredSlashCommands('compact')[0].id, 'compact');
  assert.equal(filteredSlashCommands('review')[0].id, 'review');
});

test('plan slash command is a mode switch', () => {
  const command = SLASH_COMMANDS.find((item) => item.id === 'plan');
  assert.equal(command.action, 'set-mode');
  assert.equal(command.mode, 'plan');
  assert.equal(filteredSlashCommands('plan')[0].id, 'plan');
  assert.equal(filteredSlashCommands('计划')[0].id, 'plan');
});

test('composer mode options support the menu labels', () => {
  assert.deepEqual(COMPOSER_MODE_OPTIONS.map((option) => [option.value, option.label]), [
    ['chat', 'Chat'],
    ['plan', 'Plan']
  ]);
  assert.equal(composerModeLabel('plan'), 'Plan');
  assert.equal(composerModeLabel('invalid'), 'Chat');
});

test('selectedComposerModeForSession preserves pending mode without a session', () => {
  assert.equal(selectedComposerModeForSession({}, '', 'plan'), 'plan');
  assert.equal(selectedComposerModeForSession({}, null, 'invalid'), 'chat');
});

test('migrateComposerMode carries draft mode to the real session id', () => {
  assert.deepEqual(
    migrateComposerMode({ 'draft-1': 'plan', other: 'chat' }, ['draft-1'], 'real-1'),
    { other: 'chat', 'real-1': 'plan' }
  );
});

test('migrateComposerMode preserves unrelated session modes', () => {
  assert.deepEqual(
    migrateComposerMode({ 'draft-a': 'plan', 'session-b': 'plan' }, ['draft-a', 'draft-a', 'session-b'], 'real-a'),
    { 'session-b': 'plan', 'real-a': 'plan' }
  );
});

test('threadStartedComposerModeSourceIds only includes sessions tied to the resolving turn', () => {
  assert.deepEqual(
    threadStartedComposerModeSourceIds(
      { id: 'draft-1', turnId: 'turn-1' },
      { previousSessionId: 'draft-1', sessionId: 'real-1', turnId: 'turn-1' }
    ),
    ['draft-1']
  );
  assert.deepEqual(
    threadStartedComposerModeSourceIds(
      { id: 'selected-background', turnId: 'turn-other' },
      { previousSessionId: 'draft-background', sessionId: 'real-1', turnId: 'turn-1' }
    ),
    ['draft-background']
  );
});
