/**
 * 测试 app/AppState.js 与 session-utils 等：归约器、会话与运行时状态工具。
 * Keywords: app-state, reducer, session-utils, tests
 * Exports: 无导出 / 内含用例
 * Inward: app/AppState.js（及文件内其它 import）
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { appReducer, createInitialUiState } from './app/AppState.js';
import { applyPwaTheme } from './app/pwa-theme.js';
import {
  createDraftSession,
  formatRelativeShort,
  localFileApiPath,
  localFilePreviewDataPath,
  localFilePreviewPath,
  messagePageFromResponse,
  payloadRunKeys,
  prependUniqueMessages,
  reconcileThreadRuntimeWithSessions,
  resolveComposerGitProject,
  resolveNewConversationProject,
  runningByIdWithSelectedActivity,
  selectedMessagesHaveActiveTurnActivity,
  selectedSessionIsRunning,
  sessionMessagesApiPath,
  sessionRunBadgeState,
  sourceMediaKind,
  remoteImageApiPath,
  titleFromFirstMessage
} from './app/session-utils.js';
import { completeMessagesForTurnCompletion, runtimeKeysForPayload } from './app/useTurnRuntime.js';
import { shouldResetWindowScroll, viewportSizingMetrics } from './app/useViewportSizing.js';

test('appReducer updates ui state with direct and functional values', () => {
  const initial = createInitialUiState({ storage: { getItem: () => 'light' } });
  const opened = appReducer(initial, { type: 'ui/drawerOpen', value: true });
  assert.equal(opened.drawerOpen, true);

  const nextGit = appReducer(opened, {
    type: 'ui/gitPanel',
    value: (current) => ({ ...current, open: true, action: 'sync' })
  });
  assert.deepEqual(nextGit.gitPanel, { open: true, action: 'sync' });
});

test('createInitialUiState restores dark theme from storage', () => {
  const state = createInitialUiState({ storage: { getItem: () => 'dark' } });
  assert.equal(state.theme, 'dark');
});

test('createInitialUiState restores system theme preference from storage', () => {
  const state = createInitialUiState({ storage: { getItem: () => 'system' } });
  assert.equal(state.theme, 'system');
});

test('applyPwaTheme syncs iOS PWA meta with dark theme', () => {
  const elements = new Map([
    ['meta[data-app-theme-color]', { content: '', setAttribute(name, value) { this[name] = value; } }],
    ['meta[data-app-status-bar-style]', { content: '', setAttribute(name, value) { this[name] = value; } }]
  ]);
  const doc = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      return elements.get(selector);
    }
  };

  const meta = applyPwaTheme('dark', doc);

  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(meta.themeColor, '#000000');
  assert.equal(elements.get('meta[data-app-theme-color]').content, '#000000');
  assert.equal(elements.get('meta[data-app-status-bar-style]').content, 'black-translucent');
});

test('applyPwaTheme resolves system preference from media query', () => {
  const elements = new Map([
    ['meta[data-app-theme-color]', { content: '', setAttribute(name, value) { this[name] = value; } }],
    ['meta[data-app-status-bar-style]', { content: '', setAttribute(name, value) { this[name] = value; } }]
  ]);
  const doc = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      return elements.get(selector);
    },
    defaultView: {
      matchMedia(query) {
        return { media: query, matches: query === '(prefers-color-scheme: dark)' };
      }
    }
  };

  const meta = applyPwaTheme('system', doc);

  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(meta.preference, 'system');
  assert.equal(meta.resolvedTheme, 'dark');
  assert.equal(elements.get('meta[data-app-theme-color]').content, '#000000');
});

test('formatRelativeShort keeps sidebar time stable around now and future clock skew', () => {
  const now = '2026-05-15T05:30:00+08:00';

  assert.equal(formatRelativeShort('2026-05-15T05:29:35+08:00', now), '刚刚');
  assert.equal(formatRelativeShort('2026-05-15T05:18:00+08:00', now), '12 分钟');
  assert.equal(formatRelativeShort('2026-05-15T02:30:00+08:00', now), '3 小时');
  assert.match(formatRelativeShort('2026-05-15T06:40:00+08:00', now), /05\/15.*06:40|15\/05.*06:40/);
});

test('selected active turn activity counts as composer runtime without live sync state', () => {
  const messages = [
    { id: 'user-1', role: 'user', content: '继续查一下', turnId: 'turn-1' },
    { id: 'activity-1', role: 'activity', kind: 'turn', status: 'running', turnId: 'turn-1' }
  ];

  assert.equal(selectedMessagesHaveActiveTurnActivity(messages), true);
  assert.equal(selectedSessionIsRunning({
    running: false,
    hasActiveTurnActivity: true
  }), true);
  assert.equal(selectedSessionIsRunning({
    running: true,
    hasActiveTurnActivity: false
  }), true);
  assert.equal(selectedSessionIsRunning({
    running: false,
    hasActiveTurnActivity: false
  }), false);
});

test('selected stale activity does not count as composer runtime after assistant content', () => {
  const messages = [
    { id: 'activity-1', role: 'activity', kind: 'turn', status: 'running', turnId: 'turn-1' },
    { id: 'assistant-1', role: 'assistant', content: '已经完成', turnId: 'turn-1' }
  ];

  assert.equal(selectedMessagesHaveActiveTurnActivity(messages), false);
});

test('selected running activity does not synthesize sidebar runtime badges', () => {
  const runningById = runningByIdWithSelectedActivity(
    {},
    { id: 'thread-1', turnId: 'turn-1' },
    true
  );

  assert.deepEqual(runningById, {});
  assert.equal(
    sessionRunBadgeState(
      { id: 'thread-1', turnId: 'turn-1' },
      { runningById }
    ),
    null
  );
});

test('desktop ipc active runs expose both app and client turn ids', () => {
  assert.deepEqual(
    payloadRunKeys({
      source: 'desktop-ipc',
      turnId: 'desktop-turn-1',
      clientTurnId: 'client-turn-1',
      appTurnId: 'app-turn-1',
      sessionId: 'thread-1',
      previousSessionId: 'thread-1'
    }),
    ['desktop-turn-1', 'client-turn-1', 'app-turn-1', 'thread-1', 'thread-1']
  );
});

test('turn completion finishes matching running activity before thread refresh', () => {
  const next = completeMessagesForTurnCompletion([
    {
      id: 'activity-1',
      role: 'activity',
      kind: 'turn',
      status: 'running',
      sessionId: 'thread-1',
      turnId: 'client-turn-1',
      clientTurnId: 'client-turn-1',
      activities: [
        { id: 'step-1', title: '执行中', status: 'running' }
      ]
    }
  ], {
    source: 'desktop-ipc',
    sessionId: 'thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    completedAt: '2026-05-09T00:00:00.000Z'
  });

  const activity = next.find((message) => message.id === 'activity-1');
  assert.equal(activity.status, 'completed');
  assert.equal(activity.activities[0].status, 'completed');
  assert.equal(next.some((message) => message.status === 'running'), false);
});

test('new conversation project resolution prefers explicit drawer choice', () => {
  const normal = { id: '__codexmobile_projectless__', projectless: true, name: '普通对话' };
  const codexMobile = { id: 'project-codexmobile', name: 'CodexMobile' };
  const selected = { id: 'project-other', name: 'Other' };

  assert.equal(resolveNewConversationProject(codexMobile, selected, [normal, codexMobile]), codexMobile);
  assert.equal(resolveNewConversationProject(null, null, [normal, codexMobile]), normal);
});

test('draft sessions preserve the chosen conversation scope', () => {
  const normal = { id: '__codexmobile_projectless__', projectless: true, name: '普通对话' };
  const draft = createDraftSession(normal);

  assert.equal(draft.projectId, normal.id);
  assert.equal(draft.draft, true);
  assert.match(draft.id, /^draft-__codexmobile_projectless__-/);
});

test('resolveComposerGitProject only exposes git for real project-bound composers', () => {
  const normal = { id: '__codexmobile_projectless__', projectless: true, name: '普通对话' };
  const codexMobile = { id: 'project-codexmobile', name: 'CodexMobile' };
  const other = { id: 'project-other', name: 'Other' };

  assert.equal(
    resolveComposerGitProject({
      homeVisible: false,
      projects: [normal, codexMobile, other],
      selectedProject: codexMobile,
      selectedSession: { id: 'plain-thread', projectId: normal.id }
    }),
    null
  );
  assert.equal(
    resolveComposerGitProject({
      homeVisible: false,
      projects: [normal, codexMobile, other],
      selectedProject: other,
      selectedSession: { id: 'project-thread', projectId: codexMobile.id }
    }),
    codexMobile
  );
  assert.equal(
    resolveComposerGitProject({
      homeVisible: true,
      selectedProject: normal,
      selectedSession: { id: 'draft-normal', projectId: normal.id }
    }),
    null
  );
  assert.equal(
    resolveComposerGitProject({
      homeVisible: true,
      selectedProject: codexMobile,
      selectedSession: { id: 'draft-project', projectId: codexMobile.id }
    }),
    codexMobile
  );
});

test('titleFromFirstMessage uses the shared provisional title helper', () => {
  assert.equal(titleFromFirstMessage('帮我看一下移动端新对话逻辑'), '移动端新对话逻辑');
});

test('sessionRunBadgeState ignores session index runtime but honors live runtime', () => {
  const session = {
    id: 'thread-1',
    runtime: { status: 'running', turnId: 'turn-1', updatedAt: '2026-05-08T02:00:00.000Z' }
  };

  assert.equal(sessionRunBadgeState(session), null);
  assert.equal(
    sessionRunBadgeState(session, {
      threadRuntimeById: {
        'thread-1': { status: 'running', source: 'headless-local' }
      }
    }),
    'running'
  );
});

test('sessionRunBadgeState reads active runs by session id', () => {
  const session = { id: 'thread-2' };

  assert.equal(
    sessionRunBadgeState(session, { runningById: { 'thread-2': true } }),
    'running'
  );
});

test('session runtime reconciliation keeps index hints out of the live running badge', () => {
  const runtimeById = reconcileThreadRuntimeWithSessions({}, {
    projectA: [
      {
        id: 'thread-1',
        runtime: {
          status: 'running',
          source: 'desktop-thread',
          turnId: 'turn-1',
          updatedAt: '2026-05-08T02:00:00.000Z'
        }
      },
      {
        id: 'thread-2',
        runtime: {
          status: 'running',
          source: 'desktop-thread',
          turnId: 'turn-2',
          updatedAt: '2026-05-08T02:01:00.000Z'
        }
      }
    ]
  });

  assert.deepEqual(runtimeById, {});
  assert.equal(sessionRunBadgeState({ id: 'thread-1' }, { threadRuntimeById: runtimeById }), null);
  assert.equal(sessionRunBadgeState({ id: 'thread-2' }, { threadRuntimeById: runtimeById }), null);
});

test('session runtime reconciliation clears stale desktop runtime for loaded sessions', () => {
  const runtime = {
    status: 'running',
    source: 'desktop-thread',
    fromSessionIndex: true,
    sessionId: 'thread-1',
    turnId: 'turn-1',
    updatedAt: '2026-05-08T02:00:00.000Z'
  };
  const runtimeById = reconcileThreadRuntimeWithSessions(
    {
      'thread-1': runtime,
      'turn-1': runtime,
      'mobile-turn': { status: 'running', source: 'codexmobile' }
    },
    { projectA: [{ id: 'thread-1' }] }
  );

  assert.equal(runtimeById['thread-1'], undefined);
  assert.equal(runtimeById['turn-1'], undefined);
  assert.equal(runtimeById['mobile-turn'].status, 'running');
});

test('completed turn payload maps back to the selected sidebar session', () => {
  const session = { id: 'thread-3', projectId: 'projectA', turnId: 'turn-3' };
  const keys = runtimeKeysForPayload(
    { eventType: 'turn.completed', status: 'completed', turnId: 'turn-3' },
    session
  );

  assert.deepEqual(keys, ['turn-3', 'thread-3']);
  assert.equal(
    sessionRunBadgeState(session, {
      threadRuntimeById: {
        'thread-3': { status: 'completed', updatedAt: '2026-05-08T02:10:00.000Z' }
      },
      completedSessionIds: { 'thread-3': true }
    }),
    'complete'
  );
});

test('viewportSizingMetrics exposes keyboard inset from visual viewport', () => {
  const metrics = viewportSizingMetrics({
    visualViewport: { height: 520, width: 390, offsetTop: 0 },
    innerHeight: 844,
    innerWidth: 390,
    clientHeight: 844
  });

  assert.equal(metrics.keyboardOpen, true);
  assert.equal(metrics.keyboardInset, 324);
  assert.equal(metrics.height, 520);
});

test('window scroll reset can be disabled outside the main app shell', () => {
  assert.equal(shouldResetWindowScroll({ lockWindowScroll: false, scrollX: 0, scrollY: 260 }), false);
  assert.equal(shouldResetWindowScroll({ lockWindowScroll: true, scrollX: 0, scrollY: 260 }), true);
  assert.equal(shouldResetWindowScroll({ lockWindowScroll: true, scrollX: 0, scrollY: 0 }), false);
});

test('localFileApiPath uses Cookie auth and does not include token query parameters', () => {
  assert.equal(
    localFileApiPath('/Users/demo/report.md', 'secret token'),
    '/api/local-file/report.md?path=%2FUsers%2Fdemo%2Freport.md'
  );
});

test('localFileApiPath keeps original non-ascii filename in URL path segment', () => {
  assert.equal(
    localFileApiPath('/Users/demo/青甜丨2026年4月销售工资表.pdf'),
    '/api/local-file/%E9%9D%92%E7%94%9C%E4%B8%A82026%E5%B9%B44%E6%9C%88%E9%94%80%E5%94%AE%E5%B7%A5%E8%B5%84%E8%A1%A8.pdf?path=%2FUsers%2Fdemo%2F%E9%9D%92%E7%94%9C%E4%B8%A82026%E5%B9%B44%E6%9C%88%E9%94%80%E5%94%AE%E5%B7%A5%E8%B5%84%E8%A1%A8.pdf'
  );
});

test('localFilePreviewPath routes local files through the mobile preview page', () => {
  assert.equal(
    localFilePreviewPath('/Users/demo/report.md', 'secret token'),
    '/preview/file?path=%2FUsers%2Fdemo%2Freport.md'
  );
  assert.equal(
    localFilePreviewPath('/Users/demo/report.md', { embed: true }),
    '/preview/file?path=%2FUsers%2Fdemo%2Freport.md&embed=1'
  );
});

test('localFilePreviewDataPath routes local Word files through the conversion API', () => {
  assert.equal(
    localFilePreviewDataPath('/Users/demo/brief.docx'),
    '/api/local-file-preview?path=%2FUsers%2Fdemo%2Fbrief.docx'
  );
});

test('remoteImageApiPath routes remote markdown images through same-origin proxy', () => {
  assert.equal(
    remoteImageApiPath('https://imageobsidian.s3.bitiful.net/webpictures/a.png?x=1'),
    '/api/remote-image?url=https%3A%2F%2Fimageobsidian.s3.bitiful.net%2Fwebpictures%2Fa.png%3Fx%3D1'
  );
});

test('sourceMediaKind distinguishes image syntax targets that are actually video or audio files', () => {
  assert.equal(sourceMediaKind('/Users/demo/out/showcase.mp4'), 'video');
  assert.equal(sourceMediaKind('/Users/demo/out/contact-sheet.png'), 'image');
  assert.equal(sourceMediaKind('https://example.com/narration.m4a?download=1'), 'audio');
  assert.equal(sourceMediaKind('/Users/demo/report.md'), '');
});

test('sessionMessagesApiPath supports older-page pagination params', () => {
  assert.equal(
    sessionMessagesApiPath('session 1', { limit: 40, offset: 80, latest: false }),
    '/api/sessions/session%201/messages?limit=40&offset=80&latest=0&activity=1'
  );
});

test('message page helpers preserve pagination and prepend older messages once', () => {
  assert.deepEqual(messagePageFromResponse({ offset: 80, total: 200, hasMoreBefore: true }), {
    offset: 80,
    total: 200,
    hasMoreBefore: true,
    loadingOlder: false
  });
  assert.deepEqual(
    prependUniqueMessages([{ id: 'm2' }, { id: 'm3' }], [{ id: 'm1' }, { id: 'm2' }]).map((message) => message.id),
    ['m1', 'm2', 'm3']
  );
});
