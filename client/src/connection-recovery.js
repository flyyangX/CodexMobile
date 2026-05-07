export function connectionRecoveryState({
  authenticated = true,
  connectionState = 'connected',
  desktopBridge = {},
  syncing = false
} = {}) {
  if (!authenticated) {
    return {
      state: 'pairing',
      title: '需要重新配对',
      detail: '当前设备授权失效，需要重新输入配对码。',
      primaryAction: 'pair',
      primaryLabel: '重新配对'
    };
  }

  if (connectionState === 'connecting') {
    return {
      state: 'reconnecting',
      title: '正在重连',
      detail: '正在恢复手机和本机服务的连接。',
      primaryAction: 'retry',
      primaryLabel: '重试'
    };
  }

  if (connectionState === 'disconnected') {
    return {
      state: 'disconnected',
      title: '连接已断开',
      detail: '本机服务暂时不可达，可以重试或重新配对。',
      primaryAction: 'retry',
      primaryLabel: '重试连接',
      secondaryAction: 'pair',
      secondaryLabel: '重新配对'
    };
  }

  const desktopBridgeHealthy = desktopBridge?.connected === true && desktopBridge?.mode !== 'unavailable';

  if (syncing && !desktopBridgeHealthy) {
    return {
      state: 'syncing',
      title: '正在同步',
      detail: '正在刷新桌面线程和本地缓存。',
      primaryAction: 'status',
      primaryLabel: '查看状态'
    };
  }

  if (desktopBridge && desktopBridge.connected === false) {
    return {
      state: 'desktop-unavailable',
      title: '桌面端未连接',
      detail: desktopBridge.reason || '打开桌面端 Codex 后可以继续实时同步。',
      primaryAction: 'sync',
      primaryLabel: '刷新同步',
      secondaryAction: 'status',
      secondaryLabel: '查看状态'
    };
  }

  if (desktopBridge?.mode === 'unavailable') {
    return {
      state: 'backend-unavailable',
      title: '后台不可用',
      detail: desktopBridge.reason || 'CodexMobile 后台可访问，但桌面桥接不可用。',
      primaryAction: 'sync',
      primaryLabel: '刷新同步',
      secondaryAction: 'status',
      secondaryLabel: '查看状态'
    };
  }

  return null;
}
