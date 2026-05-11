export function dangerFullAccessDisabledError() {
  const error = new Error('danger-full-access is disabled on this server');
  error.statusCode = 403;
  error.code = 'CODEXMOBILE_DANGER_FULL_ACCESS_DISABLED';
  return error;
}

export function normalizePermissionMode(permissionMode, { dangerFullAccessEnabled = false } = {}) {
  const value = String(permissionMode || '').trim();
  if (value === 'bypassPermissions') {
    if (!dangerFullAccessEnabled) {
      throw dangerFullAccessDisabledError();
    }
    return 'bypassPermissions';
  }
  if (value === 'acceptEdits') {
    return 'acceptEdits';
  }
  return 'default';
}

export function codexSandboxForPermissionMode(permissionMode, options = {}) {
  const normalized = normalizePermissionMode(permissionMode, options);
  if (normalized === 'bypassPermissions') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
  }
  return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
}

export function desktopSandboxPolicyForPermissionMode(permissionMode, options = {}) {
  const normalized = normalizePermissionMode(permissionMode, options);
  if (normalized === 'bypassPermissions') {
    return { type: 'dangerFullAccess' };
  }
  const writableRoots = Array.isArray(options.writableRoots)
    ? [...new Set(options.writableRoots.filter(Boolean).map((entry) => String(entry)))]
    : [];
  return {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: options.networkAccess !== false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

export function desktopTurnPermissionsForPermissionMode(permissionMode, options = {}) {
  const normalized = normalizePermissionMode(permissionMode, options);
  if (normalized === 'bypassPermissions') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' }
    };
  }
  if (normalized === 'acceptEdits') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: desktopSandboxPolicyForPermissionMode(normalized, options)
    };
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'guardian_subagent',
    sandboxPolicy: desktopSandboxPolicyForPermissionMode(normalized, options)
  };
}
