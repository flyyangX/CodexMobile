import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayMessageForTurn,
  realSessionIdFromTurn,
  restoredComposerText,
  selectedSkillsForPaths,
  turnMatchesSelection
} from './app/turn-submission-utils.js';

test('realSessionIdFromTurn ignores draft and codex placeholder sessions', () => {
  assert.equal(realSessionIdFromTurn({ sessionId: 'thread-1' }), 'thread-1');
  assert.equal(realSessionIdFromTurn({ sessionId: 'draft-project-1' }), null);
  assert.equal(realSessionIdFromTurn({ sessionId: 'codex-local-1' }), null);
  assert.equal(realSessionIdFromTurn({ sessionId: '' }), null);
});

test('turnMatchesSelection accepts optimistic, real, previous, turn, and draft matches', () => {
  const ids = {
    turnId: 'turn-1',
    optimisticSessionId: 'draft-1',
    realSessionId: 'thread-1',
    previousSessionId: 'old-thread'
  };
  assert.equal(turnMatchesSelection({ id: 'draft-1' }, ids), true);
  assert.equal(turnMatchesSelection({ id: 'thread-1' }, ids), true);
  assert.equal(turnMatchesSelection({ id: 'old-thread' }, ids), true);
  assert.equal(turnMatchesSelection({ id: 'other', turnId: 'turn-1' }, ids), true);
  assert.equal(turnMatchesSelection({ id: 'other', draft: true }, ids), true);
  assert.equal(turnMatchesSelection({ id: 'other' }, ids), false);
});

test('displayMessageForTurn provides attachment and file mention fallbacks', () => {
  assert.equal(displayMessageForTurn('  hello  ', [], []), 'hello');
  assert.equal(displayMessageForTurn('', [{ path: '/tmp/a.png' }], []), '请查看附件。');
  assert.equal(displayMessageForTurn('', [], [{ path: '/tmp/a.js' }]), '请查看引用文件。');
  assert.equal(displayMessageForTurn('', [], []), '');
});

test('selectedSkillsForPaths returns structured skills without leaking tokens', () => {
  const selected = selectedSkillsForPaths(
    [
      { name: 'frontend-design', path: '/skills/frontend-design' },
      { label: 'unused', path: '/skills/unused' }
    ],
    ['/skills/frontend-design']
  );
  assert.deepEqual(selected, [{ name: 'frontend-design', path: '/skills/frontend-design' }]);
});

test('restoredComposerText appends failed message text only once', () => {
  assert.equal(restoredComposerText('', '继续修复'), '继续修复');
  assert.equal(restoredComposerText('先看日志', '继续修复'), '先看日志\n继续修复');
  assert.equal(restoredComposerText('先看日志\n继续修复', '继续修复'), '先看日志\n继续修复');
});
