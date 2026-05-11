import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAIRING_REQUEST_COOLDOWN_MS,
  normalizePairingCode,
  pairingRequestCooldownSeconds,
  pairingPromptText,
  pairingRequestDisabled,
  pairingRequestLabel,
  pairingSubmitDisabled
} from './pairing-flow.js';

test('normalizePairingCode keeps uppercase alphanumeric code within length', () => {
  assert.equal(normalizePairingCode(' ab-cd 2345 xyz ', 10), 'ABCD2345XY');
});

test('normalizePairingCode accepts full-width mobile keyboard input', () => {
  assert.equal(normalizePairingCode('ＡＢＣＤＥＦＧＨＪＫ', 10), 'ABCDEFGHJK');
  assert.equal(normalizePairingCode('２３４５６７８９ＡＢ', 10), '23456789AB');
});

test('pairingPromptText describes request, code entry, and LAN-only states', () => {
  assert.equal(pairingPromptText({ requesting: true, codeLength: 10 }), '正在请求本机配对码...');
  assert.equal(
    pairingPromptText({ requesting: false, requestId: 'req-1', codeLength: 10 }),
    '输入电脑端控制台显示的 10 位配对码。'
  );
  assert.equal(
    pairingPromptText({ requesting: false, requestId: '', codeLength: 10 }),
    '需要绑定此设备时，先请求一次性配对码。'
  );
  assert.equal(
    pairingPromptText({ requesting: false, requestId: '', codeLength: 10, canPair: false }),
    '当前网络不能发起配对，请回到电脑所在局域网后再请求配对码。'
  );
});

test('pairing request button is explicit and disabled while busy or off-LAN', () => {
  assert.equal(pairingRequestLabel({ requesting: false, requestId: '' }), '请求配对码');
  assert.equal(pairingRequestLabel({ requesting: false, requestId: 'req-1' }), '重新请求配对码');
  assert.equal(pairingRequestLabel({ requesting: true, requestId: '' }), '请求中');
  assert.equal(pairingRequestDisabled({ requesting: false, pairing: false, canPair: true }), false);
  assert.equal(pairingRequestDisabled({ requesting: true, pairing: false, canPair: true }), true);
  assert.equal(pairingRequestDisabled({ requesting: false, pairing: true, canPair: true }), true);
  assert.equal(pairingRequestDisabled({ requesting: false, pairing: false, canPair: false }), true);
});

test('pairing request button respects request cooldown', () => {
  const nowMs = 1_000;
  const cooldownUntil = nowMs + PAIRING_REQUEST_COOLDOWN_MS;
  assert.equal(pairingRequestCooldownSeconds(cooldownUntil, nowMs), 30);
  assert.equal(pairingRequestLabel({ requesting: false, requestId: 'req-1', cooldownUntil, nowMs }), '30s 后可重新请求');
  assert.equal(pairingRequestDisabled({ requesting: false, pairing: false, canPair: true, cooldownUntil, nowMs }), true);
  assert.equal(pairingRequestDisabled({ requesting: false, pairing: false, canPair: true, cooldownUntil, nowMs: cooldownUntil }), false);
});

test('pairingSubmitDisabled requires a request id, complete code, and idle state', () => {
  assert.equal(pairingSubmitDisabled({ requestId: '', code: 'ABCDE23456', codeLength: 10 }), true);
  assert.equal(pairingSubmitDisabled({ requestId: 'req-1', code: 'ABCDE', codeLength: 10 }), true);
  assert.equal(pairingSubmitDisabled({ requestId: 'req-1', code: 'ABCDE23456', codeLength: 10, pairing: true }), true);
  assert.equal(pairingSubmitDisabled({ requestId: 'req-1', code: 'ABCDE23456', codeLength: 10, requesting: true }), true);
  assert.equal(pairingSubmitDisabled({ requestId: 'req-1', code: 'ABCDE23456', codeLength: 10 }), false);
});
