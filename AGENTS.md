# AGENTS.md

This file is the first context for future agents working in this repository. Read it before touching code. CodexMobile is a personal, local-first Codex mobile workbench; protect existing behavior first, then improve extensibility.

本文件是 CodexMobile 的项目级指导文档。它不是普通 README，而是给后续 Codex / agent / 人工协作者看的架构边界、代码生成规则和重构护栏。进入本仓库后，先按这里的规则判断能不能改、改到哪里、怎么验证。

## Project Identity

- CodexMobile is a local Codex mobile workbench: the Mac remains the real execution environment, and the iPhone PWA is the mobile control surface.
- It is not a SaaS product, not a remote desktop tool, not a generic chat app, and not a thin upstream fork UI.
- The core product promise is continuity with the user's real local Codex workflow: desktop threads, local files, skills, Git state, execution activity, and private-network access.
- The project may learn from upstream or remodex-style UX ideas, but the architecture must serve CodexMobile's own Desktop IPC and local-workflow route.

## Non-Negotiable Product Behaviors

- Desktop IPC is the preferred path for existing desktop threads. Do not replace it with a mobile-only or headless-only flow.
- Mobile and desktop thread visibility should stay aligned where current Desktop IPC/app-server capabilities allow it.
- Execution process text must not be lost. Completed activity may default to collapsed, but expanding it must preserve the full trace.
- Running tasks must continue to support `steer`, `queue`, and `interrupt`.
- Queue drafts must remain viewable, restorable, removable, and steerable into the current running task.
- `$skill` autocomplete must attach the selected skill structurally and must not leak the raw `$token` into the model message.
- `@file` autocomplete must keep the visible short path in the composer and send the real local path as file mention context.
- iOS background notifications require HTTPS plus an installed Home Screen PWA. Do not pretend ordinary HTTP LAN access supports Web Push.
- Local HTTP/LAN access should still work for chat, sync, foreground toast, and normal PWA use.
- Pairing code and trusted device token behavior must remain private-network and single-user oriented.
- The dedicated voice/audio dialog has been removed. Do not reintroduce ASR, TTS, realtime voice, microphone capture, or `/api/voice/*` without an explicit product decision.

## Architecture Direction

- Refactor in this order:
  1. Split frontend `client/src/App.jsx`.
  2. Split server API routes out of `server/index.js`.
  3. Split `server/chat-service.js` internals.
- Frontend state direction: React reducer/context. Do not add Redux, Zustand, or TypeScript during this refactor unless the user explicitly changes this rule.
- Backend direction: keep the current Node.js native HTTP server. Do not introduce Express or another router framework during this refactor.
- Preserve all public API paths, request/response shapes, and WebSocket payload names unless a task explicitly asks for a breaking change.
- Prefer small, behavior-preserving moves over clever rewrites.

## Frontend Rules

- Do not put new features directly into `client/src/App.jsx`. Add or move code into focused modules.
- `client/src/App.jsx` should remain a wrapper. The real app shell lives under `client/src/app/`.
- Target directory responsibilities:
  - `client/src/app/`: App provider, reducer/context, bootstrap, websocket hooks, top-level orchestration.
  - `client/src/chat/`: message list, chat messages, activity rendering, generated image display, image preview.
  - `client/src/composer/`: composer UI, attachment tray, queue draft panel, slash/file/skill autocomplete, send-mode controls.
  - `client/src/panels/`: Drawer, TopBar, GitPanel, DocsPanel, ToastStack, ConnectionRecoveryCard.
  - `client/src/utils/`: pure formatting, path, image URL, clipboard, and browser utility helpers.
- Keep component files focused. If a component grows past roughly 500 lines, split subcomponents or move behavior into a hook.
- Hard size guide:
  - React component file target: under 500 lines.
  - React component file above 700 lines: split before adding more behavior.
  - React hook target: under 400 lines.
  - React hook above 600 lines: extract reducer, state-machine helpers, or pure functions.
  - Pure frontend utility module target: under 300 lines unless it is mostly stable lookup data.
  - CSS surface file target: under 700 lines; above 1000 lines should be split by panel/component/state.
- Keep pure logic in plain `.js` modules with tests where possible; UI files should not be the only place business rules live.
- Preserve mobile ergonomics: check `390x844` when changing composer, panels, chat activity, or first-run screens.
- Do not change class names while splitting CSS unless the change is deliberate and visually verified.
- Avoid putting async data loading, WebSocket dispatch, activity merging, and DOM scroll behavior in the same component. Prefer a hook plus a small presentational component.
- Keep mobile-first layout constraints explicit: stable heights, scroll containers, safe-area padding, and composer controls must not overlap.

## Backend Rules

- Do not add more route branches directly to the large `handleApi` chain in `server/index.js`; use route modules after the router split begins.
- Target route modules:
  - `server/routes/public-routes.js`
  - `server/routes/system-routes.js`
  - `server/routes/chat-routes.js`
  - `server/routes/session-routes.js`
  - `server/routes/git-routes.js`
  - `server/routes/notification-routes.js`
  - `server/routes/upload-routes.js`
  - `server/routes/feishu-routes.js`
  - `server/routes/file-routes.js`
- Keep auth order compatible: `/api/status`, `/api/pair`, and Feishu callback may be unauthenticated; other API routes require the existing token check.
- Target chat internals:
  - `server/chat/turn-registry.js`: recent turn state and event memory.
  - `server/chat/queue-service.js`: queue list/delete/restore/steer state.
  - `server/chat/delivery-service.js`: Desktop IPC, background fallback, steer, interrupt, and image-route delivery.
  - `server/chat/message-builders.js`: attachments, file mentions, visible message, model message.
- Backend size guide:
  - `server/index.js` target: mostly startup, auth ordering, service wiring, and WebSocket upgrade handling. Avoid growing it past roughly 450 lines.
  - Route module target: under 150 lines. Larger route modules should split helper/service logic out of the route file.
  - General service target: under 700 lines.
  - Complex core service temporary ceiling: 900 lines. If a file grows beyond this, split by domain before adding features.
  - Pure helper module target: under 300 lines.
- Keep `chatService` public methods compatible: `sendChat`, `abortChat`, `listQueue`, `removeQueuedDraft`, `restoreQueuedDraft`, `steerQueuedDraft`, `sessionHasActiveWork`, `getTurn`, `getActiveImageRuns`, and `rememberTurnEvent`.
- Keep generated files, uploads, push state, auth state, and local Codex data under `.codexmobile` or the existing local state paths.
- Router raw-body behavior matters. Upload routes must not have their request streams consumed by JSON body parsing before their handlers run.

## Testing And Verification

- For normal code changes, run:

```bash
node --test client/src/*.test.mjs server/*.test.mjs shared/*.test.mjs
npm run build
```

- For documentation-only changes, at minimum run:

```bash
git diff --check
```

- For UI changes, also verify a mobile viewport around `390x844`.
- For Web Push/PWA changes, verify secure-context behavior and do not rely on ordinary HTTP.
- For Desktop IPC behavior, verify `/api/status` still reports the expected `desktop-ipc` bridge when the desktop app is connected.
- For activity rendering changes, verify completed activity is collapsed by default and still expands to full text.

## Refactor Guardrails

- Refactor commits must not mix in new product features.
- Move one subsystem at a time, run tests, then continue.
- Preserve existing tests and add focused tests before moving fragile logic.
- Prefer extracting existing behavior as-is before simplifying it.
- Keep compatibility shims temporarily if they reduce risk during a split.
- Avoid broad rename churn unless it makes the new boundary clearer.
- Do not delete a legacy path until the replacement is tested and all callers are migrated.
- Keep changes friendly to future agents: small files, clear exports, no hidden global state unless it represents a real external resource such as a socket, timer, or DOM ref.
- The desired module shape is boring and explicit: one reason to change, small public surface, testable pure helpers, and no surprise side effects.
- Split by product behavior, not by arbitrary technology layer. For example, queue behavior belongs together even if it touches status payloads, drafts, and send actions.
- Do not chase tiny files for their own sake. Splitting is good only when it improves readability, testability, or future feature work.
- After each behavior-preserving split, run the normal test/build command before starting the next split.

## Do Not Do

- Do not remove Desktop IPC as the primary existing-thread path.
- Do not make mobile-only local sessions the default for desktop-origin threads.
- Do not drop activity text, command output, reasoning summaries, or file activity during UI cleanup.
- Do not send `$skill` tokens to the model as plain text.
- Do not send fake or shortened file mention paths when the real path is required as context.
- Do not introduce Redux, Zustand, TypeScript, Express, or a CSS framework without explicit user approval.
- Do not add voice/audio dependencies, ASR containers, realtime voice websockets, or hidden microphone permissions unless the user explicitly asks to bring that feature back.
- Do not commit `.env`, `.codexmobile`, certificates, logs, uploads, generated images, screenshots, or local auth data.
- Do not run destructive Git commands such as `git reset --hard` or `git checkout --` unless the user explicitly asks for that exact operation.

## Quick Context For Future Agents

- Current product route: local-first Codex mobile workbench for iPhone PWA.
- Current technical stack: React 18, Vite, Node.js native HTTP/WebSocket, `@openai/codex-sdk`, Desktop IPC, optional local integrations.
- Current frontend status: `client/src/App.jsx` is a wrapper, and the real app orchestration lives in `client/src/app/App.jsx`. Do not move new behavior back into the wrapper.
- Current backend status: `server/index.js` has been reduced to startup/auth/service wiring. New API behavior should go into `server/routes/*` and service modules.
- Current biggest maintainability risks:
  - `client/src/chat/ChatPane.jsx`: still too large; split message list, individual message rendering, activity timeline, image handling, and scroll behavior.
  - `server/codex-data.js`: too large; split cache loading, project/session shaping, message reading, and desktop/mobile index reconciliation.
  - `server/codex-runner.js`: too large; split process lifecycle, event parsing, activity mapping, and abort handling.
  - `client/src/styles/panels.css`: too large; split by panel surface once UI behavior is stable.
- Current sensitive core: `server/chat-service.js`, because it still coordinates queue, Desktop IPC, image routing, background fallback, and turn state. It has started splitting into `server/chat/*`; continue with `delivery-service.js` only with strong tests.
- Default safe workflow: inspect first, write or update focused tests, make the smallest behavior-preserving change, run verification, then commit.
