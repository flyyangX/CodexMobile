/**
 * 测试 server/session-index-builder.js：项目 id、索引构建与 projectless。
 *
 * Keywords: session-index, test, sqlite
 *
 * Exports: 无导出，内含用例
 *
 * Inward: session-index-builder.js
 */
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROJECTLESS_PROJECT_ID,
  buildSessionIndex,
  canonicalResolvedPath,
  projectIdFor
} from './session-index-builder.js';

test('session index builder preserves project ordering, projectless sessions, hidden filtering, and child counts', async () => {
  const projectA = '/tmp/codexmobile-project-a';
  const projectB = '/tmp/codexmobile-project-b';
  const projectlessRoot = '/tmp/codexmobile-projectless';
  const projectAId = projectIdFor(projectA);

  const contextReads = [];
  const index = await buildSessionIndex({
    config: {
      projects: [
        { path: projectB, trustLevel: 'trusted' },
        { path: projectA, trustLevel: 'untrusted' }
      ],
      context: { autoCompactTokenLimit: 80000 }
    },
    workspaceState: {
      projects: [
        { path: projectA, label: 'Alpha' },
        { path: projectB, label: 'Beta' }
      ],
      projectlessThreadIds: ['plain-1'],
      threadWorkspaceRootHints: { 'plain-1': projectlessRoot }
    },
    mobileSessionIndex: new Map([
      ['parent-1', {
        title: '手机标题',
        titleLocked: true,
        messages: [{ id: 'm1' }],
        projectPath: projectA
      }],
      ['auto-model-legacy', {
        title: '榴莲热量讨论',
        titleLocked: false,
        summary: '晚餐记录一下',
        projectPath: projectA
      }],
      ['auto-provisional-legacy', {
        title: '今天难得去游泳了 可以记录',
        titleLocked: false,
        summary: '今天难得去游泳了 可以记录一下',
        projectPath: projectA
      }],
      ['plain-1', {
        projectless: true,
        messages: []
      }]
    ]),
    hiddenSessionIds: new Set(['hidden-1']),
    desktopThreads: [
      {
        id: 'parent-1',
        cwd: projectA,
        name: '',
        preview: '可见内容 CodexMobile iOS/PWA 回复要求：内部提示',
        updatedAt: 1_800_000_000,
        modelProvider: 'openai',
        path: '/tmp/parent.jsonl',
        source: 'vscode'
      },
      {
        id: 'auto-model-legacy',
        cwd: projectA,
        name: '',
        preview: '晚餐记录一下',
        updatedAt: 1_800_000_005,
        path: '/tmp/auto-model.jsonl',
        source: 'vscode'
      },
      {
        id: 'auto-provisional-legacy',
        cwd: projectA,
        name: '',
        preview: '今天难得去游泳了 可以记录一下',
        updatedAt: 1_800_000_006,
        path: '/tmp/auto-provisional.jsonl',
        source: 'vscode'
      },
      {
        id: 'child-1',
        cwd: projectA,
        name: 'child',
        preview: 'child preview',
        updatedAt: 1_800_000_010,
        path: '/tmp/child.jsonl',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'parent-1',
              agent_nickname: 'Worker',
              agent_role: 'worker',
              depth: 1
            }
          }
        }
      },
      {
        id: 'plain-1',
        name: '普通对话标题',
        updatedAt: 1_800_000_020,
        path: '/tmp/plain.jsonl',
        source: 'vscode'
      },
      {
        id: 'hidden-1',
        cwd: projectA,
        name: 'hidden',
        updatedAt: 1_800_000_030,
        source: 'vscode'
      },
      {
        id: 'archived-1',
        cwd: projectB,
        name: 'archived',
        status: 'archived',
        updatedAt: 1_800_000_040,
        source: 'vscode'
      },
      {
        id: 'archived-object-status',
        cwd: projectB,
        name: 'archived object status',
        status: { type: 'archived' },
        updatedAt: 1_800_000_041,
        source: 'vscode'
      }
    ],
    spawnEdges: [
      { parentSessionId: 'parent-1', childSessionId: 'child-1', status: 'open' }
    ],
    readRolloutContextState: async (filePath, sessionId) => {
      contextReads.push([filePath, sessionId]);
      return sessionId === 'parent-1'
        ? { sessionId, inputTokens: 40_000, contextWindow: 100_000 }
        : { sessionId };
    },
    pathExists: () => false,
    homeDir: () => '/tmp/home'
  });

  assert.deepEqual(index.projects.map((project) => project.id), [
    PROJECTLESS_PROJECT_ID,
    projectAId,
    projectIdFor(projectB)
  ]);
  assert.equal(index.projectById.get(PROJECTLESS_PROJECT_ID).path, projectlessRoot);
  assert.equal(index.projectById.get(projectAId).name, 'Alpha');
  assert.equal(index.projectById.get(projectAId).trusted, false);

  const projectlessSessions = index.sessionsByProject.get(PROJECTLESS_PROJECT_ID);
  assert.deepEqual(projectlessSessions.map((session) => session.id), ['plain-1']);
  assert.equal(index.projectById.get(PROJECTLESS_PROJECT_ID).sessionCount, 1);

  const projectASessions = index.sessionsByProject.get(projectAId);
  assert.deepEqual(projectASessions.map((session) => session.id), ['child-1', 'auto-provisional-legacy', 'auto-model-legacy', 'parent-1']);
  assert.equal(index.projectById.get(projectAId).sessionCount, 3);
  assert.equal(index.sessionById.has('hidden-1'), false);
  assert.equal(index.sessionById.has('archived-1'), false);
  assert.equal(index.sessionById.has('archived-object-status'), false);

  const parent = index.sessionById.get('parent-1');
  assert.equal(parent.title, '手机标题');
  assert.equal(parent.summary, '可见内容');
  assert.equal(index.sessionById.get('auto-model-legacy').titleAutoGenerated, 'model');
  assert.equal(index.sessionById.get('auto-provisional-legacy').titleAutoGenerated, 'provisional');
  assert.equal(parent.childCount, 1);
  assert.equal(parent.openChildCount, 1);
  assert.equal(parent.context.percent, 40);

  const child = index.sessionById.get('child-1');
  assert.equal(child.parentSessionId, 'parent-1');
  assert.equal(child.isSubAgent, true);
  assert.equal(child.subAgent.nickname, 'Worker');
  assert.equal(child.subAgent.status, 'open');

  assert.deepEqual(contextReads, [
    ['/tmp/parent.jsonl', 'parent-1'],
    ['/tmp/auto-model.jsonl', 'auto-model-legacy'],
    ['/tmp/auto-provisional.jsonl', 'auto-provisional-legacy'],
    ['/tmp/child.jsonl', 'child-1'],
    ['/tmp/plain.jsonl', 'plain-1'],
    [undefined, 'hidden-1']
  ]);
});

test('session index builder treats symlinked project paths as the same project', async () => {
  const tempRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-path-alias-'));
  const realRoot = path.join(tempRoot, 'Code');
  const aliasRoot = path.join(tempRoot, '编程项目');
  const realProject = path.join(realRoot, 'CodexMobile');
  const aliasProject = path.join(aliasRoot, 'CodexMobile');
  fsSync.mkdirSync(realProject, { recursive: true });
  fsSync.symlinkSync(realRoot, aliasRoot, 'dir');
  const expectedRealProject = fsSync.realpathSync.native(realProject);

  try {
    assert.equal(canonicalResolvedPath(aliasProject), expectedRealProject);
    assert.equal(projectIdFor(aliasProject), projectIdFor(realProject));

    const projectId = projectIdFor(aliasProject);
    const index = await buildSessionIndex({
      config: { projects: [{ path: aliasProject, trustLevel: 'trusted' }], context: {} },
      workspaceState: { projects: [{ path: aliasProject, label: 'CodexMobile' }] },
      mobileSessionIndex: new Map(),
      hiddenSessionIds: new Set(),
      desktopThreads: [
        {
          id: 'thread-after-rename',
          cwd: realProject,
          name: '路径迁移后的线程',
          updatedAt: 1_800_000_000,
          source: 'vscode'
        }
      ],
      pathExists: fsSync.existsSync
    });

    assert.equal(index.projectById.get(projectId).path, expectedRealProject);
    assert.equal(index.sessionsByProject.get(projectId).length, 1);
    assert.equal(index.sessionsByProject.get(projectId)[0].cwd, expectedRealProject);
  } finally {
    fsSync.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('session index builder accepts seconds, milliseconds, and ISO thread times', async () => {
  const projectRoot = '/tmp/codexmobile-time-project';
  const projectId = projectIdFor(projectRoot);
  const index = await buildSessionIndex({
    config: { projects: [{ path: projectRoot, trustLevel: 'trusted' }], context: {} },
    workspaceState: { projects: [{ path: projectRoot, label: 'Time Project' }] },
    mobileSessionIndex: new Map(),
    hiddenSessionIds: new Set(),
    desktopThreads: [
      {
        id: 'seconds-thread',
        cwd: projectRoot,
        name: 'seconds',
        updatedAt: 1_778_794_800,
        path: '/tmp/seconds.jsonl',
        source: 'vscode'
      },
      {
        id: 'millis-thread',
        cwd: projectRoot,
        name: 'millis',
        updatedAt: 1_778_794_860_000,
        path: '/tmp/millis.jsonl',
        source: 'vscode'
      },
      {
        id: 'iso-thread',
        cwd: projectRoot,
        name: 'iso',
        updatedAt: '2026-05-14T21:42:00.000Z',
        path: '/tmp/iso.jsonl',
        source: 'vscode'
      }
    ],
    readRolloutContextState: async () => ({}),
    pathExists: () => true,
    homeDir: () => '/tmp/home'
  });

  assert.deepEqual(index.sessionsByProject.get(projectId).map((session) => session.id), [
    'iso-thread',
    'millis-thread',
    'seconds-thread'
  ]);
  assert.equal(index.sessionById.get('seconds-thread').updatedAt, '2026-05-14T21:40:00.000Z');
  assert.equal(index.sessionById.get('millis-thread').updatedAt, '2026-05-14T21:41:00.000Z');
  assert.equal(index.sessionById.get('iso-thread').updatedAt, '2026-05-14T21:42:00.000Z');
});

test('session index builder keeps unknown cwd and projectless subagents out of normal conversations', async () => {
  const projectA = '/tmp/codexmobile-project-a';
  const unknownProject = '/tmp/not-in-codex-config';
  const projectlessRoot = '/tmp/codexmobile-projectless';

  const index = await buildSessionIndex({
    config: {
      projects: [{ path: projectA, trustLevel: 'trusted' }]
    },
    workspaceState: {
      projects: [{ path: projectA, label: 'Alpha' }],
      projectlessThreadIds: ['plain-1', 'plain-child'],
      threadWorkspaceRootHints: {
        'plain-1': projectlessRoot,
        'plain-child': projectlessRoot
      }
    },
    desktopThreads: [
      {
        id: 'unknown-cwd',
        cwd: unknownProject,
        name: '不应该塞进普通对话',
        updatedAt: 1_800_000_000,
        source: 'vscode'
      },
      {
        id: 'plain-1',
        name: '普通对话',
        updatedAt: 1_800_000_001,
        source: 'vscode'
      },
      {
        id: 'plain-child',
        name: '普通子线程',
        updatedAt: 1_800_000_002,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'plain-1',
              agent_nickname: 'Worker',
              agent_role: 'worker',
              depth: 1
            }
          }
        }
      }
    ],
    pathExists: () => false,
    homeDir: () => '/tmp/home'
  });

  const projectlessSessions = index.sessionsByProject.get(PROJECTLESS_PROJECT_ID) || [];
  assert.deepEqual(projectlessSessions.map((session) => session.id), ['plain-1']);
  assert.equal(index.sessionById.has('unknown-cwd'), false);
  assert.equal(index.sessionById.has('plain-child'), false);
});

test('session index builder trusts mobile projectless marker when desktop jsonl has a temporary cwd', async () => {
  const projectA = '/tmp/codexmobile-project-a';
  const projectlessCwd = '/tmp/home/Documents/Codex/2026-05-14/mobile-chat-test';

  const index = await buildSessionIndex({
    config: {
      projects: [{ path: projectA, trustLevel: 'trusted' }]
    },
    workspaceState: {
      projects: [{ path: projectA, label: 'Alpha' }],
      projectlessThreadIds: [],
      threadWorkspaceRootHints: {}
    },
    mobileSessionIndex: new Map([
      ['mobile-projectless-1', {
        projectPath: projectlessCwd,
        projectless: true,
        title: '移动端普通对话',
        summary: '移动端创建的普通对话',
        messages: [{ id: 'm1' }]
      }]
    ]),
    desktopThreads: [
      {
        id: 'mobile-projectless-1',
        cwd: projectlessCwd,
        name: '',
        preview: '移动端创建的普通对话',
        updatedAt: 1_800_000_010,
        path: '/tmp/mobile-projectless-1.jsonl',
        source: 'vscode'
      }
    ],
    pathExists: () => true,
    homeDir: () => '/tmp/home'
  });

  const projectlessSessions = index.sessionsByProject.get(PROJECTLESS_PROJECT_ID) || [];

  assert.deepEqual(projectlessSessions.map((session) => session.id), ['mobile-projectless-1']);
  assert.equal(index.projectById.get(PROJECTLESS_PROJECT_ID).sessionCount, 1);
  assert.equal(index.sessionById.get('mobile-projectless-1').projectId, PROJECTLESS_PROJECT_ID);
});

test('session index builder can include missing subagent threads behind the feature flag', async () => {
  const projectA = '/tmp/codexmobile-project-a';
  const projectAId = projectIdFor(projectA);
  const missingCalls = [];

  const index = await buildSessionIndex({
    config: { projects: [{ path: projectA, trustLevel: 'trusted' }], context: {} },
    workspaceState: { projects: [], projectlessThreadIds: [], threadWorkspaceRootHints: {} },
    mobileSessionIndex: new Map(),
    hiddenSessionIds: new Set(),
    desktopThreads: [
      {
        id: 'parent-1',
        cwd: projectA,
        name: 'parent',
        updatedAt: 1_800_000_000,
        source: 'vscode'
      }
    ],
    spawnEdges: [
      { parentSessionId: 'parent-1', childSessionId: 'missing-child', status: 'closed' }
    ],
    includeMissingSubagentThreads: true,
    readDesktopThread: async (sessionId, options) => {
      missingCalls.push([sessionId, options]);
      return {
        id: 'missing-child',
        cwd: projectA,
        name: 'missing child',
        updatedAt: 1_800_000_001,
        source: 'vscode'
      };
    },
    readRolloutContextState: async (_filePath, sessionId) => ({ sessionId }),
    pathExists: () => true
  });

  assert.deepEqual(missingCalls, [['missing-child', { includeTurns: false }]]);
  assert.deepEqual(index.sessionsByProject.get(projectAId).map((session) => session.id), [
    'missing-child',
    'parent-1'
  ]);
  assert.equal(index.sessionById.get('missing-child').parentSessionId, 'parent-1');
  assert.equal(index.sessionById.get('missing-child').subAgent.status, 'closed');
});

test('session index builder exposes desktop runtime from rollout state', async () => {
  const projectA = '/tmp/codexmobile-project-runtime';
  const projectAId = projectIdFor(projectA);

  const index = await buildSessionIndex({
    config: { projects: [{ path: projectA, trustLevel: 'trusted' }], context: {} },
    workspaceState: { projects: [], projectlessThreadIds: [], threadWorkspaceRootHints: {} },
    mobileSessionIndex: new Map(),
    hiddenSessionIds: new Set(),
    desktopThreads: [
      {
        id: 'thread-running',
        cwd: projectA,
        name: 'running',
        updatedAt: 1_800_000_000,
        path: '/tmp/running.jsonl',
        source: 'vscode'
      }
    ],
    readRolloutContextState: async (_filePath, sessionId) => ({
      sessionId,
      runtime: {
        status: 'running',
        source: 'desktop-thread',
        sessionId,
        turnId: 'turn-running',
        startedAt: '2026-05-08T01:00:00.000Z',
        updatedAt: '2026-05-08T01:00:01.000Z',
        steerable: false
      }
    }),
    pathExists: () => true
  });

  const [session] = index.sessionsByProject.get(projectAId);

  assert.equal(session.id, 'thread-running');
  assert.equal(session.runtime.status, 'running');
  assert.equal(session.runtime.sessionId, 'thread-running');
  assert.equal(session.runtime.turnId, 'turn-running');
});
