import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientRemoteAddress,
  envFlag,
  isPrivateRemoteAddress,
  isRequestTransportSecure,
  isTrustedProxy,
  readSecurityOptions,
  sameOriginAllowed
} from './security-options.js';

test('envFlag only enables explicit true-like values', () => {
  assert.equal(envFlag({ A: '1' }, 'A'), true);
  assert.equal(envFlag({ A: 'true' }, 'A'), true);
  assert.equal(envFlag({ A: 'yes' }, 'A'), true);
  assert.equal(envFlag({ A: 'on' }, 'A'), true);
  assert.equal(envFlag({ A: '0' }, 'A'), false);
  assert.equal(envFlag({ A: 'false' }, 'A'), false);
  assert.equal(envFlag({}, 'A'), false);
});

test('isPrivateRemoteAddress recognizes loopback and private networks', () => {
  assert.equal(isPrivateRemoteAddress('127.0.0.1'), true);
  assert.equal(isPrivateRemoteAddress('::1'), true);
  assert.equal(isPrivateRemoteAddress('::ffff:192.168.1.20'), true);
  assert.equal(isPrivateRemoteAddress('100.64.1.2'), true);
  assert.equal(isPrivateRemoteAddress('100.127.255.254'), true);
  assert.equal(isPrivateRemoteAddress('100.128.0.1'), false);
  assert.equal(isPrivateRemoteAddress('10.12.0.8'), true);
  assert.equal(isPrivateRemoteAddress('172.16.0.9'), true);
  assert.equal(isPrivateRemoteAddress('172.31.255.9'), true);
  assert.equal(isPrivateRemoteAddress('172.32.0.9'), false);
  assert.equal(isPrivateRemoteAddress('203.0.113.9'), false);
});

test('CODEXMOBILE_PRIVATE_CIDRS extends LAN detection explicitly', () => {
  const options = readSecurityOptions({ CODEXMOBILE_PRIVATE_CIDRS: '198.51.100.0/24' });
  assert.equal(isPrivateRemoteAddress('198.51.100.7', options), true);
  assert.equal(isPrivateRemoteAddress('198.51.101.7', options), false);
});

test('readSecurityOptions defaults to safe private deployment values', () => {
  const options = readSecurityOptions({});
  assert.equal(options.publicAccess, false);
  assert.equal(options.allowRemotePairing, false);
  assert.equal(options.dangerFullAccessEnabled, false);
  assert.equal(options.legacyBearerEnabled, false);
  assert.deepEqual(options.trustedProxyCidrs, []);
  assert.equal(options.pairingCodeLength, 10);
  assert.equal(options.pairingCodeTtlMs, 600000);
  assert.equal(options.pairingRequestCooldownMs, 30000);
  assert.deepEqual(options.allowedOrigins, []);
});

test('CODEXMOBILE_PAIRING_REQUEST_COOLDOWN_MS configures pairing cooldown', () => {
  assert.equal(readSecurityOptions({ CODEXMOBILE_PAIRING_REQUEST_COOLDOWN_MS: '45000' }).pairingRequestCooldownMs, 45000);
});

test('legacy Bearer auth requires an explicit migration flag', () => {
  assert.equal(readSecurityOptions({}).legacyBearerEnabled, false);
  assert.equal(readSecurityOptions({ CODEXMOBILE_ALLOW_LEGACY_BEARER: '1' }).legacyBearerEnabled, true);
});

test('sameOriginAllowed accepts configured public URL and extra origins', () => {
  const options = readSecurityOptions({
    CODEXMOBILE_PUBLIC_URL: 'https://codex.example.com/mobile',
    CODEXMOBILE_ALLOWED_ORIGINS: 'https://extra.example.com'
  });
  assert.equal(sameOriginAllowed('https://codex.example.com', options), true);
  assert.equal(sameOriginAllowed('https://extra.example.com', options), true);
  assert.equal(sameOriginAllowed('https://evil.example.com', options), false);
});

test('clientRemoteAddress ignores forwarded headers unless socket peer is a trusted proxy', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.20' },
    headers: { 'x-forwarded-for': '192.168.1.8, 203.0.113.1' }
  };
  assert.equal(clientRemoteAddress(req, readSecurityOptions({})), '203.0.113.20');
  assert.equal(clientRemoteAddress(req, readSecurityOptions({ CODEXMOBILE_TRUSTED_PROXIES: '127.0.0.1' })), '203.0.113.20');

  const proxied = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.22, 127.0.0.1' }
  };
  assert.equal(isTrustedProxy('127.0.0.1', readSecurityOptions({ CODEXMOBILE_TRUSTED_PROXIES: '127.0.0.1' })), true);
  assert.equal(clientRemoteAddress(proxied, readSecurityOptions({ CODEXMOBILE_TRUSTED_PROXIES: '127.0.0.1' })), '198.51.100.22');
});

test('isRequestTransportSecure accepts forwarded https only from trusted proxies', () => {
  assert.equal(isRequestTransportSecure({ socket: { encrypted: true }, headers: {} }, readSecurityOptions({})), true);
  assert.equal(
    isRequestTransportSecure({ socket: { remoteAddress: '203.0.113.20' }, headers: { 'x-forwarded-proto': 'https' } }, readSecurityOptions({ CODEXMOBILE_TRUSTED_PROXIES: '127.0.0.1' })),
    false
  );
  assert.equal(
    isRequestTransportSecure(
      { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } },
      readSecurityOptions({ CODEXMOBILE_TRUSTED_PROXIES: '127.0.0.1' })
    ),
    true
  );
});
