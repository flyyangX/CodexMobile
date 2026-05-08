# CodexMobile Adaptive Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn CodexMobile's desktop view into a usable adaptive shell with a docked collapsible drawer, wider chat/composer column, and desktop paste/drag file upload.

**Architecture:** Keep the existing `App.jsx` component structure and make the first pass CSS-first. Add one focused helper module for paste/drop file extraction so upload behavior can be tested without rendering the full React app. Reuse the existing `/api/uploads` and `attachments` flow.

**Tech Stack:** React 18, Vite, Node.js built-in `node:test`, CSS media queries, existing CodexMobile upload API.

---

## File Structure

- Create `client/src/upload-inputs.js`: pure helpers for clipboard/drop file extraction and drag file detection.
- Create `client/src/upload-inputs.test.mjs`: unit tests for paste/drop extraction behavior.
- Modify `client/src/App.jsx`: import upload helpers, add composer paste/drop handlers, add desktop drawer collapse state, and wire the top menu button to mobile open vs desktop collapse behavior.
- Modify `client/src/styles.css`: replace the desktop phone-frame breakpoint with a `>=1024px` adaptive shell, dock/collapse the drawer, widen chat/composer, and style the drop overlay.

Do not modify `server/codex-app-server.js`; it has unrelated local changes.

---

### Task 1: Upload Input Extraction Helpers

**Files:**
- Create: `client/src/upload-inputs.js`
- Create: `client/src/upload-inputs.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `client/src/upload-inputs.test.mjs` with:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dragEventHasFiles,
  filesFromClipboardEvent,
  filesFromDropEvent
} from './upload-inputs.js';

function fakeFile(name, type) {
  return { name, type, size: 1234 };
}

function fakeClipboardItem(file) {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => file
  };
}

test('filesFromClipboardEvent extracts only pasted image files', () => {
  const image = fakeFile('plot.png', 'image/png');
  const textFile = fakeFile('notes.txt', 'text/plain');
  const event = {
    clipboardData: {
      items: [
        fakeClipboardItem(image),
        fakeClipboardItem(textFile),
        { kind: 'string', type: 'text/plain', getAsFile: () => null }
      ],
      files: []
    }
  };

  assert.deepEqual(filesFromClipboardEvent(event), [image]);
});

test('filesFromClipboardEvent ignores plain text paste', () => {
  const event = {
    clipboardData: {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: []
    }
  };

  assert.deepEqual(filesFromClipboardEvent(event), []);
});

test('filesFromClipboardEvent falls back to clipboardData.files for images', () => {
  const image = fakeFile('clipboard.jpg', 'image/jpeg');
  const event = {
    clipboardData: {
      items: [],
      files: [image, fakeFile('document.pdf', 'application/pdf')]
    }
  };

  assert.deepEqual(filesFromClipboardEvent(event), [image]);
});

test('filesFromDropEvent returns all dropped files', () => {
  const image = fakeFile('screen.png', 'image/png');
  const sheet = fakeFile('table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const event = {
    dataTransfer: {
      files: [image, sheet]
    }
  };

  assert.deepEqual(filesFromDropEvent(event), [image, sheet]);
});

test('dragEventHasFiles detects drag payloads that include files', () => {
  assert.equal(dragEventHasFiles({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(dragEventHasFiles({ dataTransfer: { types: ['Files'] } }), true);
  assert.equal(dragEventHasFiles({ dataTransfer: { files: [fakeFile('a.png', 'image/png')] } }), true);
});
```

- [ ] **Step 2: Run tests to verify they fail because the module is missing**

Run:

```powershell
node --test client/src/upload-inputs.test.mjs
```

Expected: FAIL with an import/module-not-found error for `client/src/upload-inputs.js`.

- [ ] **Step 3: Add the minimal helper implementation**

Create `client/src/upload-inputs.js` with:

```js
function asArray(value) {
  return Array.from(value || []);
}

function isImageFile(file) {
  return Boolean(file && String(file.type || '').startsWith('image/'));
}

export function filesFromClipboardEvent(event) {
  const data = event?.clipboardData;
  if (!data) {
    return [];
  }

  const itemFiles = asArray(data.items)
    .filter((item) => item?.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile?.())
    .filter(isImageFile);

  if (itemFiles.length) {
    return itemFiles;
  }

  return asArray(data.files).filter(isImageFile);
}

export function filesFromDropEvent(event) {
  return asArray(event?.dataTransfer?.files).filter(Boolean);
}

export function dragEventHasFiles(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) {
    return false;
  }
  if (asArray(transfer.files).length > 0) {
    return true;
  }
  return asArray(transfer.types).includes('Files');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
node --test client/src/upload-inputs.test.mjs
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the helper**

Run:

```powershell
git add client/src/upload-inputs.js client/src/upload-inputs.test.mjs
git commit -m "feat: add upload input extraction helpers"
```

---

### Task 2: Composer Paste And Drag/Drop Upload

**Files:**
- Modify: `client/src/App.jsx`
- Test: `client/src/upload-inputs.test.mjs`

- [ ] **Step 1: Run the focused helper tests before wiring React**

Run:

```powershell
node --test client/src/upload-inputs.test.mjs
```

Expected: PASS. This guards the helper behavior before UI wiring.

- [ ] **Step 2: Import the helper functions**

In `client/src/App.jsx`, add this import next to the other local imports:

```js
import {
  dragEventHasFiles,
  filesFromClipboardEvent,
  filesFromDropEvent
} from './upload-inputs.js';
```

- [ ] **Step 3: Add drag state and handlers inside `Composer`**

Inside `function Composer(...)`, after the existing `useState` calls for `openMenu`, `skillFilter`, `cursorPosition`, and `fileSearch`, add:

```js
  const [dragDepth, setDragDepth] = useState(0);
  const dropActive = dragDepth > 0;
```

After `handleFiles(event, kind)`, add:

```js
  function uploadFiles(files) {
    if (!files.length) {
      return;
    }
    onUploadFiles(files);
    setOpenMenu(null);
  }

  function handlePaste(event) {
    const files = filesFromClipboardEvent(event);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    uploadFiles(files);
  }

  function handleDragEnter(event) {
    if (!dragEventHasFiles(event)) {
      return;
    }
    event.preventDefault();
    setDragDepth((value) => value + 1);
  }

  function handleDragOver(event) {
    if (!dragEventHasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(event) {
    if (!dragEventHasFiles(event)) {
      return;
    }
    event.preventDefault();
    setDragDepth((value) => Math.max(0, value - 1));
  }

  function handleDrop(event) {
    if (!dragEventHasFiles(event)) {
      return;
    }
    event.preventDefault();
    setDragDepth(0);
    uploadFiles(filesFromDropEvent(event));
  }
```

- [ ] **Step 4: Wire the form and textarea events**

Change the `<form>` opening tag in `Composer` from:

```jsx
    <form className="composer-wrap" onSubmit={submit}>
```

to:

```jsx
    <form
      className={`composer-wrap ${dropActive ? 'is-drop-active' : ''}`}
      onSubmit={submit}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
```

Add `onPaste={handlePaste}` to the existing `<textarea>`:

```jsx
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setCursorPosition(event.target.selectionStart ?? event.target.value.length);
          }}
          onClick={updateCursorFromTextarea}
          onKeyUp={updateCursorFromTextarea}
          onFocus={() => setOpenMenu(null)}
          onPaste={handlePaste}
          placeholder="给 Codex 发送消息"
        />
```

- [ ] **Step 5: Add the drop overlay markup**

Just before `<div className="composer">`, add:

```jsx
      {dropActive ? (
        <div className="composer-drop-overlay" aria-hidden="true">
          <UploadCloud size={22} />
          <span>松开上传到当前消息</span>
        </div>
      ) : null}
```

- [ ] **Step 6: Run focused tests and build**

Run:

```powershell
node --test client/src/upload-inputs.test.mjs
npm run build
```

Expected: helper tests pass and Vite build succeeds.

- [ ] **Step 7: Commit the composer upload wiring**

Run:

```powershell
git add client/src/App.jsx
git commit -m "feat: support composer paste and drop uploads"
```

---

### Task 3: Desktop Drawer Collapse State

**Files:**
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Add desktop drawer state**

In `App`, near the existing drawer state:

```js
  const [drawerOpen, setDrawerOpen] = useState(false);
```

add:

```js
  const [desktopDrawerCollapsed, setDesktopDrawerCollapsed] = useState(false);
```

- [ ] **Step 2: Add a menu handler that opens mobile drawer or toggles desktop drawer**

Near the existing `handleOpenDocsAuth` function and before `shellClass`, add:

```js
  function handleShellMenu() {
    if (window.matchMedia?.('(min-width: 1024px)').matches) {
      setDesktopDrawerCollapsed((value) => !value);
      return;
    }
    setDrawerOpen(true);
  }
```

- [ ] **Step 3: Update shell class generation**

Replace:

```js
  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);
```

with:

```js
  const shellClass = useMemo(
    () => [
      'app-shell',
      drawerOpen ? 'drawer-active' : '',
      desktopDrawerCollapsed ? 'desktop-drawer-collapsed' : ''
    ].filter(Boolean).join(' '),
    [desktopDrawerCollapsed, drawerOpen]
  );
```

- [ ] **Step 4: Wire `TopBar` to the new menu handler**

Change the `TopBar` prop from:

```jsx
        onMenu={() => setDrawerOpen(true)}
```

to:

```jsx
        onMenu={handleShellMenu}
```

- [ ] **Step 5: Keep drawer close behavior mobile-safe**

Leave the existing `Drawer` props unchanged:

```jsx
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
```

The desktop docked/collapsed visual state will be controlled by `.app-shell.desktop-drawer-collapsed` in CSS. Mobile overlay behavior continues to rely on `drawerOpen`.

- [ ] **Step 6: Build to verify React compiles**

Run:

```powershell
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 7: Commit the shell state wiring**

Run:

```powershell
git add client/src/App.jsx
git commit -m "feat: add adaptive drawer shell state"
```

---

### Task 4: Adaptive Desktop Layout CSS

**Files:**
- Modify: `client/src/styles.css`

- [ ] **Step 1: Preserve the existing medium-width phone frame only below desktop**

Change:

```css
@media (min-width: 820px) {
```

to:

```css
@media (min-width: 820px) and (max-width: 1023.98px) {
```

- [ ] **Step 2: Add the desktop adaptive shell media query**

Add this new block before the existing `@media (max-width: 480px)` section:

```css
@media (min-width: 1024px) {
  body {
    display: block;
    background: var(--surface);
  }

  #root {
    width: 100%;
    height: var(--app-height, 100dvh);
    border: 0;
    box-shadow: none;
  }

  .app-shell {
    position: fixed;
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "drawer top"
      "drawer chat"
      "drawer composer";
    width: 100vw;
    max-width: 100vw;
    height: var(--app-height, 100dvh);
    transition: grid-template-columns 180ms ease;
  }

  .app-shell.desktop-drawer-collapsed {
    grid-template-columns: 0 minmax(0, 1fr);
  }

  .top-bar {
    grid-area: top;
    padding: 12px 24px 10px;
  }

  .drawer-backdrop {
    display: none;
  }

  .drawer {
    grid-area: drawer;
    position: relative;
    top: auto;
    bottom: auto;
    left: auto;
    width: 100%;
    min-width: 0;
    height: 100%;
    padding: 18px 16px;
    border-right: 1px solid var(--hairline);
    background: rgba(250, 251, 250, 0.94);
    box-shadow: none;
    transform: none;
    transition: opacity 140ms ease;
    z-index: 15;
  }

  [data-theme="dark"] .drawer {
    background: rgba(26, 26, 27, 0.96);
  }

  .app-shell.desktop-drawer-collapsed .drawer {
    width: 0;
    padding-right: 0;
    padding-left: 0;
    border-right: 0;
    opacity: 0;
    pointer-events: none;
  }

  .drawer-header .icon-button,
  .drawer-subheader .icon-button:last-child {
    display: none;
  }

  .chat-pane {
    grid-area: chat;
    max-width: none;
    padding: 24px 24px 18px;
  }

  .chat-content {
    max-width: 1040px;
  }

  .message-stack {
    max-width: min(78%, 760px);
  }

  .message-row.is-assistant .message-stack {
    max-width: 100%;
  }

  .composer-wrap {
    grid-area: composer;
    max-width: none;
    padding: 8px 24px 18px;
  }

  .composer-wrap > .queued-drafts-panel,
  .composer-wrap > .composer-run-status,
  .composer-wrap > .composer {
    width: min(1040px, 100%);
    margin-right: auto;
    margin-left: auto;
  }

  .shortcut-menu {
    right: max(24px, calc((100vw - 1040px) / 2));
    left: max(24px, calc((100vw - 1040px) / 2));
  }

  .attach-menu {
    left: max(24px, calc((100vw - 1040px) / 2));
  }

  .permission-menu {
    left: max(66px, calc((100vw - 1040px) / 2 + 42px));
  }

  .skill-menu {
    left: max(118px, calc((100vw - 1040px) / 2 + 94px));
  }

  .model-menu,
  .send-mode-menu {
    right: max(24px, calc((100vw - 1040px) / 2));
  }

  .context-popover {
    right: max(108px, calc((100vw - 1040px) / 2 + 84px));
  }
}
```

- [ ] **Step 3: Add drop overlay styles**

Near the existing `.composer-wrap` / `.composer` styles, add:

```css
.composer-drop-overlay {
  position: absolute;
  inset: 7px 12px calc(env(safe-area-inset-bottom, 0px) + 8px);
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px dashed rgba(37, 99, 235, 0.48);
  border-radius: 24px;
  color: var(--accent);
  background: rgba(231, 239, 255, 0.88);
  box-shadow: var(--soft-shadow);
  pointer-events: none;
}

[data-theme="dark"] .composer-drop-overlay {
  background: rgba(37, 99, 235, 0.18);
}
```

Inside the `@media (min-width: 1024px)` block, add:

```css
  .composer-drop-overlay {
    inset: 8px max(24px, calc((100vw - 1040px) / 2)) 18px;
    width: min(1040px, calc(100% - 48px));
    margin-right: auto;
    margin-left: auto;
  }
```

- [ ] **Step 4: Build to catch CSS/JS regressions**

Run:

```powershell
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 5: Commit the adaptive CSS**

Run:

```powershell
git add client/src/styles.css
git commit -m "feat: add adaptive desktop shell layout"
```

---

### Task 5: Full Verification

**Files:**
- Verify: `client/src/upload-inputs.test.mjs`
- Verify: existing `client/src/*.test.mjs`
- Verify: built app in browser

- [ ] **Step 1: Run all existing client unit tests**

Run:

```powershell
node --test client/src/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: Vite build succeeds and writes `client/dist`.

- [ ] **Step 3: Start the app for browser checks**

Run:

```powershell
npm start
```

Expected: server starts on the configured port, usually `http://127.0.0.1:3321`.

If port `3321` is already in use, stop the existing CodexMobile server or use the port printed by the running server.

- [ ] **Step 4: Verify desktop layout in browser**

Open the app at desktop width `>=1024px` and confirm:

- The app fills the browser viewport instead of appearing as a centered `430px` phone shell.
- The drawer is docked on the left.
- Pressing the menu button collapses the left drawer.
- Pressing the menu button again restores the left drawer.
- The chat content and composer are visually aligned around a `1040px` main column.
- Long assistant messages and code blocks do not appear cramped.

- [ ] **Step 5: Verify mobile layout in browser**

Open the app at mobile width around `390px` and confirm:

- The drawer starts hidden.
- Pressing the menu button opens the overlay drawer.
- The backdrop appears and closes the drawer.
- Composer controls still fit without overlap.

- [ ] **Step 6: Verify upload interactions manually**

In desktop browser:

- Copy an image to the clipboard and paste into the composer.
- Confirm an attachment chip appears.
- Drag an image file into the chat/composer area.
- Confirm the drop overlay appears while dragging.
- Drop the file and confirm an attachment chip appears.
- Drag a non-image file such as `.txt` or `.xlsx` into the chat/composer area.
- Confirm it uploads as an attachment chip.

- [ ] **Step 7: Final git status check**

Run:

```powershell
git status --short
```

Expected: clean except for unrelated pre-existing `server/codex-app-server.js` if it remains intentionally uncommitted.

If verification required small fixes, commit those fixes:

```powershell
git add client/src/App.jsx client/src/styles.css client/src/upload-inputs.js client/src/upload-inputs.test.mjs
git commit -m "fix: polish adaptive shell verification issues"
```

---

## Self-Review

Spec coverage:

- Desktop full-width shell: Task 4.
- Docked/collapsible drawer: Tasks 3 and 4.
- Mobile overlay preserved: Tasks 3, 4, and Task 5 manual checks.
- Wider chat/composer: Task 4.
- Paste image upload: Tasks 1 and 2.
- Drag/drop image and file upload: Tasks 1 and 2.
- Existing upload API reuse: Task 2 uses `onUploadFiles`, no backend task exists.
- Build/tests/browser verification: Task 5.

Type and naming consistency:

- Helper names are `filesFromClipboardEvent`, `filesFromDropEvent`, and `dragEventHasFiles` in tests, implementation, and `App.jsx`.
- Shell class is `desktop-drawer-collapsed` in React and CSS.
- Drop overlay class is `composer-drop-overlay` in JSX and CSS.

Scope check:

- The plan does not add a right panel, backend endpoint, visual rebrand, or broad `App.jsx` split.
