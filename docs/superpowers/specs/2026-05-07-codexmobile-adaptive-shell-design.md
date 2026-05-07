# CodexMobile Adaptive Shell Design

Date: 2026-05-07
Status: Approved for implementation planning

## Goal

Build a v1 adaptive desktop shell for CodexMobile while preserving the existing iPhone-first PWA experience. The first release should remove the 430px desktop phone-frame constraint, make the left project/session drawer efficient on desktop, widen the chat/composer reading surface, and add desktop-friendly image/file input through paste and drag/drop.

## Approved Direction

The selected direction is "v1 adaptive shell" implemented with a CSS-first layout change plus small React interaction additions. This intentionally avoids a broad component split or a full three-pane desktop redesign in the first pass.

## Scope

In scope:

- At desktop width `>=1024px`, use the full browser viewport instead of centering a `430px` mobile shell.
- Dock the left drawer by default on desktop.
- Keep the desktop drawer collapsible so the chat area can take the full width when needed.
- Keep mobile and narrow tablet behavior as the current overlay drawer.
- Increase desktop chat readability by widening the main content column and composer.
- Support `Ctrl+V` / `Cmd+V` image paste in the composer.
- Support dragging images and files into the chat/composer area.
- Reuse the existing `/api/uploads` endpoint and `attachments` state.

Out of scope for this first pass:

- A full three-pane layout with a persistent right details panel.
- A broad split of `App.jsx` into many files.
- Reworking the visual brand, theme palette, or message rendering model.
- New backend upload APIs.
- Rich clipboard HTML import.

## Architecture

The existing front-end component model remains in place. `TopBar`, `Drawer`, `ChatPane`, and `Composer` continue to live in `client/src/App.jsx`; `client/src/styles.css` owns the responsive shell behavior.

Desktop layout is controlled through media queries and a small amount of shell state:

- Mobile/narrow layout remains `grid-template-rows: auto 1fr auto`.
- Desktop layout becomes a two-column app shell when the drawer is docked: left drawer plus main chat stack.
- The main chat stack contains top bar, chat pane, and composer.
- Drawer collapse state changes the desktop grid columns without changing the mobile drawer behavior.

Upload input normalization should be separated into a small pure helper so paste/drop extraction can be tested without rendering the full React app.

## Component Design

### App Shell

`App` will keep the existing `drawerOpen` state for mobile overlay behavior and add a desktop-oriented drawer state such as `desktopDrawerCollapsed`. The shell class can expose the state through class names such as:

- `app-shell`
- `drawer-active`
- `desktop-drawer-collapsed`

CSS should decide which states matter at each viewport width. At mobile widths, `drawerOpen` continues to control the overlay drawer. At desktop widths, the drawer is docked unless collapsed.

### TopBar

On mobile, the menu button continues to open the drawer.

On desktop, the same control becomes a drawer collapse/expand toggle. The rest of the top-bar actions remain in the existing menu model for v1.

### Drawer

On mobile, `Drawer` stays fixed, hidden by default, and opened over a backdrop.

On desktop, `Drawer` is visually docked:

- No backdrop.
- No slide-in transform for the open state.
- Width target: about `300px` to `340px`.
- Height follows the app viewport.
- Scrolling stays inside the drawer.

When collapsed, the drawer should not block the chat. The collapse affordance must remain discoverable through the top-bar menu button or a narrow rail.

### ChatPane

Desktop `ChatPane` should use the available viewport and keep the reading column constrained for readability. The target desktop content max width is `960px` to `1100px`, wider than the current `820px` but not full-bleed text.

Assistant messages remain a wide reading flow. User messages remain right-aligned bubbles.

### Composer

`Composer` gains paste and drag/drop handlers while reusing the current upload pathway.

Paste behavior:

- Inspect `clipboardData.items` / `clipboardData.files`.
- Extract only file items with MIME type `image/*`.
- If image files are found, prevent the browser's default image paste handling and call `onUploadFiles(files)`.
- If no image file is found, do not prevent default so normal text paste works.

Drag/drop behavior:

- When the drag payload includes files, show a lightweight drop overlay.
- Prevent the browser from navigating to dropped files.
- On drop, call `onUploadFiles(files)` with all dropped files.
- Hide the overlay on successful drop, cancel, or leaving the drop zone.

## Data Flow

The upload data flow stays unchanged:

1. `Composer` receives pasted or dropped `File` objects.
2. `Composer` calls `onUploadFiles(files)`.
3. `App.handleUploadFiles` sets `uploading`.
4. Each file is posted to `/api/uploads` as `multipart/form-data`.
5. Successful uploads append `result.upload` to `attachments`.
6. The existing send flow includes `attachments` with the message.

No backend changes are required for v1.

## Error Handling

Upload failures continue to use the existing activity-message error path in `handleUploadFiles`.

Drag/drop should avoid destructive browser defaults. Dropping files onto the app should not navigate away from the current thread. Dropping non-file data should leave the app unchanged.

Paste should be conservative. Plain text paste, file mention text, and slash/skill typing behavior must continue to work.

## Testing

Automated tests:

- Add a unit test for extracting image files from paste events.
- Add a unit test that paste without image files is ignored.
- Add a unit test for extracting multiple files from a drop event.
- Keep existing composer shortcut tests passing.

Verification commands:

- Run the existing front-end/unit tests with the repository's Node test pattern.
- Run `npm run build`.

Manual/browser checks:

- Desktop width: app fills the viewport instead of showing a centered 430px shell.
- Desktop width: drawer is docked by default and can be collapsed.
- Desktop width: chat and composer widths feel usable for long messages and code blocks.
- Mobile width: drawer still behaves as an overlay and the composer remains usable.
- Paste an image into the composer and confirm it appears in the attachment tray.
- Drag an image or file into the chat/composer area and confirm it appears in the attachment tray.

## Implementation Notes

Primary files:

- `client/src/App.jsx` for shell state, top-bar action wiring, and composer paste/drop handlers.
- `client/src/styles.css` for responsive desktop shell, docked drawer, wider chat column, and drop overlay styling.
- A small helper file under `client/src/` for paste/drop file extraction, with matching `.test.mjs`.

Repository hygiene:

- `.superpowers/` is ignored because visual companion mockups and browser selection state are local planning artifacts.
- Existing unrelated modifications, especially `server/codex-app-server.js`, are outside this UI pass and must not be reverted or included accidentally.

## Acceptance Criteria

- At `>=1024px`, CodexMobile uses a desktop-width adaptive shell rather than a phone-frame shell.
- At mobile widths, the current PWA drawer and composer behavior remain intact.
- The desktop drawer is docked by default and can be collapsed.
- Chat and composer are visibly wider and aligned as one main working column.
- Image paste uploads through the current attachment system.
- Drag/drop uploads images and files through the current attachment system.
- Build and relevant tests pass.
