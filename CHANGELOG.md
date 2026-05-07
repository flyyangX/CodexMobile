# Changelog

All notable changes to CodexMobile are tracked here.

## Unreleased

### Added

- Added a queue panel for running conversations: queued drafts can be viewed, restored, deleted, or sent immediately as steer input.
- Added composer shortcuts with `/` commands for status, context compaction, code review, and sub-agent workflows.
- Added `$skill` autocomplete backed by the existing skills list.
- Added `@file` search backed by a project-local file search API that ignores generated and dependency directories.
- Added file mention support for chat sends so selected local paths can be attached as context.
- Added an expanded Git panel with status, diff preview, pull, sync, and commit+push actions.
- Added foreground toast notifications for Git progress, task completion, failures, and user-input prompts.
- Added Web Push support for installed HTTPS PWAs, including service worker handling and server-side subscription storage.
- Added a compact connection recovery card for reconnecting, syncing, repairing pairing, and checking status.

### Changed

- Kept completed task activity collapsed by default while preserving the full execution text when expanded.
- Improved mobile activity rendering and reduced noisy lifecycle messages.
- Rewrote README to describe CodexMobile as a local Codex mobile workbench rather than a thin upstream UI fork.
- Updated package metadata to describe the current mobile workbench scope.

### Notes

- iOS background notifications require an HTTPS Home Screen PWA. Local HTTP access still works for chat, sync, and foreground toast.
- `sync` is defined as `pull --ff-only` followed by `push` when the branch is ahead.
