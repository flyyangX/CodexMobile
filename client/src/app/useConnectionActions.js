import { clearToken } from '../api.js';
import { bridgeConnectionLabel } from '../panels/index.js';

export function useConnectionActions({
  apiFetch,
  status,
  connectionState,
  setAuthenticated,
  setConnectionState,
  setSyncing,
  loadStatus,
  loadProjects,
  showToast
}) {
  async function handleSync() {
    setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      await loadStatus();
      await loadProjects({ preserveSelection: true });
      showToast({ level: 'success', title: '同步完成', body: '线程和状态已经刷新。' });
    } catch (error) {
      showToast({ level: 'error', title: '同步失败', body: error.message || '无法刷新同步。' });
    } finally {
      setSyncing(false);
    }
  }

  async function handleRetryConnection() {
    try {
      await loadStatus();
      showToast({ level: 'success', title: '连接已刷新', body: '已重新读取本机服务状态。' });
    } catch (error) {
      showToast({ level: 'error', title: '连接失败', body: error.message || '本机服务暂时不可达。' });
    }
  }

  function handleResetPairing() {
    clearToken();
    setAuthenticated(false);
    setConnectionState('disconnected');
  }

  function handleShowConnectionStatus() {
    showToast({
      level: status.desktopBridge?.connected ? 'info' : 'warning',
      title: bridgeConnectionLabel(connectionState, status.desktopBridge).label,
      body: status.desktopBridge?.reason || status.desktopBridge?.mode || 'CodexMobile 状态已读取。'
    });
  }

  return {
    handleSync,
    handleRetryConnection,
    handleResetPairing,
    handleShowConnectionStatus
  };
}
