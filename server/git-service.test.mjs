import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createGitService,
  defaultCommitMessage,
  normalizeBranchName,
  parseGitStatusShort,
  truncateGitOutput
} from './git-service.js';

test('parseGitStatusShort reads branch, ahead/behind, and changed files', () => {
  const status = parseGitStatusShort([
    '## codex/mobile-git...origin/codex/mobile-git [ahead 2, behind 1]',
    ' M client/src/App.jsx',
    'A  server/git-service.js',
    'R  old-name.js -> new-name.js',
    '?? server/git-service.test.mjs'
  ].join('\n'));

  assert.equal(status.branch, 'codex/mobile-git');
  assert.equal(status.upstream, 'origin/codex/mobile-git');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.clean, false);
  assert.equal(status.fileCount, 4);
  assert.equal(status.filesTruncated, false);
  assert.deepEqual(status.files.map((file) => [file.status, file.path]), [
    ['M', 'client/src/App.jsx'],
    ['A', 'server/git-service.js'],
    ['R', 'new-name.js'],
    ['??', 'server/git-service.test.mjs']
  ]);
});

test('parseGitStatusShort caps large file lists but keeps true dirty count', () => {
  const output = [
    '## main...origin/main',
    ...Array.from({ length: 5 }, (_, index) => ` M file-${index}.md`)
  ].join('\n');
  const status = parseGitStatusShort(output, { maxFiles: 2 });

  assert.equal(status.clean, false);
  assert.equal(status.canCommit, true);
  assert.equal(status.fileCount, 5);
  assert.equal(status.filesTruncated, true);
  assert.deepEqual(status.files.map((file) => file.path), ['file-0.md', 'file-1.md']);
});

test('normalizeBranchName keeps codex prefix and sanitizes unsafe text', () => {
  assert.equal(normalizeBranchName('移动端 Git 操作'), 'codex/git');
  assert.equal(normalizeBranchName('codex/mobile git panel'), 'codex/mobile-git-panel');
  assert.equal(normalizeBranchName('../bad branch'), 'codex/bad-branch');
});

test('defaultCommitMessage summarizes a focused change set', () => {
  const status = parseGitStatusShort([
    '## main',
    ' M client/src/App.jsx',
    ' M client/src/styles.css'
  ].join('\n'));

  assert.equal(defaultCommitMessage(status), '更新 App 和 styles');
});

test('truncateGitOutput caps large diff payloads', () => {
  const result = truncateGitOutput('a'.repeat(1200), 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 1200);
  assert.match(result.text, /diff truncated/);
});

test('git service returns truncated diff with status', async () => {
  const calls = [];
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args.join(' ') === 'diff HEAD --stat') {
        return { stdout: ' client/src/App.jsx | 4 ++--\n', stderr: '' };
      }
      if (args.join(' ') === 'diff HEAD --') {
        return { stdout: 'x'.repeat(90_000), stderr: '' };
      }
      if (args[0] === 'status') {
        return { stdout: '## codex/git-panel...origin/codex/git-panel [ahead 1]\n M client/src/App.jsx\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.diff('project-1');
  assert.equal(result.truncated, true);
  assert.match(result.summary, /App.jsx/);
  assert.equal(result.status.branch, 'codex/git-panel');
  assert.equal(calls.includes('diff HEAD --stat'), true);
});

test('git service lists local branches with default and checked-out metadata', async () => {
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'status') {
        return { stdout: '## codex/git-panel...origin/codex/git-panel\n', stderr: '' };
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      if (args[0] === 'for-each-ref') {
        return {
          stdout: [
            'main\torigin/main\t',
            'codex/git-panel\torigin/codex/git-panel\t/repo',
            'codex/other\torigin/codex/other\t/tmp/repo-other'
          ].join('\n'),
          stderr: ''
        };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.branches('project-1');
  assert.equal(result.current, 'codex/git-panel');
  assert.equal(result.defaultBranch, 'main');
  assert.deepEqual(result.branches.map((branch) => [branch.name, branch.current, branch.default, branch.checkedOutElsewhere]), [
    ['codex/git-panel', true, false, false],
    ['main', false, true, false],
    ['codex/other', false, false, true]
  ]);
});

test('git service checks out an existing branch', async () => {
  const calls = [];
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'switch') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status') {
        return { stdout: '## codex/target...origin/codex/target\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.checkout('project-1', 'codex/target');
  assert.equal(calls.includes('switch codex/target'), true);
  assert.equal(result.branch, 'codex/target');
  assert.equal(result.status.branch, 'codex/target');
});

test('git service pulls with fast-forward only', async () => {
  const calls = [];
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'pull') {
        return { stdout: 'Already up to date.\n', stderr: '' };
      }
      if (args[0] === 'status') {
        return { stdout: '## codex/git-panel...origin/codex/git-panel\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.pull('project-1');
  assert.deepEqual(calls.find((args) => args[0] === 'pull'), ['pull', '--ff-only']);
  assert.equal(result.status.clean, true);
});

test('git service creates a linked worktree from a codex branch name', async () => {
  const calls = [];
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'worktree') {
        return { stdout: 'Preparing worktree\n', stderr: '' };
      }
      if (args[0] === 'status') {
        return { stdout: '## codex/mobile-panel\n', stderr: '' };
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'origin/main\n', stderr: '' };
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'codex/mobile-panel\t\t/repo-mobile-panel\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.worktree('project-1', {
    branchName: 'mobile panel',
    baseBranch: 'main'
  });
  const expectedWorktreePath = path.join(path.dirname('/repo'), 'repo-mobile-panel');
  assert.equal(
    calls.includes(`worktree add -b codex/mobile-panel ${expectedWorktreePath} main`),
    true
  );
  assert.equal(result.branch, 'codex/mobile-panel');
  assert.equal(result.worktreePath, expectedWorktreePath);
});

test('git service generates a copyable PR draft', async () => {
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'status') {
        return {
          stdout: '## codex/git-panel...origin/codex/git-panel [ahead 1]\n M server/git-service.js\n',
          stderr: ''
        };
      }
      if (args[0] === 'config') {
        return { stdout: 'git@github.com:flyyangX/CodexMobile.git\n', stderr: '' };
      }
      if (args[0] === 'log') {
        return { stdout: 'abc123 refactor: align mobile git panel api contract\n', stderr: '' };
      }
      if (args[0] === 'diff') {
        return { stdout: ' server/git-service.js | 20 ++++++++++++++++++++\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.prDraft('project-1', { baseBranch: 'main' });
  assert.equal(result.title, '更新 git service');
  assert.equal(result.needsPush, true);
  assert.match(result.compareUrl, /github\.com\/flyyangX\/CodexMobile\/compare\/main\.\.\.codex%2Fgit-panel/);
  assert.match(result.body, /server\/git-service\.js/);
  assert.match(result.body, /node --test/);
});

test('git service sync pulls then pushes only when ahead remains', async () => {
  const calls = [];
  let statusCount = 0;
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'pull') {
        return { stdout: 'Fast-forward\n', stderr: '' };
      }
      if (args[0] === 'push') {
        return { stdout: 'pushed\n', stderr: '' };
      }
      if (args[0] === 'status') {
        statusCount += 1;
        return {
          stdout: statusCount <= 2
            ? '## codex/git-panel...origin/codex/git-panel [ahead 1]\n'
            : '## codex/git-panel...origin/codex/git-panel\n',
          stderr: ''
        };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.sync('project-1');
  assert.equal(calls.includes('pull --ff-only'), true);
  assert.equal(calls.includes('push origin'), true);
  assert.equal(result.pushed.branch, 'codex/git-panel');
  assert.equal(result.status.ahead, 0);
});

test('git service commits on non-codex branches when the repository allows it', async () => {
  const calls = [];
  let statusCount = 0;
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return args[1] === '--short'
          ? { stdout: 'abc123\n', stderr: '' }
          : { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'status') {
        statusCount += 1;
        return {
          stdout: statusCount === 1
            ? '## main...origin/main\n M vault.md\n'
            : '## main...origin/main [ahead 1]\n',
          stderr: ''
        };
      }
      if (args[0] === 'add') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'commit') {
        return { stdout: '[main abc123] 更新 vault\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.commit('project-1', '更新 vault');
  assert.equal(calls.includes('add -A'), true);
  assert.equal(calls.includes('commit -m 更新 vault'), true);
  assert.equal(result.hash, 'abc123');
});

test('git service pushes when the dirty file list is too large for display', async () => {
  const output = [
    '## codex/git-panel...origin/codex/git-panel [ahead 1]',
    ...Array.from({ length: 501 }, (_, index) => ` M file-${index}.md`)
  ].join('\n');
  const calls = [];
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'status') {
        return { stdout: output, stderr: '' };
      }
      if (args[0] === 'push') {
        return { stdout: 'pushed\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.push('project-1');
  assert.equal(calls.includes('push origin'), true);
  assert.equal(result.branch, 'codex/git-panel');
});

test('git service commitPush commits and then pushes', async () => {
  const calls = [];
  let statusCount = 0;
  const service = createGitService({
    getProject: () => ({ path: '/repo' }),
    runner: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: '/repo\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--short') {
        return { stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'status') {
        statusCount += 1;
        return {
          stdout: statusCount === 1
            ? '## codex/git-panel...origin/codex/git-panel\n M client/src/App.jsx\n'
            : '## codex/git-panel...origin/codex/git-panel [ahead 1]\n',
          stderr: ''
        };
      }
      if (args[0] === 'add') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'commit') {
        return { stdout: '[codex/git-panel abc123] 更新 GitPanel\n', stderr: '' };
      }
      if (args[0] === 'push') {
        return { stdout: 'pushed\n', stderr: '' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  });

  const result = await service.commitPush('project-1', '更新 GitPanel');
  assert.equal(calls.includes('add -A'), true);
  assert.equal(calls.includes('commit -m 更新 GitPanel'), true);
  assert.equal(calls.includes('push origin'), true);
  assert.equal(result.hash, 'abc123');
});
