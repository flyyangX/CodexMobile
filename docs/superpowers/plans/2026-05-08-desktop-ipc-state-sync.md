# Desktop IPC State Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move desktop IPC run-state tracking from frontend-only pending refs into the Node bridge, so mobile displays desktop-handoff work through the same backend status stream used by headless runs.

**Architecture:** Keep the existing Desktop IPC protocol and fallback behavior. Add a small server-side desktop turn monitor that watches the desktop thread after a successful handoff, records running/completed state in `chatQueue`, emits normal WebSocket payloads, and refreshes Codex cache on completion. Then simplify the frontend so desktop IPC sends rely on backend status instead of maintaining a separate pending-run book.

**Tech Stack:** Native Node.js ESM, existing `ws` WebSocket broadcast, Codex app-server read APIs, React state hooks, `node:test`.

---

## File Structure

- Create `server/desktop-turn-monitor.js`
  - Owns desktop IPC handoff monitoring.
  - Polls `readSessionMessages(sessionId, { limit, includeActivity: false })`.
  - Detects "the mobile user message has a later assistant reply".
  - Emits `status-update`, `chat-complete`, `chat-error`, `chat-aborted`, and `sync-complete`.
  - Exposes `getActiveRuns()`, `hasActiveWork(sessionId)`, and `abortRun(identifier)`.
- Create `server/desktop-turn-monitor.test.mjs`
  - Tests completion detection, active-run reporting, app/client turn id aliases, abort cleanup, and timeout/failure behavior with fake timers.
- Create `shared/message-identity.js`
  - Moves the existing pure message matching helpers out of `client/src/chat/message-identity.js` so server and frontend use the same "is this the same user message" logic.
- Modify `client/src/chat/message-identity.js`
  - Re-export from `shared/message-identity.js` to keep current imports working.
- Modify `server/chat-service.js`
  - Instantiate the monitor.
  - Start monitor after successful `sendViaDesktopIpc`.
  - Include monitor runs in `sessionHasActiveWork`.
  - Abort desktop IPC monitor runs through `abortChat`.
  - Export `getActiveDesktopIpcRuns()`.
- Modify `server/index.js`
  - Pass `readSessionMessages` into `createChatService`.
  - Include `chatService.getActiveDesktopIpcRuns()` in `/api/status.activeRuns`.
- Modify `client/src/app/useTurnSubmission.js`
  - Remove the special `rememberDesktopIpcPendingRun(...)` branch.
  - After any accepted send, call `pollTurnUntilComplete(...)`; desktop IPC turns will now be visible from `/api/chat/turns/:turnId`.
- Modify `client/src/app/useTurnRuntime.js`
  - Remove `desktopIpcPendingRunsRef` helpers.
  - Preserve local runs based on active polls and turn refresh timers.
  - Keep `source` from payloads when marking runtime so desktop IPC status can still drive live selected-session polling.
- Modify `client/src/app/useSessionLivePolling.js`
  - Remove dependency on `desktopIpcPendingRunsRef`.
  - Allow selected desktop IPC sessions to poll when `threadRuntimeById` says `source: 'desktop-ipc'`.
- Modify `client/src/app/App.jsx`
  - Remove `desktopIpcPendingRunsRef` wiring.
- Modify tests:
  - `server/chat-service.test.mjs`
  - `client/src/app-state.test.mjs`
  - `client/src/session-live-refresh.test.mjs`
  - `client/src/turn-submission-utils.test.mjs` if needed
- Modify `README.md`
  - Correct `GET /api/chat/turns/:sessionId` to `GET /api/chat/turns/:turnId`.

## Task 1: Shared Message Identity

**Files:**
- Create: `shared/message-identity.js`
- Modify: `client/src/chat/message-identity.js`
- Test: `client/src/chat/message-identity.test.mjs`

- [ ] **Step 1: Write/move the shared helper**

Create `shared/message-identity.js` with the existing helper implementation:

```js
function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isMarkdownImageLine(line) {
  return /^!\[[^\]]*\]\((?:<[^>]*>|[^)]*?)\)\s*$/.test(String(line || '').trim());
}

function isLegacyImageAttachmentLine(line) {
  return /^[-*]\s*图片[:：]\s*.*?\s*\(.+\)\s*$/.test(String(line || '').trim());
}

function imageSourceFromLine(line) {
  const text = String(line || '').trim();
  const markdown = text.match(/^!\[[^\]]*\]\((?:<([^>]*)>|([^)]*?))\)\s*$/);
  if (markdown) {
    return normalizeWhitespace(markdown[1] || markdown[2]);
  }
  const legacy = text.match(/^[-*]\s*图片[:：]\s*.*?\s*\((.+)\)\s*$/);
  if (legacy) {
    return normalizeWhitespace(legacy[1]);
  }
  return '';
}

export function userMessageImageSignature(content) {
  return String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(imageSourceFromLine)
    .filter(Boolean)
    .join('|');
}

export function userMessageIdentity(content) {
  const lines = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isMarkdownImageLine(line) && !isLegacyImageAttachmentLine(line));
  return normalizeWhitespace(lines.join('\n').replace(/\n*附件路径[:：]\s*$/g, ''));
}

export function sameUserMessageContent(left, right) {
  const leftIdentity = userMessageIdentity(left);
  const rightIdentity = userMessageIdentity(right);
  if (!leftIdentity || !rightIdentity || leftIdentity !== rightIdentity) {
    return false;
  }
  const leftImages = userMessageImageSignature(left);
  const rightImages = userMessageImageSignature(right);
  return !leftImages || !rightImages || leftImages === rightImages;
}
```

- [ ] **Step 2: Re-export in the client wrapper**

Replace `client/src/chat/message-identity.js` with:

```js
export {
  sameUserMessageContent,
  userMessageIdentity,
  userMessageImageSignature
} from '../../../shared/message-identity.js';
```

- [ ] **Step 3: Verify no frontend behavior changed**

Run:

```bash
node --test client/src/chat/message-identity.test.mjs client/src/session-live-refresh.test.mjs
```

Expected: all tests pass.

## Task 2: Server Desktop Turn Monitor

**Files:**
- Create: `server/desktop-turn-monitor.js`
- Create: `server/desktop-turn-monitor.test.mjs`

- [ ] **Step 1: Write failing tests for monitor lifecycle**

Create tests covering:

```js
test('desktop turn monitor broadcasts completion after assistant appears after the mobile user message', async () => {
  // readSessionMessages first returns only the matched user message.
  // readSessionMessages second returns the matched user message plus assistant reply.
  // Expected:
  // - active run is visible while polling
  // - rememberTurn is called for both appTurnId and clientTurnId
  // - chat-complete is broadcast with source: 'desktop-ipc'
  // - sync-complete is broadcast after refreshCodexCache
});

test('desktop turn monitor keeps running when desktop thread has not caught up yet', async () => {
  // readSessionMessages returns old messages only.
  // Expected:
  // - no completion broadcast
  // - getActiveRuns includes the session and turn ids
});

test('desktop turn monitor aborts by session id and removes active state', async () => {
  // Start a monitor, abort it, then tick timers.
  // Expected:
  // - active run disappears
  // - chat-aborted is broadcast once
});
```

Run:

```bash
node --test server/desktop-turn-monitor.test.mjs
```

Expected before implementation: FAIL because `server/desktop-turn-monitor.js` does not exist.

- [ ] **Step 2: Implement monitor**

The exported factory should have this shape:

```js
export function createDesktopTurnMonitor({
  readSessionMessages,
  refreshCodexCache,
  rememberTurn,
  broadcast,
  now = () => new Date().toISOString(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollDelays = [700, 1000, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000],
  maxPolls = 80
} = {}) {
  const runs = new Map();

  function startRun(run) {
    // Store under both `turnId` and `clientTurnId` when they differ.
    // Broadcast running status with source: 'desktop-ipc'.
    // Poll desktop messages until assistant appears after the matched user message.
  }

  function abortRun(identifier) {
    // Stop timers, remove aliases, remember aborted turn, broadcast chat-aborted.
  }

  function getActiveRuns() {
    // Return public running payloads for /api/status.activeRuns.
  }

  function hasActiveWork(sessionId) {
    // True if session id, previous session id, or either turn id matches.
  }

  return { startRun, abortRun, getActiveRuns, hasActiveWork };
}
```

Detection rule:

```text
Find a user message whose content matches the mobile message using shared `userMessageIdentity`.
After that matched user message, find a non-empty assistant message.
When found, mark completed.
```

Completion payload:

```js
{
  type: 'chat-complete',
  source: 'desktop-ipc',
  projectId,
  sessionId,
  previousSessionId,
  turnId,
  clientTurnId,
  hadAssistantText: true,
  context,
  completedAt
}
```

- [ ] **Step 3: Verify monitor tests pass**

Run:

```bash
node --test server/desktop-turn-monitor.test.mjs
```

Expected: PASS.

## Task 3: Backend Integration

**Files:**
- Modify: `server/chat-service.js`
- Modify: `server/index.js`
- Test: `server/chat-service.test.mjs`

- [ ] **Step 1: Add failing chat-service tests**

Add tests for:

```js
test('sendChat starts server-side desktop IPC monitoring after desktop handoff', async () => {
  // Desktop bridge mode is desktop-ipc.
  // startDesktopFollowerTurn returns app turn id "desktop-turn-1".
  // Expected:
  // - service.getTurn('client-turn') is running
  // - service.getTurn('desktop-turn-1') is running
  // - service.getActiveDesktopIpcRuns() includes source: 'desktop-ipc'
});

test('abortChat can abort a server-side desktop IPC monitor run', async () => {
  // Start a desktop monitor.
  // Abort by session id or client turn id.
  // Expected:
  // - monitor active runs empty
  // - chat-aborted broadcast emitted
});
```

Run:

```bash
node --test server/chat-service.test.mjs
```

Expected before implementation: FAIL because chat service has no monitor integration.

- [ ] **Step 2: Wire monitor into `createChatService`**

Changes:

```js
import { createDesktopTurnMonitor } from './desktop-turn-monitor.js';
```

Add dependency:

```js
readSessionMessages,
```

Create monitor:

```js
const desktopTurnMonitor = createDesktopTurnMonitor({
  readSessionMessages,
  refreshCodexCache,
  rememberTurn,
  broadcast
});
```

After successful `sendViaDesktopIpc(...)`, start monitor before returning:

```js
const result = await sendViaDesktopIpc(...);
desktopTurnMonitor.startRun({
  projectId: project.id,
  sessionId: result.sessionId,
  previousSessionId: draftSessionId || selectedSessionId || null,
  turnId: result.turnId,
  clientTurnId: result.clientTurnId || turnId,
  userMessage: visibleMessage,
  startedAt: new Date().toISOString()
});
return result;
```

Include monitor in active-work checks:

```js
function sessionHasActiveWork(sessionId) {
  return (
    chatQueue.sessionHasActiveWork(sessionId, [
      ...getActiveRuns(),
      ...chatImage.getActiveImageRuns(),
      ...desktopTurnMonitor.getActiveRuns()
    ]) ||
    desktopTurnMonitor.hasActiveWork(sessionId)
  );
}
```

Expose:

```js
getActiveDesktopIpcRuns: desktopTurnMonitor.getActiveRuns,
```

Abort:

```js
const abortedDesktop = desktopTurnMonitor.abortRun(turnId || sessionId);
const aborted = abortCodexTurn(turnId || sessionId) || abortedDesktop;
```

- [ ] **Step 3: Include desktop IPC active runs in status**

In `server/index.js`:

```js
activeRuns: [
  ...getActiveRuns(),
  ...chatService.getActiveDesktopIpcRuns(),
  ...chatService.getActiveImageRuns()
],
```

- [ ] **Step 4: Verify backend tests**

Run:

```bash
node --test server/desktop-turn-monitor.test.mjs server/chat-service.test.mjs server/route-handlers.test.mjs
```

Expected: PASS.

## Task 4: Frontend Simplification

**Files:**
- Modify: `client/src/app/useTurnSubmission.js`
- Modify: `client/src/app/useTurnRuntime.js`
- Modify: `client/src/app/useSessionLivePolling.js`
- Modify: `client/src/app/App.jsx`
- Test: `client/src/app-state.test.mjs`
- Test: `client/src/session-live-refresh.test.mjs`
- Test: `client/src/send-state.test.mjs`

- [ ] **Step 1: Add/update frontend tests**

Expected behavior:

```js
test('status sync preserves server-tracked desktop IPC active runs', () => {
  // status.activeRuns contains { source: 'desktop-ipc', sessionId, turnId }.
  // Expected running badge remains active without desktopIpcPendingRunsRef.
});
```

Run:

```bash
node --test client/src/app-state.test.mjs client/src/session-live-refresh.test.mjs client/src/send-state.test.mjs
```

Expected before implementation: failing assertions around old pending ref assumptions.

- [ ] **Step 2: Remove frontend pending-run book**

Remove:

```js
desktopIpcPendingRunsRef
rememberDesktopIpcPendingRun
completeDesktopIpcPendingRun
```

From:

```text
client/src/app/App.jsx
client/src/app/useTurnRuntime.js
client/src/app/useTurnSubmission.js
client/src/app/useSessionLivePolling.js
```

- [ ] **Step 3: Make desktop IPC sends use normal turn polling**

In `useTurnSubmission.js`, replace the desktop IPC special return path with normal polling:

```js
pollTurnUntilComplete({
  turnId: resultTurnId,
  optimisticSessionId,
  projectId: project.id,
  previousSessionId: draftSessionId || outgoingSessionId
});
```

Keep `markRun(...)` so the UI updates immediately, but do not store a separate pending run ref.

- [ ] **Step 4: Keep live selected-session polling based on runtime source**

In `useTurnRuntime.markRun`, preserve:

```js
source: payload.source || null
```

In `useSessionLivePolling`, use:

```js
const hasExternalThreadRefresh = Boolean(hasDesktopThreadRuntime);
```

The frontend may still poll the selected desktop thread for fresh messages, but it no longer decides global run completion by itself.

- [ ] **Step 5: Verify frontend tests**

Run:

```bash
node --test client/src/app-state.test.mjs client/src/session-live-refresh.test.mjs client/src/send-state.test.mjs client/src/turn-submission-utils.test.mjs
```

Expected: PASS.

## Task 5: Documentation and Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Fix API wording**

Change:

```text
GET /api/chat/turns/:sessionId
```

To:

```text
GET /api/chat/turns/:turnId
```

- [ ] **Step 2: Run targeted test suite**

Run:

```bash
node --test \
  shared/*.test.mjs \
  client/src/app-state.test.mjs \
  client/src/session-live-refresh.test.mjs \
  client/src/send-state.test.mjs \
  client/src/turn-submission-utils.test.mjs \
  server/desktop-turn-monitor.test.mjs \
  server/chat-service.test.mjs \
  server/codex-app-server.test.mjs \
  server/desktop-ipc-client.test.mjs \
  server/route-handlers.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run full repository tests**

Run:

```bash
node --test client/src/*.test.mjs client/src/chat/*.test.mjs server/*.test.mjs shared/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 4: Build**

Run:

```bash
npm run build
```

Expected: build succeeds. Existing Vite chunk-size warning is acceptable.

- [ ] **Step 5: Local smoke**

Start:

```bash
CODEXMOBILE_HOME="$(mktemp -d /tmp/codexmobile-auth-XXXXXX)" \
PORT=3344 \
HTTPS_PORT=3454 \
CODEXMOBILE_PAIRING_CODE_LENGTH=10 \
CODEXMOBILE_SYNC_RESPONSE_TIMEOUT_MS=20000 \
npm start
```

Smoke:

```text
POST /api/pair
GET /api/status
POST /api/sync
GET /api/projects
GET /api/projects/:id/sessions
GET /api/sessions/:id/messages?limit=5&activity=1
POST /api/chat/send with empty message and expect 400
GET /
```

Expected: all normal routes pass and no real chat task is sent during generic smoke.

- [ ] **Step 6: Real desktop IPC smoke**

Use one harmless desktop-open test thread only after confirming the desktop app has an open owner for that thread.

Expected:

```text
Mobile send returns desktopBridge.mode = desktop-ipc.
/api/status.activeRuns includes source = desktop-ipc while the desktop turn is running.
WebSocket receives status-update running from backend.
When desktop assistant reply appears, backend broadcasts chat-complete and sync-complete.
Frontend no longer needs desktopIpcPendingRunsRef to clear running state.
```

If a real desktop thread cannot be safely used, stop after unit/integration/local smoke and report that desktop IPC live validation is pending a safe test thread.

## Non-Goals

- Do not migrate away from native Node `http/ws`.
- Do not change the Desktop IPC protocol.
- Do not require desktop Codex to be open for mobile background execution.
- Do not promise token-by-token desktop streaming unless Desktop IPC exposes those events.
- Do not send real test prompts into the user's important working threads without explicit confirmation.

## Risk Notes

- The main risk is double-completion: WebSocket `chat-complete`, turn polling, and session live polling can all observe completion. Mitigation: use idempotent message/status upserts and monitor aliases for both `turnId` and `clientTurnId`.
- The second risk is false completion if an old assistant reply is mistaken for the new mobile send. Mitigation: match the mobile user message first, then require an assistant message after that matched user message.
- The third risk is frontend status flicker after `/api/status` refresh. Mitigation: include desktop IPC runs in `/api/status.activeRuns` so status refresh reinforces, rather than clears, the running badge.

## Self-Review

- Spec coverage: The plan moves desktop IPC status ownership to the backend, keeps current background fallback behavior, preserves real message sync, and includes tests plus live smoke.
- Placeholder scan: No task depends on "TBD" or unspecified implementation.
- Type consistency: Monitor payloads consistently use `projectId`, `sessionId`, `previousSessionId`, `turnId`, `clientTurnId`, `source: 'desktop-ipc'`, `startedAt`, and `completedAt`.
