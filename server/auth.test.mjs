import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthController } from './auth.js';
import { readSecurityOptions } from './security-options.js';

async function tempAuth() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-'));
  let nowMs = Date.parse('2026-05-10T00:00:00.000Z');
  const logs = [];
  const auth = createAuthController({
    dataDir,
    now: () => nowMs,
    logPairingCode: (entry) => logs.push(entry)
  });
  await auth.initializeAuth();
  return {
    auth,
    logs,
    advance(ms) {
      nowMs += ms;
    },
    security(overrides = {}) {
      return readSecurityOptions({ ...overrides });
    }
  };
}

function setStdoutIsTTY(value) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdout, 'isTTY', descriptor);
    } else {
      delete process.stdout.isTTY;
    }
  };
}

test('LAN pairing request creates one console-visible code and stores only a hash', async () => {
  const t = await tempAuth();
  const result = await t.auth.startPairingRequest({
    deviceName: 'iPhone / WeChat',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  assert.equal(result.ok, true);
  assert.match(result.requestId, /^[0-9a-f-]{36}$/);
  assert.match(result.code, /^[A-Z2-9]{10}$/);
  assert.equal(t.logs.length, 1);
  assert.equal(t.logs[0].code, result.code);
  assert.equal(t.auth.getPendingPairingRequest(result.requestId).code, undefined);
  assert.match(t.auth.getPendingPairingRequest(result.requestId).codeHash, /^[a-f0-9]{64}$/);
});

test('default pairing logger writes code only to stdout and keeps structured log redacted', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-default-log-'));
  const auth = createAuthController({
    dataDir,
    now: () => Date.parse('2026-05-10T00:00:00.000Z')
  });
  const stdoutWrites = [];
  const consoleLogs = [];
  const originalStdoutWrite = process.stdout.write;
  const originalConsoleLog = console.log;
  const restoreStdoutIsTTY = setStdoutIsTTY(true);
  process.stdout.write = (chunk, ...args) => {
    stdoutWrites.push(String(chunk));
    if (typeof args.at(-1) === 'function') {
      args.at(-1)();
    }
    return true;
  };
  console.log = (...args) => {
    consoleLogs.push(args.map((entry) => String(entry)).join(' '));
  };
  try {
    await auth.initializeAuth();
    const result = await auth.startPairingRequest({
      deviceName: 'iPhone / WeChat',
      userAgent: 'WeChat',
      remoteAddress: '192.168.1.23',
      securityOptions: readSecurityOptions()
    });

    assert.equal(result.ok, true);
    assert.match(stdoutWrites.join(''), new RegExp(`\\[pairing\\] code=${result.code}\\n`));
    assert.equal(consoleLogs.some((line) => line.includes(result.code)), false);
    assert.equal(consoleLogs.some((line) => line.includes(result.requestId)), true);
  } finally {
    restoreStdoutIsTTY();
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
  }
});

test('default pairing logger hides code when stdout is redirected', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-background-log-'));
  const auth = createAuthController({
    dataDir,
    now: () => Date.parse('2026-05-10T00:00:00.000Z')
  });
  const stdoutWrites = [];
  const consoleLogs = [];
  const originalStdoutWrite = process.stdout.write;
  const originalConsoleLog = console.log;
  const restoreStdoutIsTTY = setStdoutIsTTY(false);
  process.stdout.write = (chunk, ...args) => {
    stdoutWrites.push(String(chunk));
    if (typeof args.at(-1) === 'function') {
      args.at(-1)();
    }
    return true;
  };
  console.log = (...args) => {
    consoleLogs.push(args.map((entry) => String(entry)).join(' '));
  };
  try {
    await auth.initializeAuth();
    const result = await auth.startPairingRequest({
      deviceName: 'iPhone / WeChat',
      userAgent: 'WeChat',
      remoteAddress: '192.168.1.23',
      securityOptions: readSecurityOptions()
    });

    assert.equal(result.ok, true);
    assert.equal(stdoutWrites.some((line) => line.includes(result.code)), false);
    assert.equal(consoleLogs.some((line) => line.includes(result.code)), false);
    assert.equal(consoleLogs.some((line) => line.includes('code hidden')), true);
    assert.equal(consoleLogs.some((line) => line.includes(result.requestId)), true);
  } finally {
    restoreStdoutIsTTY();
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
  }
});

test('WAN pairing request is rejected by default', async () => {
  const t = await tempAuth();
  const result = await t.auth.startPairingRequest({
    deviceName: 'Remote iPhone',
    userAgent: 'WeChat',
    remoteAddress: '203.0.113.9',
    securityOptions: t.security()
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
});

test('pairing request creation is rate limited per remote before a code is printed', async () => {
  const t = await tempAuth();
  for (let i = 0; i < 5; i += 1) {
    const result = await t.auth.startPairingRequest({
      deviceName: `iPhone ${i}`,
      userAgent: 'WeChat',
      remoteAddress: '192.168.1.23',
      securityOptions: t.security()
    });
    assert.equal(result.ok, true);
    t.advance(30 * 1000);
  }
  const blocked = await t.auth.startPairingRequest({
    deviceName: 'iPhone overflow',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(t.logs.length, 5);
});

test('pairing request creation has a per-remote cooldown before another code is printed', async () => {
  const t = await tempAuth();
  const first = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_PAIRING_REQUEST_COOLDOWN_MS: '30000' })
  });
  assert.equal(first.ok, true);

  const blocked = await t.auth.startPairingRequest({
    deviceName: 'iPhone again',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_PAIRING_REQUEST_COOLDOWN_MS: '30000' })
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.error, 'Pairing request cooldown');
  assert.equal(blocked.retryAfterSeconds, 30);
  assert.equal(t.logs.length, 1);

  t.advance(30 * 1000);
  const second = await t.auth.startPairingRequest({
    deviceName: 'iPhone later',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_PAIRING_REQUEST_COOLDOWN_MS: '30000' })
  });
  assert.equal(second.ok, true);
  assert.equal(t.logs.length, 2);
});

test('pairing completion requires same request, same remote, valid code, and unused request', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone / WeChat',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const wrongRemote = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.24',
    securityOptions: t.security()
  });
  assert.equal(wrongRemote.ok, false);
  assert.equal(wrongRemote.statusCode, 403);

  const paired = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  assert.equal(paired.ok, true);
  assert.match(paired.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(paired.device.name, 'iPhone / WeChat');

  const reused = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.statusCode, 404);
});

test('expired pairing request cannot complete', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  t.advance(10 * 60 * 1000 + 1);
  const result = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 410);
});

test('wrong codes are rate limited', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  for (let i = 0; i < 5; i += 1) {
    const result = await t.auth.completePairingRequest({
      requestId: request.requestId,
      code: 'AAAAAAAAAA',
      remoteAddress: '192.168.1.23',
      securityOptions: t.security()
    });
    assert.equal(result.ok, false);
  }
  const locked = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.statusCode, 429);
});

test('token verifies, expires, and can be revoked', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const paired = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const verified = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    securityOptions: t.security()
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.device.id, paired.device.id);

  const revoked = await t.auth.revokeDevice(paired.device.id);
  assert.equal(revoked.ok, true);
  const afterRevoke = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    securityOptions: t.security()
  });
  assert.equal(afterRevoke.ok, false);
});

test('verifyToken rotates old tokens after half of ttl has elapsed', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const paired = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  t.advance(51 * 1000);
  const verified = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  assert.equal(verified.ok, true);
  assert.match(verified.replacementToken, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verified.replacementToken, paired.token);
});

test('verifyToken maps superseded grace tokens to the active token hash', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const paired = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  t.advance(51 * 1000);
  const rotated = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  assert.equal(rotated.ok, true);
  assert.match(rotated.replacementToken, /^[A-Za-z0-9_-]+$/);

  const grace = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  assert.equal(grace.ok, true);
  assert.equal(grace.replacementToken, null);
  assert.equal(grace.tokenHash, rotated.tokenHash);
  assert.equal(grace.device.current, true);

  const websocketGrace = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    rotate: false,
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  assert.equal(websocketGrace.ok, true);
  assert.equal(websocketGrace.replacementToken, null);
  assert.equal(websocketGrace.tokenHash, rotated.tokenHash);
});

test('verifyToken can skip rotation for websocket upgrades', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const paired = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  t.advance(51 * 1000);
  const verified = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    rotate: false,
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.replacementToken, null);
});

test('revokeToken closes sockets registered to all tokens for the same device', async () => {
  const t = await tempAuth();
  const request = await t.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'WeChat',
    remoteAddress: '192.168.1.23',
    securityOptions: t.security()
  });
  const paired = await t.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  t.advance(51 * 1000);
  const rotated = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  const oldSocket = { closed: false, close() { this.closed = true; } };
  const newSocket = { closed: false, close() { this.closed = true; } };
  const oldVerification = await t.auth.verifyToken(paired.token, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    rotate: false,
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  const newVerification = await t.auth.verifyToken(rotated.replacementToken, {
    remoteAddress: '198.51.100.7',
    userAgent: 'WeChat',
    rotate: false,
    securityOptions: t.security({ CODEXMOBILE_TOKEN_TTL_MS: String(100 * 1000) })
  });
  t.auth.registerSocket(oldVerification.tokenHash, oldSocket);
  t.auth.registerSocket(newVerification.tokenHash, newSocket);

  const revoked = await t.auth.revokeToken(paired.token);

  assert.equal(revoked.ok, true);
  assert.equal(oldSocket.closed, true);
  assert.equal(newSocket.closed, true);
});

test('auth state writes through a temporary file before replacing state file', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-atomic-'));
  const writes = [];
  const originalWriteFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (filePath, ...args) => {
    writes.push(path.basename(String(filePath)));
    return originalWriteFile(filePath, ...args);
  });

  const auth = createAuthController({ dataDir });
  await auth.initializeAuth();

  assert.ok(writes.some((name) => name.startsWith('auth-state.json.tmp-')));
  assert.equal(writes.includes('auth-state.json'), false);
  assert.equal((await fs.readdir(dataDir)).some((name) => name.startsWith('auth-state.json.tmp-')), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'auth-state.json'), 'utf8')), {
    devices: []
  });
});

test('concurrent token verification serializes auth state writes', async (t) => {
  const authContext = await tempAuth();
  const request = await authContext.auth.startPairingRequest({
    deviceName: 'iPhone',
    userAgent: 'Mobile Safari',
    remoteAddress: '192.168.1.23',
    securityOptions: authContext.security()
  });
  const paired = await authContext.auth.completePairingRequest({
    requestId: request.requestId,
    code: request.code,
    remoteAddress: '192.168.1.23',
    securityOptions: authContext.security()
  });

  let barrierEnabled = false;
  const originalWriteFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (filePath, ...args) => {
    await originalWriteFile(filePath, ...args);
    if (barrierEnabled && path.basename(String(filePath)).startsWith('auth-state.json.tmp')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  barrierEnabled = true;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    authContext.auth.verifyToken(paired.token, {
      remoteAddress: '192.168.1.23',
      userAgent: 'Mobile Safari',
      securityOptions: authContext.security(),
      rotate: false
    })
  ));

  assert.deepEqual(results.map((result) => result.status), Array(8).fill('fulfilled'));
  assert.deepEqual(results.map((result) => result.value.ok), Array(8).fill(true));
});
