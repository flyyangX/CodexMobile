import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveAppServerTransport, resolveCodexBinary } from './codex-app-server.js';

test('resolveAppServerTransport is strict and unavailable without a desktop socket', () => {
  const transport = resolveAppServerTransport({
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock'
  });

  assert.equal(transport.strict, true);
  assert.equal(transport.connected, false);
  assert.equal(transport.mode, 'unavailable');
  assert.match(transport.reason, /不存在|未找到|No such/i);
});

test('resolveAppServerTransport only allows isolated app-server behind an explicit dev flag', () => {
  const transport = resolveAppServerTransport({
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock',
    CODEXMOBILE_ALLOW_ISOLATED_CODEX: '1'
  });

  assert.equal(transport.strict, false);
  assert.equal(transport.connected, true);
  assert.equal(transport.mode, 'isolated-dev');
});

test('resolveAppServerTransport can use a headless local fallback when explicitly allowed', () => {
  const transport = resolveAppServerTransport({
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock'
  }, { allowHeadlessLocal: true });

  assert.equal(transport.strict, false);
  assert.equal(transport.connected, true);
  assert.equal(transport.mode, 'headless-local');
  assert.match(transport.reason, /后台 Codex/);
});

test('resolveCodexBinary prefers the Windows desktop Codex binary when present', () => {
  const localAppData = path.win32.join('C:\\Users', 'Ray', 'AppData', 'Local');
  const desktopBinary = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe');

  assert.equal(resolveCodexBinary({
    env: { LOCALAPPDATA: localAppData },
    platform: 'win32',
    existsSync: (candidate) => candidate === desktopBinary
  }), desktopBinary);
});
