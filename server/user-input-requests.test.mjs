import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingUserInputRequests,
  normalizeUserInputAnswers,
  normalizeUserInputRequest
} from './user-input-requests.js';

const requestMessage = {
  id: 7,
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    questions: [{
      id: 'choice',
      header: '方案',
      question: '选择一个方案',
      isOther: true,
      isSecret: false,
      options: [{ label: 'A', description: '快速实现' }]
    }]
  }
};

test('normalizeUserInputRequest keeps only protocol fields the browser needs', () => {
  assert.deepEqual(normalizeUserInputRequest(requestMessage), {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    questions: [{
      id: 'choice',
      header: '方案',
      question: '选择一个方案',
      isOther: true,
      isSecret: false,
      options: [{ label: 'A', description: '快速实现' }]
    }]
  });
});

test('normalizeUserInputAnswers returns the official response envelope', () => {
  assert.deepEqual(normalizeUserInputAnswers({
    choice: { answers: ['A'] },
    note: ['继续'],
    empty: { answers: [] }
  }), {
    answers: {
      choice: { answers: ['A'] },
      note: { answers: ['继续'] },
      empty: { answers: [] }
    }
  });
});

test('PendingUserInputRequests resolves a stored request once', async () => {
  const store = new PendingUserInputRequests({ now: () => 123 });
  let resolved = null;
  const pending = store.add(requestMessage, (result) => {
    resolved = result;
  });

  assert.equal(pending.key, 'thread-1:turn-1:input-1');
  assert.equal(store.list().length, 1);

  const answered = store.answer({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    answers: { choice: { answers: ['A'] } }
  });

  assert.equal(answered.ok, true);
  assert.deepEqual(resolved, { answers: { choice: { answers: ['A'] } } });
  assert.equal(store.list().length, 0);
});

test('PendingUserInputRequests reports missing requests', () => {
  const store = new PendingUserInputRequests();
  const result = store.answer({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'missing',
    answers: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
});
