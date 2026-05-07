# CodexMobile Plan Mode v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Codex Plan mode to CodexMobile with a visible composer switch, official `collaborationMode` start payloads, plan progress rendering, and in-chat user-input cards.

**Architecture:** Use small protocol helpers for collaboration mode and user-input request normalization, then thread those helpers through the existing chat service, Codex app-server runner, WebSocket updates, and composer UI. Keep the large `App.jsx` intact for v1, but isolate testable normalization logic outside the component where practical.

**Tech Stack:** Node.js ESM, `node:test`, React 18, Vite, Codex app-server protocol, Codex Desktop IPC bridge.

---

## Scope Check

This plan covers one cohesive feature with two surfaces:

- Backend protocol support: Plan mode start payloads and `item/tool/requestUserInput` response flow.
- Frontend user experience: composer mode switch, slash shortcuts, plan progress, and user-input cards.

The desktop IPC user-input channel has one known uncertainty: `thread-follower-submit-user-input` is advertised by the local IPC method map, but the exact payload is not generated in the app-server TypeScript schema. This plan gates that work behind tests and a manual probe. The headless/app-server path must work even if desktop IPC answering needs a follow-up adjustment after probing.

## File Structure

- Create `shared/collaboration-mode.js`: shared normalization for composer mode and app-server `collaborationMode`.
- Test `shared/collaboration-mode.test.mjs`: pure protocol tests.
- Create `server/user-input-requests.js`: pending request store and answer normalization.
- Test `server/user-input-requests.test.mjs`: pending-store behavior and official answer shape.
- Modify `server/codex-app-server.js`: export default request fallback so the runner can combine custom user-input handling with existing safe defaults.
- Modify `server/codex-runner.js`: accept `collaborationMode` and `onUserInputRequest`; forward Plan mode to `turn/start`; emit plan updates; await user-input answers.
- Modify `server/chat-service.js`: normalize request mode, retain it in queue jobs, pass it into runner and desktop IPC starts, expose answer endpoint method.
- Modify `server/desktop-ipc-client.js`: add wrappers for collaboration mode and user-input submission, with frame-shape tests.
- Modify `server/index.js`: add `POST /api/chat/user-input/respond`; include pending inputs in public status if useful for reconnects.
- Modify `client/src/composer-shortcuts.js`: add `/plan` and `/计划` as mode-switch shortcuts.
- Modify `client/src/App.jsx`: add session-scoped composer mode, send payload wiring, WebSocket handling for user-input requests, card rendering, and composer switch.
- Modify `client/src/styles.css`: style the mode switch and user-input cards without crowding the composer.
- Modify `client/src/notification-events.js`: treat explicit user-input request events as notifications.

## Task 1: Shared Collaboration Mode Helper

**Files:**
- Create: `shared/collaboration-mode.js`
- Create: `shared/collaboration-mode.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `shared/collaboration-mode.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the failing test**

Run: `node --test shared/collaboration-mode.test.mjs`

Expected: FAIL with a module-not-found error for `shared/collaboration-mode.js`.

- [ ] **Step 3: Add the helper**

Create `shared/collaboration-mode.js`:

```js
const VALID_COLLABORATION_MODES = new Set(['plan', 'default']);
const VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function normalizeComposerMode(value) {
  return String(value || '').trim().toLowerCase() === 'plan' ? 'plan' : 'chat';
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').trim();
  return VALID_REASONING_EFFORTS.has(effort) ? effort : null;
}

export function normalizeCollaborationMode(value, {
  model = '',
  reasoningEffort = ''
} = {}) {
  if (!value) {
    return null;
  }
  const mode = String(value.mode || '').trim();
  if (!VALID_COLLABORATION_MODES.has(mode)) {
    throw new Error(`Unsupported collaboration mode: ${mode || 'empty'}`);
  }
  if (mode === 'default') {
    return null;
  }
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : {};
  const selectedModel = String(settings.model || model || '').trim();
  if (!selectedModel) {
    throw new Error('Plan mode requires a model');
  }
  return {
    mode: 'plan',
    settings: {
      model: selectedModel,
      reasoning_effort: normalizeReasoningEffort(settings.reasoning_effort || reasoningEffort),
      developer_instructions: null
    }
  };
}

export function collaborationModeForComposer({
  composerMode = 'chat',
  model = '',
  reasoningEffort = ''
} = {}) {
  if (normalizeComposerMode(composerMode) !== 'plan') {
    return null;
  }
  return normalizeCollaborationMode({
    mode: 'plan',
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null
    }
  }, { model, reasoningEffort });
}
```

- [ ] **Step 4: Run helper tests**

Run: `node --test shared/collaboration-mode.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/collaboration-mode.js shared/collaboration-mode.test.mjs
git commit -m "feat: add collaboration mode helper"
```

## Task 2: Pending User Input Store

**Files:**
- Create: `server/user-input-requests.js`
- Create: `server/user-input-requests.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `server/user-input-requests.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the failing test**

Run: `node --test server/user-input-requests.test.mjs`

Expected: FAIL with a module-not-found error for `server/user-input-requests.js`.

- [ ] **Step 3: Add the store**

Create `server/user-input-requests.js`:

```js
function stringOrEmpty(value) {
  return String(value || '').trim();
}

export function userInputRequestKey({ threadId, turnId, itemId } = {}) {
  return [threadId, turnId, itemId].map(stringOrEmpty).join(':');
}

function normalizeOptions(options) {
  return Array.isArray(options)
    ? options.map((option) => ({
      label: String(option?.label || ''),
      description: String(option?.description || '')
    }))
    : null;
}

export function normalizeUserInputRequest(message = {}) {
  const params = message.params || {};
  const request = {
    threadId: stringOrEmpty(params.threadId),
    turnId: stringOrEmpty(params.turnId),
    itemId: stringOrEmpty(params.itemId),
    questions: Array.isArray(params.questions)
      ? params.questions.map((question) => ({
        id: stringOrEmpty(question?.id),
        header: String(question?.header || ''),
        question: String(question?.question || ''),
        isOther: Boolean(question?.isOther),
        isSecret: Boolean(question?.isSecret),
        options: normalizeOptions(question?.options)
      })).filter((question) => question.id)
      : []
  };
  if (!request.threadId || !request.turnId || !request.itemId || !request.questions.length) {
    throw new Error('Malformed user input request');
  }
  return request;
}

export function normalizeUserInputAnswers(value = {}) {
  const source = value.answers && typeof value.answers === 'object' ? value.answers : value;
  const answers = {};
  for (const [questionId, answerValue] of Object.entries(source || {})) {
    const rawAnswers = Array.isArray(answerValue)
      ? answerValue
      : Array.isArray(answerValue?.answers)
        ? answerValue.answers
        : [];
    answers[questionId] = {
      answers: rawAnswers.map((answer) => String(answer)).filter((answer) => answer.length > 0)
    };
  }
  return { answers };
}

export class PendingUserInputRequests {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.records = new Map();
  }

  add(message, resolve) {
    const request = normalizeUserInputRequest(message);
    const key = userInputRequestKey(request);
    const record = {
      key,
      request,
      resolve,
      createdAt: this.now(),
      completed: false
    };
    this.records.set(key, record);
    return { key, request };
  }

  list() {
    return [...this.records.values()].map((record) => ({
      ...record.request,
      key: record.key,
      createdAt: record.createdAt
    }));
  }

  answer({ threadId, turnId, itemId, answers }) {
    const key = userInputRequestKey({ threadId, turnId, itemId });
    const record = this.records.get(key);
    if (!record) {
      return { ok: false, reason: 'not-found' };
    }
    this.records.delete(key);
    record.completed = true;
    record.resolve(normalizeUserInputAnswers(answers || {}));
    return { ok: true, request: record.request };
  }

  clearForTurn({ threadId, turnId } = {}) {
    for (const [key, record] of this.records.entries()) {
      if (
        (!threadId || record.request.threadId === threadId) &&
        (!turnId || record.request.turnId === turnId)
      ) {
        this.records.delete(key);
      }
    }
  }
}
```

- [ ] **Step 4: Run store tests**

Run: `node --test server/user-input-requests.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/user-input-requests.js server/user-input-requests.test.mjs
git commit -m "feat: track pending user input requests"
```

## Task 3: Backend Plan Mode Send Path

**Files:**
- Modify: `server/chat-service.js`
- Modify: `server/codex-runner.js`
- Modify: `server/chat-service.test.mjs`

- [ ] **Step 1: Add failing chat-service tests**

Append these tests to `server/chat-service.test.mjs`:

```js
test('sendChat forwards plan collaboration mode to headless Codex turns', async () => {
  let runPayload = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: false,
      connected: true,
      mode: 'headless-local',
      capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
    }),
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'turn-plan-1',
    message: '先做计划',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    collaborationMode: { mode: 'plan', settings: {} }
  });

  assert.deepEqual(runPayload.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      developer_instructions: null
    }
  });
});

test('sendChat does not forward plan collaboration mode for steer', async () => {
  let steerPayload = null;
  const { service } = makeChatService({
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' };
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '这个补充发到当前任务',
    sendMode: 'steer',
    collaborationMode: { mode: 'plan', settings: {} }
  });

  assert.equal(steerPayload.payload.collaborationMode, undefined);
});
```

- [ ] **Step 2: Run the failing chat-service tests**

Run: `node --test server/chat-service.test.mjs`

Expected: FAIL because `collaborationMode` is not normalized or forwarded.

- [ ] **Step 3: Import and normalize collaboration mode in `chat-service.js`**

At the top of `server/chat-service.js`, add:

```js
import { normalizeCollaborationMode } from '../shared/collaboration-mode.js';
```

Inside `sendChat`, after `selectedSkills` is computed, add:

```js
    const selectedModel = session?.model || body.model || config.model || 'gpt-5.5';
    const selectedReasoningEffort = body.reasoningEffort || defaultReasoningEffort;
    const collaborationMode = sendMode === 'steer'
      ? null
      : normalizeCollaborationMode(body.collaborationMode, {
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort
      });
```

Then replace repeated model/reasoning expressions in queue and send calls with `selectedModel` and `selectedReasoningEffort`, and include `collaborationMode` only for start/queue paths:

```js
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        collaborationMode,
```

In `sendViaDesktopIpc` parameters, add:

```js
    collaborationMode
```

Add it to `baseTurnStartParams`:

```js
      collaborationMode
```

For `steerDesktopFollowerTurn`, keep `restoreMessage.context.collaborationMode: null`.

- [ ] **Step 4: Pass collaboration mode through queued jobs**

In `enqueueChatJob` call sites, store:

```js
      collaborationMode
```

In `runNextQueuedChat`, when calling `runCodexTurn`, include:

```js
        collaborationMode: job.collaborationMode || null,
```

- [ ] **Step 5: Update `runCodexTurn` signature and turn/start payload**

Change the `runCodexTurn` signature in `server/codex-runner.js`:

```js
export async function runCodexTurn({
  sessionId,
  draftSessionId,
  projectPath,
  message,
  attachments = [],
  selectedSkills = [],
  model,
  reasoningEffort,
  permissionMode,
  collaborationMode = null,
  turnId: providedTurnId
}, emit) {
```

Update `turn/start` params:

```js
    const turnStartParams = {
      threadId: currentSessionId,
      input: buildCodexTurnInput({
        message,
        attachments,
        selectedSkills,
        larkInstruction: larkCliContext.enabled ? larkCliContext.instruction : ''
      }),
      cwd: workingDirectory,
      approvalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(sandboxMode, { networkAccess: larkCliContext.enabled }),
      model: model || null,
      effort: modelReasoningEffort || null
    };
    if (collaborationMode) {
      turnStartParams.collaborationMode = collaborationMode;
    }
    const turnResponse = await client.request('turn/start', turnStartParams, { timeoutMs: 30_000 });
```

- [ ] **Step 6: Run chat-service tests**

Run: `node --test server/chat-service.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/chat-service.js server/codex-runner.js server/chat-service.test.mjs
git commit -m "feat: forward plan collaboration mode"
```

## Task 4: App-Server Plan Updates and User Input Requests

**Files:**
- Modify: `server/codex-app-server.js`
- Modify: `server/codex-runner.js`
- Modify: `server/chat-service.js`
- Modify: `server/codex-app-server.test.mjs`
- Modify: `server/chat-service.test.mjs`

- [ ] **Step 1: Add failing tests for user-input service methods**

Append to `server/chat-service.test.mjs`:

```js
test('chat service stores and answers pending user input requests', async () => {
  const { service, broadcasts } = makeChatService();
  const requestMessage = {
    id: 9,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [{
        id: 'choice',
        header: '方案',
        question: '选哪个？',
        isOther: false,
        isSecret: false,
        options: [{ label: 'A', description: '推荐' }]
      }]
    }
  };

  let resolved = null;
  const pending = service.handleUserInputRequest(requestMessage, (answer) => {
    resolved = answer;
  });

  assert.equal(pending.key, 'thread-1:turn-1:input-1');
  assert.equal(broadcasts.some((payload) => payload.type === 'user-input-request'), true);

  const result = service.respondToUserInput({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    answers: { choice: { answers: ['A'] } }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(resolved, { answers: { choice: { answers: ['A'] } } });
});
```

- [ ] **Step 2: Run the failing test**

Run: `node --test server/chat-service.test.mjs`

Expected: FAIL because the service has no `handleUserInputRequest` or `respondToUserInput`.

- [ ] **Step 3: Export the app-server fallback**

In `server/codex-app-server.js`, change:

```js
function defaultServerRequestResult(message) {
```

to:

```js
export function defaultServerRequestResult(message) {
```

Leave the existing fallback decisions unchanged for now. The runner will intercept user-input requests before the fallback is used.

- [ ] **Step 4: Add pending input store to chat service**

At the top of `server/chat-service.js`, import:

```js
import { PendingUserInputRequests } from './user-input-requests.js';
```

Inside `createChatService`, create the store:

```js
  const pendingUserInputs = new PendingUserInputRequests();
```

Add functions before the returned object:

```js
  function handleUserInputRequest(message, resolve) {
    const pending = pendingUserInputs.add(message, resolve);
    broadcast({
      type: 'user-input-request',
      ...pending.request,
      key: pending.key,
      timestamp: new Date().toISOString()
    });
    broadcast({
      type: 'status-update',
      projectId: null,
      sessionId: pending.request.threadId,
      turnId: pending.request.turnId,
      kind: 'turn',
      status: 'running',
      label: '等待你的选择',
      detail: pending.request.questions[0]?.question || '',
      timestamp: new Date().toISOString()
    });
    return pending;
  }

  function respondToUserInput(body = {}) {
    const result = pendingUserInputs.answer(body);
    if (result.ok) {
      broadcast({
        type: 'user-input-resolved',
        threadId: body.threadId,
        sessionId: body.threadId,
        turnId: body.turnId,
        itemId: body.itemId,
        timestamp: new Date().toISOString()
      });
    }
    return result;
  }
```

Expose them:

```js
    handleUserInputRequest,
    respondToUserInput,
```

- [ ] **Step 5: Wire runner user-input handling**

In `server/codex-runner.js`, import the fallback:

```js
import { createCodexAppServerClient, defaultServerRequestResult } from './codex-app-server.js';
```

Change the `runCodexTurn` signature to accept:

```js
  onUserInputRequest = null,
```

In `createCodexAppServerClient({ ... })`, add:

```js
      onServerRequest: async (appMessage) => {
        resetTurnInactivityTimeout();
        if (appMessage.method === 'item/tool/requestUserInput' && onUserInputRequest) {
          return await new Promise((resolve) => {
            onUserInputRequest(appMessage, resolve);
          });
        }
        return defaultServerRequestResult(appMessage);
      },
```

Keep `onNotification` as it is.

- [ ] **Step 6: Pass the service handler into headless/background runs**

In `server/chat-service.js`, when calling `runCodexTurn`, include:

```js
        onUserInputRequest: handleUserInputRequest,
```

- [ ] **Step 7: Emit structured plan updates**

In `server/codex-runner.js`, add handling near the top of `emitAppServerNotification`:

```js
  if (method === 'turn/plan/updated') {
    const steps = Array.isArray(params.plan) ? params.plan : [];
    emit({
      type: 'plan-update',
      sessionId,
      turnId,
      explanation: params.explanation || '',
      plan: steps.map((step, index) => ({
        id: `${params.turnId || turnId}-plan-${index}`,
        step: String(step?.step || ''),
        status: step?.status || 'pending'
      })),
      timestamp: new Date().toISOString()
    });
    emitActivity(emit, {
      sessionId,
      turnId,
      messageId: `${turnId}-plan`,
      kind: 'plan',
      status: 'running',
      item: {
        id: `${turnId}-plan`,
        type: 'plan',
        message: params.explanation || steps.map((step) => step?.step).filter(Boolean).join('\n')
      }
    });
    return;
  }
```

For `item/plan/delta`, add a lightweight activity update:

```js
  if (method === 'item/plan/delta') {
    emit({
      type: 'activity-update',
      sessionId,
      turnId,
      messageId: params.itemId || `${turnId}-plan-delta`,
      kind: 'plan',
      status: 'running',
      label: '正在规划',
      detail: String(params.delta || ''),
      timestamp: new Date().toISOString()
    });
    return;
  }
```

- [ ] **Step 8: Run backend tests**

Run:

```bash
node --test server/user-input-requests.test.mjs server/chat-service.test.mjs server/codex-app-server.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/codex-app-server.js server/codex-runner.js server/chat-service.js server/codex-app-server.test.mjs server/chat-service.test.mjs
git commit -m "feat: handle plan user input requests"
```

## Task 5: HTTP Endpoint and Desktop IPC Wrappers

**Files:**
- Modify: `server/index.js`
- Modify: `server/desktop-ipc-client.js`
- Modify: `server/desktop-ipc-client.test.mjs`

- [ ] **Step 1: Add desktop IPC wrapper tests**

Update the method-version test in `server/desktop-ipc-client.test.mjs`:

```js
  assert.equal(desktopIpcMethodVersion('thread-follower-set-collaboration-mode'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-submit-user-input'), 1);
```

Add a frame test for exported wrapper shape:

```js
test('desktop follower user input wrapper sends expected frame shape', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  const socketPath = path.join(dir, 'ipc.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const client = new DesktopIpcClient({ clientType: 'codexmobile-test', socketPath });
  const connected = client.connect({ timeoutMs: 1000 });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  await connected;

  const pending = client.request('thread-follower-submit-user-input', {
    conversationId: 'thread-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'input-1',
    response: { answers: { choice: { answers: ['A'] } } }
  });
  const request = await readFrame(socket);

  assert.equal(request.type, 'request');
  assert.equal(request.method, 'thread-follower-submit-user-input');
  assert.equal(request.version, 1);
  assert.equal(request.params.conversationId, 'thread-1');
  assert.deepEqual(request.params.response.answers.choice.answers, ['A']);

  socket.write(frameFor({
    type: 'response',
    requestId: request.requestId,
    resultType: 'success',
    method: 'thread-follower-submit-user-input',
    result: { accepted: true }
  }));
  await pending;

  client.close();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the failing IPC tests**

Run: `node --test server/desktop-ipc-client.test.mjs`

Expected: FAIL until wrappers or direct helper exports are added as needed.

- [ ] **Step 3: Add desktop IPC wrappers**

In `server/desktop-ipc-client.js`, add:

```js
export async function setDesktopFollowerCollaborationMode(conversationId, collaborationMode, options = {}) {
  return requestDesktopFollower('thread-follower-set-collaboration-mode', {
    conversationId,
    collaborationMode
  }, options);
}

export async function submitDesktopFollowerUserInput(conversationId, { threadId, turnId, itemId, response }, options = {}) {
  return requestDesktopFollower('thread-follower-submit-user-input', {
    conversationId,
    threadId,
    turnId,
    itemId,
    response
  }, options);
}
```

When later probing against the real desktop app, if the desktop rejects this payload shape, adjust only this wrapper and its test fixture.

- [ ] **Step 4: Add HTTP endpoint**

In `server/index.js`, after `/api/chat/send`, add:

```js
  if (method === 'POST' && pathname === '/api/chat/user-input/respond') {
    const body = await readBody(req);
    try {
      const result = chatService.respondToUserInput(body);
      sendJson(res, result.ok ? 200 : 404, result.ok ? { accepted: true } : { error: 'User input request not found' });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to submit user input' });
    }
    return;
  }
```

- [ ] **Step 5: Run server tests**

Run:

```bash
node --test server/desktop-ipc-client.test.mjs server/chat-service.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/desktop-ipc-client.js server/desktop-ipc-client.test.mjs
git commit -m "feat: expose user input response endpoint"
```

## Task 6: Slash Shortcuts and Composer Mode State

**Files:**
- Modify: `client/src/composer-shortcuts.js`
- Modify: `client/src/composer-shortcuts.test.mjs`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Add failing shortcut tests**

In `client/src/composer-shortcuts.test.mjs`, extend the import:

```js
import {
  SLASH_COMMANDS,
  detectComposerToken,
  filteredSlashCommands,
  replaceComposerToken
} from './composer-shortcuts.js';
```

Append:

```js
test('plan slash command is a mode switch', () => {
  const command = SLASH_COMMANDS.find((item) => item.id === 'plan');
  assert.equal(command.action, 'set-mode');
  assert.equal(command.mode, 'plan');
  assert.equal(filteredSlashCommands('plan')[0].id, 'plan');
  assert.equal(filteredSlashCommands('计划')[0].id, 'plan');
});
```

- [ ] **Step 2: Run failing shortcut test**

Run: `node --test client/src/composer-shortcuts.test.mjs`

Expected: FAIL because the plan shortcut is not registered.

- [ ] **Step 3: Add the slash command**

In `client/src/composer-shortcuts.js`, add after `status`:

```js
  {
    id: 'plan',
    token: '/计划',
    aliases: ['/plan'],
    title: '计划模式',
    description: '让 Codex 先规划并等待你选择方案',
    action: 'set-mode',
    mode: 'plan'
  },
```

- [ ] **Step 4: Wire `runSlashCommand` to mode changes**

In `Composer` props in `client/src/App.jsx`, add:

```js
  composerMode,
  onSelectComposerMode,
```

In `runSlashCommand(command)`, before the `insert-prompt` behavior:

```js
    if (command.action === 'set-mode') {
      onSelectComposerMode?.(command.mode || 'chat');
      replaceToken('');
      setOpenMenu(null);
      return;
    }
```

- [ ] **Step 5: Add session-scoped mode state**

Near the other top-level `App` state in `client/src/App.jsx`, add:

```js
  const [composerModesBySession, setComposerModesBySession] = useState({});
  const selectedComposerMode = composerModesBySession[selectedSession?.id || ''] || 'chat';
```

Add:

```js
  function setSelectedComposerMode(mode) {
    const normalized = mode === 'plan' ? 'plan' : 'chat';
    const sessionKey = selectedSessionRef.current?.id || selectedSession?.id || '';
    if (!sessionKey) {
      return;
    }
    setComposerModesBySession((current) => ({
      ...current,
      [sessionKey]: normalized
    }));
  }
```

In `handleNewConversation`, after clearing attachments:

```js
    setComposerModesBySession((current) => ({ ...current, [draft.id]: 'chat' }));
```

Pass into `Composer`:

```jsx
        composerMode={selectedComposerMode}
        onSelectComposerMode={setSelectedComposerMode}
```

- [ ] **Step 6: Run shortcut tests**

Run: `node --test client/src/composer-shortcuts.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/composer-shortcuts.js client/src/composer-shortcuts.test.mjs client/src/App.jsx
git commit -m "feat: add plan mode composer state"
```

## Task 7: Send Plan Payload From the Browser

**Files:**
- Modify: `client/src/App.jsx`
- Optional create: `client/src/plan-mode-client.js`
- Optional test: `client/src/plan-mode-client.test.mjs`

- [ ] **Step 1: Add optional pure send-payload helper test**

If keeping send payload logic testable outside `App.jsx`, create `client/src/plan-mode-client.test.mjs`:

```js
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
```

- [ ] **Step 2: Add optional helper**

Create `client/src/plan-mode-client.js`:

```js
import { collaborationModeForComposer } from '../../shared/collaboration-mode.js';

export function buildClientCollaborationMode({
  composerMode = 'chat',
  sendMode = 'start',
  model = '',
  reasoningEffort = ''
} = {}) {
  if (sendMode === 'steer') {
    return null;
  }
  return collaborationModeForComposer({ composerMode, model, reasoningEffort });
}
```

- [ ] **Step 3: Run helper test**

Run: `node --test client/src/plan-mode-client.test.mjs`

Expected: PASS.

- [ ] **Step 4: Use the helper in `submitCodexMessage`**

In `client/src/App.jsx`, import:

```js
import { buildClientCollaborationMode } from './plan-mode-client.js';
```

In `submitCodexMessage`, before the `apiFetch('/api/chat/send')` call, compute:

```js
    const modelForTurn = selectedModel || status.model;
    const reasoningForTurn = selectedReasoningEffort || status.reasoningEffort || DEFAULT_REASONING_EFFORT;
    const collaborationMode = buildClientCollaborationMode({
      composerMode: selectedComposerMode,
      sendMode,
      model: modelForTurn,
      reasoningEffort: reasoningForTurn
    });
```

Then change the body fields:

```js
          model: modelForTurn,
          reasoningEffort: reasoningForTurn,
          collaborationMode,
```

- [ ] **Step 5: Run client helper tests**

Run:

```bash
node --test client/src/plan-mode-client.test.mjs client/src/composer-shortcuts.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.jsx client/src/plan-mode-client.js client/src/plan-mode-client.test.mjs
git commit -m "feat: send plan collaboration payload"
```

## Task 8: User Input Cards in the Browser

**Files:**
- Modify: `client/src/App.jsx`
- Modify: `client/src/styles.css`
- Modify: `client/src/notification-events.js`
- Modify: `client/src/notification-events.test.mjs`

- [ ] **Step 1: Add notification test**

Append to `client/src/notification-events.test.mjs`:

```js
test('notificationFromPayload warns for explicit user input requests', () => {
  const notification = notificationFromPayload({
    type: 'user-input-request',
    questions: [{ question: '选择方案' }]
  });

  assert.equal(notification.level, 'warning');
  assert.equal(notification.title, '需要处理');
});
```

- [ ] **Step 2: Update notification logic**

In `client/src/notification-events.js`, before the status/activity branch:

```js
  if (payload.type === 'user-input-request') {
    return {
      level: 'warning',
      title: '需要处理',
      body: payload.questions?.[0]?.question || 'Codex 正在等待你的选择。'
    };
  }
```

- [ ] **Step 3: Add pending input state**

In `App`, add:

```js
  const [pendingUserInputs, setPendingUserInputs] = useState({});
```

Add helper:

```js
  function userInputKey(payload) {
    return [payload.threadId || payload.sessionId, payload.turnId, payload.itemId].filter(Boolean).join(':');
  }
```

In WebSocket `onmessage`, add before generic status handling:

```js
      if (payload.type === 'user-input-request') {
        notifyFromPayload(payload);
        const key = userInputKey(payload);
        setPendingUserInputs((current) => ({
          ...current,
          [key]: { ...payload, key, status: 'pending', error: '' }
        }));
        if (payloadMatchesCurrentConversation({ ...payload, sessionId: payload.threadId || payload.sessionId })) {
          setMessages((current) => upsertUserInputMessage(current, { ...payload, key }));
        }
        return;
      }
      if (payload.type === 'user-input-resolved') {
        const key = userInputKey(payload);
        setPendingUserInputs((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        setMessages((current) => markUserInputMessageResolved(current, payload));
        return;
      }
```

- [ ] **Step 4: Add message upsert helpers**

Near other message helper functions in `client/src/App.jsx`, add:

```js
function userInputMessageId(payload) {
  return `user-input-${[payload.threadId || payload.sessionId, payload.turnId, payload.itemId].filter(Boolean).join('-')}`;
}

function upsertUserInputMessage(current, payload) {
  const id = userInputMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const nextMessage = {
    id,
    role: 'user_input_request',
    sessionId: payload.threadId || payload.sessionId || null,
    threadId: payload.threadId || payload.sessionId || null,
    turnId: payload.turnId || null,
    itemId: payload.itemId || null,
    questions: Array.isArray(payload.questions) ? payload.questions : [],
    status: payload.status || 'pending',
    timestamp: payload.timestamp || new Date().toISOString(),
    error: payload.error || ''
  };
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = { ...current[existingIndex], ...nextMessage };
    return next;
  }
  return [...current, nextMessage];
}

function markUserInputMessageResolved(current, payload) {
  const id = userInputMessageId(payload);
  return current.map((message) =>
    message.id === id
      ? { ...message, status: 'answered', error: '' }
      : message
  );
}
```

- [ ] **Step 5: Add the card component**

In `client/src/App.jsx`, add:

```jsx
function UserInputRequestMessage({ message, onSubmit }) {
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answered = message.status === 'answered';
  const questions = Array.isArray(message.questions) ? message.questions : [];

  function setQuestionAnswer(questionId, value) {
    setAnswers((current) => ({
      ...current,
      [questionId]: { answers: value ? [value] : [] }
    }));
  }

  async function submit(nextAnswers) {
    setBusy(true);
    setError('');
    try {
      await onSubmit?.(message, nextAnswers);
    } catch (submitError) {
      setError(submitError.message || '提交失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble user-input-card ${answered ? 'is-answered' : ''}`}>
        <div className="user-input-card-head">
          <HelpCircle size={16} />
          <span>{answered ? '已提交选择' : '等待你的选择'}</span>
        </div>
        {questions.map((question) => (
          <div key={question.id} className="user-input-question">
            {question.header ? <strong>{question.header}</strong> : null}
            <p>{question.question}</p>
            {Array.isArray(question.options) && question.options.length ? (
              <div className="user-input-options">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={answers[question.id]?.answers?.[0] === option.label ? 'is-selected' : ''}
                    disabled={busy || answered}
                    onClick={() => setQuestionAnswer(question.id, option.label)}
                  >
                    <span>{option.label}</span>
                    {option.description ? <small>{option.description}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {question.isOther || !question.options?.length ? (
              <input
                type={question.isSecret ? 'password' : 'text'}
                value={answers[question.id]?.answers?.[0] || ''}
                disabled={busy || answered}
                onChange={(event) => setQuestionAnswer(question.id, event.target.value)}
              />
            ) : null}
          </div>
        ))}
        {error || message.error ? <div className="user-input-error">{error || message.error}</div> : null}
        {!answered ? (
          <div className="user-input-actions">
            <button type="button" disabled={busy} onClick={() => submit(answers)}>
              {busy ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
              提交
            </button>
            <button type="button" disabled={busy} onClick={() => submit({})}>
              <X size={15} />
              取消
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

Confirm `HelpCircle`, `Check`, `X`, and `Loader2` are already imported from `lucide-react`; add missing imports if needed.

- [ ] **Step 6: Render the card in `ChatMessage`**

Change `ChatMessage` signature:

```js
function ChatMessage({ message, now, onPreviewImage, onDeleteMessage, onSubmitUserInput }) {
```

Before the activity branch:

```js
  if (message.role === 'user_input_request') {
    return <UserInputRequestMessage message={message} onSubmit={onSubmitUserInput} />;
  }
```

Pass `onSubmitUserInput` through `ChatPane` to `ChatMessage`.

- [ ] **Step 7: Add submit handler**

In `App`, add:

```js
  async function submitUserInput(message, answers) {
    await apiFetch('/api/chat/user-input/respond', {
      method: 'POST',
      body: {
        projectId: selectedProjectRef.current?.id || selectedProject?.id || null,
        sessionId: message.threadId || message.sessionId,
        threadId: message.threadId || message.sessionId,
        turnId: message.turnId,
        itemId: message.itemId,
        answers
      }
    });
  }
```

Pass to `ChatPane`:

```jsx
        onSubmitUserInput={submitUserInput}
```

- [ ] **Step 8: Add CSS**

In `client/src/styles.css`, add:

```css
.user-input-card {
  display: grid;
  gap: 12px;
  border-color: rgba(57, 104, 220, 0.22);
}

.user-input-card-head,
.user-input-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-input-card-head {
  color: #344ec8;
  font-weight: 700;
}

.user-input-question {
  display: grid;
  gap: 8px;
}

.user-input-question p {
  margin: 0;
  color: var(--text);
}

.user-input-options {
  display: grid;
  gap: 8px;
}

.user-input-options button {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  text-align: left;
}

.user-input-options button.is-selected {
  border-color: #4967e8;
  background: rgba(73, 103, 232, 0.08);
}

.user-input-options small {
  color: var(--muted);
}

.user-input-question input {
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--surface);
  color: var(--text);
}

.user-input-actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
}

.user-input-error {
  color: #b42318;
  font-size: 13px;
}
```

- [ ] **Step 9: Run notification tests and build**

Run:

```bash
node --test client/src/notification-events.test.mjs
npm run build
```

Expected: PASS and successful Vite build.

- [ ] **Step 10: Commit**

```bash
git add client/src/App.jsx client/src/styles.css client/src/notification-events.js client/src/notification-events.test.mjs
git commit -m "feat: render plan user input cards"
```

## Task 9: Composer Mode Switch UI

**Files:**
- Modify: `client/src/App.jsx`
- Modify: `client/src/styles.css`

- [ ] **Step 1: Add the mode control JSX**

Inside `Composer`, in `.control-left` after the permission pill, add:

```jsx
            <div className="composer-mode-toggle" role="group" aria-label="协作模式">
              <button
                type="button"
                className={composerMode === 'chat' ? 'is-selected' : ''}
                onClick={() => onSelectComposerMode?.('chat')}
              >
                Chat
              </button>
              <button
                type="button"
                className={composerMode === 'plan' ? 'is-selected' : ''}
                onClick={() => onSelectComposerMode?.('plan')}
              >
                Plan
              </button>
            </div>
```

This is intentionally text rather than icons because the state must be explicit and readable on mobile.

- [ ] **Step 2: Add mode CSS**

In `client/src/styles.css`, near composer controls:

```css
.composer-mode-toggle {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(127, 137, 155, 0.08);
  flex: 0 0 auto;
}

.composer-mode-toggle button {
  height: 24px;
  min-width: 44px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #60666e;
  font-weight: 650;
}

.composer-mode-toggle button.is-selected {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
}

@media (max-width: 380px) {
  .composer-mode-toggle button {
    min-width: 38px;
    padding: 0 6px;
  }
}
```

- [ ] **Step 3: Check narrow control widths**

Run: `npm run build`

Expected: PASS. Then use the in-app browser at `http://127.0.0.1:3321/` or the active local port and inspect 380px width manually. The composer controls should not wrap over the send button.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat: add visible plan mode switch"
```

## Task 10: Full Verification

**Files:**
- No planned source changes unless verification exposes a defect.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test shared/collaboration-mode.test.mjs server/user-input-requests.test.mjs server/chat-service.test.mjs server/codex-app-server.test.mjs server/desktop-ipc-client.test.mjs client/src/composer-shortcuts.test.mjs client/src/plan-mode-client.test.mjs client/src/notification-events.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run all existing tests**

Run: `node --test client/src/*.test.mjs server/*.test.mjs shared/*.test.mjs`

Expected: PASS.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: Vite build succeeds.

- [ ] **Step 4: Manual app-server Plan probe**

Start the app if it is not running:

```bash
npm run start:bg
```

Open the current local app URL. Select `Plan`, send a small planning request in a session that uses headless/background Codex, and verify:

- The browser request body contains `collaborationMode.mode = "plan"`.
- A `turn/plan/updated` event appears as plan activity.
- A synthetic or real `item/tool/requestUserInput` request appears as an answer card.
- Submitting an answer calls `/api/chat/user-input/respond`.
- The blocked turn continues after the answer.

- [ ] **Step 5: Desktop IPC Plan probe**

With Codex Desktop open on an existing thread, select `Plan` in CodexMobile and send a new turn to that thread. Verify:

- `thread-follower-start-turn` receives `turnStartParams.collaborationMode.mode = "plan"`.
- If the desktop app exposes a user-input request to CodexMobile, the answer wrapper works.
- If the desktop app does not expose request details over IPC, record that v1 supports Plan start on desktop IPC but user-input cards require the app-server/headless path until a desktop request-notification channel is available.

- [ ] **Step 6: Final commit if verification fixes were needed**

If verification required fixes:

```bash
git add <changed files>
git commit -m "fix: stabilize plan mode v1"
```

If no fixes were needed, do not create an empty commit.

## Self-Review Notes

- Spec coverage: The plan includes the explicit UI switch, `/plan` shortcuts, new-turn-only `collaborationMode`, structured plan updates, `requestUserInput` pending flow, answer endpoint, and focused tests.
- Desktop IPC uncertainty: The plan includes wrappers and a manual probe, and does not claim complete desktop user-input parity until the live desktop IPC behavior is verified.
- Scope control: Command approvals, file approvals, permission approvals, and MCP elicitation remain outside v1.
