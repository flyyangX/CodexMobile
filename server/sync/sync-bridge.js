/**
 * 同步桥：接收 app-server v2 消息或统一 SyncEvent，产出最新 sync-state。
 *
 * Keywords: sync-bridge, app-server-v2, sync-event, broadcast
 *
 * Exports:
 * - createSyncBridge — 创建 app-server 消息/SyncEvent 到统一同步状态的转换桥。
 *
 * Inward（本模块依赖/组装的关键符号）: sync-events、sync-store、sync-projector。
 *
 * Outward（谁在用/调用场景）: server/index.js 的 broadcast 与 WebSocket connected 初始包。
 *
 * 不负责: 具体 WebSocket socket 管理。
 */

import { normalizeAppServerMessageToSyncEvents } from './app-server-events.js';
import { createSyncStore } from './sync-store.js';
import { syncEventPayload, syncStatePayload } from './sync-projector.js';

export function createSyncBridge(options = {}) {
  const store = createSyncStore(options);

  function consumeSyncEvents(events = []) {
    if (!events.length) {
      return [];
    }
    return events.map((event) => {
      const snapshot = store.applyEvent(event);
      return syncEventPayload(event, snapshot);
    });
  }

  function consumeAppServerMessage(appMessage = {}, context = {}) {
    const events = normalizeAppServerMessageToSyncEvents(appMessage, context);
    return consumeSyncEvents(events);
  }

  function publicState() {
    return store.snapshot();
  }

  function publicStatePayload() {
    return syncStatePayload(publicState());
  }

  return {
    consumeAppServerMessage,
    consumeSyncEvents,
    publicState,
    publicStatePayload,
    setBridgeStatus: store.setBridgeStatus
  };
}
