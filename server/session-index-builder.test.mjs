import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  PROJECTLESS_PROJECT_ID,
  buildSessionIndex,
  projectIdFor
} from './session-index-builder.js';

test('session index builder preserves project ordering, projectless sessions, hidden filtering, and child counts', async () => {
  const projectA = path.resolve('/tmp/codexmobile-project-a');
  const projectB = path.resolve('/tmp/codexmobile-project-b');
  const projectlessRoot = path.resolve('/tmp/codexmobile-projectless');
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
  assert.deepEqual(projectASessions.map((session) => session.id), ['child-1', 'parent-1']);
  assert.equal(index.projectById.get(projectAId).sessionCount, 1);
  assert.equal(index.sessionById.has('hidden-1'), false);
  assert.equal(index.sessionById.has('archived-1'), false);

  const parent = index.sessionById.get('parent-1');
  assert.equal(parent.title, '手机标题');
  assert.equal(parent.summary, '可见内容');
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
    ['/tmp/child.jsonl', 'child-1'],
    ['/tmp/plain.jsonl', 'plain-1'],
    [undefined, 'hidden-1']
  ]);
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
