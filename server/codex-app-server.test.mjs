/**
 * 测试 server/codex-app-server.js：桌面线程列表参数、归档筛选与 control socket 失败降级。
 * Keywords: codex-app-server, archive, thread-list, socket, fallback
 * Exports: 无导出，内含用例
 * Inward: codex-app-server.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  desktopProxyFailureFallbackTransport,
  desktopThreadListRequestParams,
  filterDesktopThreadsForArchiveMode
} from './codex-app-server.js';

test('desktopThreadListRequestParams passes archived mode through to thread/list', () => {
  assert.deepEqual(desktopThreadListRequestParams({ cursor: 'next', limit: 25, archived: true }), {
    cursor: 'next',
    limit: 25,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: true
  });
});

test('filterDesktopThreadsForArchiveMode keeps archived threads only for archive box mode', () => {
  const threads = [
    { id: 'open-1', status: 'completed' },
    { id: 'archived-1', status: 'archived' },
    { id: 'archived-2', archived: true },
    { id: 'archived-3', status: { type: 'archived' } },
    { id: 'deleted-1', status: { type: 'deleted' } },
    { status: 'archived' }
  ];

  assert.deepEqual(filterDesktopThreadsForArchiveMode(threads, { archived: false }).map((thread) => thread.id), ['open-1']);
  assert.deepEqual(filterDesktopThreadsForArchiveMode(threads, { archived: true }).map((thread) => thread.id), [
    'open-1',
    'archived-1',
    'archived-2',
    'archived-3',
    'deleted-1'
  ]);
});

test('desktopProxyFailureFallbackTransport falls back to isolated mode for read-only calls', () => {
  assert.deepEqual(desktopProxyFailureFallbackTransport({}, { allowReadOnlyIsolated: true }), {
    mode: 'isolated-dev',
    strict: false,
    sockPath: null,
    connected: true,
    reason: '桌面端 control socket 无法连接，正在使用独立开发 app-server'
  });
});

test('desktopProxyFailureFallbackTransport falls back to headless mode for writable calls', () => {
  assert.deepEqual(desktopProxyFailureFallbackTransport({}, { allowHeadlessLocal: true }), {
    mode: 'headless-local',
    strict: false,
    sockPath: null,
    connected: true,
    reason: '桌面端 control socket 无法连接，正在使用后台 Codex 执行'
  });
});

test('desktopProxyFailureFallbackTransport respects disabled headless mode', () => {
  assert.equal(
    desktopProxyFailureFallbackTransport({ CODEXMOBILE_DISABLE_HEADLESS_CODEX: '1' }, { allowHeadlessLocal: true }),
    null
  );
});
