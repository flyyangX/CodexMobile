/**
 * 测试 pairing-flow.js：默认设备名识别与配对码规范化。
 *
 * Keywords: pairing-flow, device-name, tests
 *
 * Exports: 无导出 / 内含用例
 *
 * Inward: pairing-flow.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultDeviceName, normalizePairingCode, pairingRequestFromSearch, startPairingRequest } from './pairing-flow.js';

test('defaultDeviceName recognizes common mobile browsers', () => {
  assert.equal(defaultDeviceName({ platform: 'iPhone', userAgent: 'Mobile Safari' }), 'iPhone');
  assert.equal(defaultDeviceName({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (iPad)' }), 'iPad');
  assert.equal(defaultDeviceName({ platform: 'Linux armv8', userAgent: 'Android Chrome' }), 'Android');
  assert.equal(defaultDeviceName({ platform: 'MacIntel', userAgent: 'Desktop' }), 'Mac');
  assert.equal(defaultDeviceName({ platform: 'Win32', userAgent: 'Chrome' }), 'Windows PC');
});

test('pairingRequestFromSearch parses terminal pairing links safely', () => {
  assert.deepEqual(
    pairingRequestFromSearch('?requestId=req-1&code=jqut-zfc7-4q&codeLength=10'),
    { requestId: 'req-1', code: 'JQUTZFC74Q', codeLength: 10, autoSubmit: true }
  );
  assert.equal(pairingRequestFromSearch('?requestId=req-1&code=bad*&codeLength=10'), null);
  assert.equal(pairingRequestFromSearch('?code=JQUTZFC74Q'), null);
});

test('normalizePairingCode accepts terminal formatted codes with separators', () => {
  assert.equal(normalizePairingCode('K7B4-HT34-MK', 10), 'K7B4HT34MK');
  assert.equal(normalizePairingCode(' k7b4 ht34 mk ', 10), 'K7B4HT34MK');
});

test('startPairingRequest asks the server to create a phone pairing request', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ requestId: 'req-phone', codeLength: 10 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  globalThis.localStorage = {
    getItem: () => '',
    removeItem: () => {}
  };

  try {
    const result = await startPairingRequest({ deviceName: 'iPhone' });

    assert.deepEqual(result, { requestId: 'req-phone', codeLength: 10 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/pair/request');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { deviceName: 'iPhone' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) {
      globalThis.localStorage = originalLocalStorage;
    } else {
      delete globalThis.localStorage;
    }
  }
});
