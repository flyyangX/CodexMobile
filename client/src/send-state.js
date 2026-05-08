export function normalizeDesktopBridge(bridge = null) {
  return {
    strict: bridge?.strict !== false,
    connected: Boolean(bridge?.connected),
    mode: bridge?.mode || 'unavailable',
    reason: bridge?.reason || null,
    capabilities: bridge?.capabilities && typeof bridge.capabilities === 'object'
      ? bridge.capabilities
      : {}
  };
}

export function desktopBridgeCanCreateThread(bridge = null) {
  const normalized = normalizeDesktopBridge(bridge);
  if (!normalized.connected) {
    return false;
  }
  if (normalized.capabilities.backgroundCodex || normalized.capabilities.createThreadViaBackground) {
    return true;
  }
  if (normalized.capabilities.createThread === false) {
    return false;
  }
  if (normalized.mode === 'desktop-ipc' && normalized.capabilities.createThread !== true) {
    return false;
  }
  return true;
}

export function composerSendState({
  running = false,
  hasInput = false,
  uploading = false,
  desktopBridge = null,
  steerable = true,
  followUpMode = 'queue',
  sessionIsDraft = false
} = {}) {
  const bridge = normalizeDesktopBridge(desktopBridge);
  if (!bridge.connected) {
    return {
      disabled: true,
      label: '桌面端 Codex 未连接',
      mode: 'unavailable',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    };
  }
  if (sessionIsDraft && !desktopBridgeCanCreateThread(bridge)) {
    return {
      disabled: true,
      label: '只能继续桌面端已有对话',
      mode: 'create-unavailable',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    };
  }
  if (uploading) {
    return {
      disabled: true,
      label: '正在上传',
      mode: 'uploading',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    };
  }
  if (running && !hasInput) {
    return {
      disabled: false,
      label: '中止当前任务',
      mode: 'abort',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: true
    };
  }
  if (running && hasInput) {
    const normalizedFollowUpMode = followUpMode === 'steer' && steerable ? 'steer' : 'queue';
    return {
      disabled: false,
      label: normalizedFollowUpMode === 'steer' ? '引导' : '排队',
      mode: normalizedFollowUpMode,
      showMenu: true,
      canSteer: Boolean(steerable),
      canQueue: true,
      canInterrupt: true
    };
  }
  return {
    disabled: !hasInput,
    label: '发送消息',
    mode: 'start',
    showMenu: false,
    canSteer: false,
    canQueue: false,
    canInterrupt: false
  };
}
