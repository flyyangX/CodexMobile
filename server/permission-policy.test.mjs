import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexSandboxForPermissionMode,
  desktopSandboxPolicyForPermissionMode,
  desktopTurnPermissionsForPermissionMode,
  normalizePermissionMode
} from './permission-policy.js';

test('bypassPermissions is rejected unless danger full access is explicitly enabled', () => {
  assert.throws(
    () => normalizePermissionMode('bypassPermissions'),
    /danger-full-access is disabled/
  );
  assert.equal(normalizePermissionMode('bypassPermissions', { dangerFullAccessEnabled: true }), 'bypassPermissions');
});

test('unknown permission modes fall back to workspace-write defaults', () => {
  assert.equal(normalizePermissionMode('unknown'), 'default');
  assert.deepEqual(codexSandboxForPermissionMode('unknown'), {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never'
  });
});

test('desktop sandbox policy explicitly switches between workspace-write and danger full access', () => {
  const workspacePolicy = {
    type: 'workspaceWrite',
    writableRoots: ['D:\\Git\\CodexMobile'],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  assert.deepEqual(desktopSandboxPolicyForPermissionMode('acceptEdits', {
    writableRoots: ['D:\\Git\\CodexMobile'],
    networkAccess: true
  }), workspacePolicy);
  assert.deepEqual(desktopSandboxPolicyForPermissionMode('default', {
    writableRoots: ['D:\\Git\\CodexMobile'],
    networkAccess: true
  }), workspacePolicy);
  assert.deepEqual(desktopSandboxPolicyForPermissionMode('bypassPermissions', { dangerFullAccessEnabled: true }), {
    type: 'dangerFullAccess'
  });
});

test('desktop turn permissions match Codex Desktop non-full and full access modes', () => {
  assert.deepEqual(desktopTurnPermissionsForPermissionMode('acceptEdits', {
    writableRoots: ['D:\\Git\\CodexMobile']
  }), {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['D:\\Git\\CodexMobile'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  });
  assert.deepEqual(desktopTurnPermissionsForPermissionMode('default', {
    writableRoots: ['D:\\Git\\CodexMobile']
  }), {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'guardian_subagent',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['D:\\Git\\CodexMobile'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  });
  assert.deepEqual(desktopTurnPermissionsForPermissionMode('bypassPermissions', {
    dangerFullAccessEnabled: true,
    writableRoots: ['D:\\Git\\CodexMobile']
  }), {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' }
  });
});
