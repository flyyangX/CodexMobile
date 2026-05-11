import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for server output: ${pattern}`));
    }, 15_000);

    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes(pattern)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Server exited before ready: code=${code} signal=${signal} output=${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    once(child, 'close'),
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);
}

function requestJson({ port, method = 'POST', path = '/api/chat/send', headers, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        let json = {};
        try {
          json = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          json = {};
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

test('chat POST rejects Host-derived cross-origin requests that are not configured', async (t) => {
  const port = await getFreePort();
  const httpsPort = await getFreePort();
  const home = path.join(os.tmpdir(), `codexmobile-integration-${process.pid}-${Date.now()}`);
  const missingPfx = path.join(home, 'missing-server.pfx');
  const child = spawn(process.execPath, [
    'server/index.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--https-port',
    String(httpsPort)
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CODEXMOBILE_HOME: home,
      CODEXMOBILE_PUBLIC_ACCESS: '0',
      HTTPS_PFX_PATH: missingPfx
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    await stopChild(child);
    await fs.rm(home, { recursive: true, force: true });
  });

  await waitForOutput(child, `CodexMobile listening on http://127.0.0.1:${port}`);

  for (const origin of ['http://evil.com', 'https://evil.com']) {
    const response = await requestJson({
      port,
      headers: {
        host: 'evil.com',
        origin,
        'content-type': 'application/json'
      },
      body: '{}'
    });

    assert.equal(response.statusCode, 403, origin);
    assert.match(response.body, /Cross-origin request rejected/, origin);
  }
});

test('pair request allows local HTTPS localhost origin', async (t) => {
  const port = await getFreePort();
  const httpsPort = await getFreePort();
  const home = path.join(os.tmpdir(), `codexmobile-integration-${process.pid}-${Date.now()}-localhost`);
  const missingPfx = path.join(home, 'missing-server.pfx');
  const child = spawn(process.execPath, [
    'server/index.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--https-port',
    String(httpsPort)
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CODEXMOBILE_HOME: home,
      CODEXMOBILE_PUBLIC_ACCESS: '0',
      HTTPS_PFX_PATH: missingPfx
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const captureOutput = (chunk) => {
    output += chunk.toString('utf8');
  };
  child.stdout.on('data', captureOutput);
  child.stderr.on('data', captureOutput);

  t.after(async () => {
    child.stdout.off('data', captureOutput);
    child.stderr.off('data', captureOutput);
    await stopChild(child);
    await fs.rm(home, { recursive: true, force: true });
  });

  await waitForOutput(child, `CodexMobile listening on http://127.0.0.1:${port}`);

  const response = await requestJson({
    port,
    path: '/api/pair/request',
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `https://localhost:${httpsPort}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ deviceName: 'Integration Test' })
  });

  assert.equal(response.statusCode, 200);
  assert.match(output, /\[pairing\] code hidden because stdout is not an interactive terminal/);
  assert.doesNotMatch(output, /\[pairing\] code=[A-Z2-9]{10}/);
});

test('pair request and websocket allow same private host origin', async (t) => {
  const port = await getFreePort();
  const httpsPort = await getFreePort();
  const home = path.join(os.tmpdir(), `codexmobile-integration-${process.pid}-${Date.now()}-private-origin`);
  const missingPfx = path.join(home, 'missing-server.pfx');
  const token = 'private-origin-token';
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'auth-state.json'), JSON.stringify({
    devices: [{
      id: 'private-origin-device',
      name: 'Private Origin Device',
      tokenHash,
      tokens: [{
        hash: tokenHash,
        createdAt: now,
        expiresAt: '2999-01-01T00:00:00.000Z',
        supersededAt: null
      }],
      createdAt: now,
      expiresAt: '2999-01-01T00:00:00.000Z',
      revokedAt: null,
      lastSeenAt: now
    }]
  }, null, 2), 'utf8');

  const child = spawn(process.execPath, [
    'server/index.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--https-port',
    String(httpsPort)
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CODEXMOBILE_HOME: home,
      CODEXMOBILE_PUBLIC_ACCESS: '0',
      HTTPS_PFX_PATH: missingPfx
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    await stopChild(child);
    await fs.rm(home, { recursive: true, force: true });
  });

  await waitForOutput(child, `CodexMobile listening on http://127.0.0.1:${port}`);
  const privateHost = `192.168.1.50:${port}`;
  const privateOrigin = `http://${privateHost}`;

  const pairResponse = await requestJson({
    port,
    path: '/api/pair/request',
    headers: {
      host: privateHost,
      origin: privateOrigin,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ deviceName: 'Private Host Test' })
  });
  assert.equal(pairResponse.statusCode, 200);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      host: privateHost,
      origin: privateOrigin,
      cookie: `codexmobile_token=${token}`
    }
  });
  t.after(() => ws.close());

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private host websocket did not open')), 1000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected websocket response: ${response.statusCode}`));
    });
  });
});

test('websocket uses cookie auth and closes after current device revoke', async (t) => {
  const port = await getFreePort();
  const httpsPort = await getFreePort();
  const home = path.join(os.tmpdir(), `codexmobile-integration-${process.pid}-${Date.now()}-ws`);
  const missingPfx = path.join(home, 'missing-server.pfx');
  const token = 'integration-cookie-token';
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'auth-state.json'), JSON.stringify({
    devices: [{
      id: 'integration-device',
      name: 'Integration Device',
      tokenHash,
      tokens: [{
        hash: tokenHash,
        createdAt: now,
        expiresAt: '2999-01-01T00:00:00.000Z',
        supersededAt: null
      }],
      createdAt: now,
      expiresAt: '2999-01-01T00:00:00.000Z',
      revokedAt: null,
      lastSeenAt: now
    }]
  }, null, 2), 'utf8');

  const child = spawn(process.execPath, [
    'server/index.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--https-port',
    String(httpsPort)
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CODEXMOBILE_HOME: home,
      CODEXMOBILE_PUBLIC_ACCESS: '0',
      HTTPS_PFX_PATH: missingPfx
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    await stopChild(child);
    await fs.rm(home, { recursive: true, force: true });
  });

  await waitForOutput(child, `CodexMobile listening on http://127.0.0.1:${port}`);
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `codexmobile_token=${token}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { cookie, origin }
  });
  t.after(() => ws.close());

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const devices = await requestJson({
    port,
    method: 'GET',
    path: '/api/devices',
    headers: { cookie }
  });
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.json.devices?.[0]?.current, true);

  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket was not closed after revoke')), 1000);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });

  const revoked = await requestJson({
    port,
    method: 'POST',
    path: '/api/devices/integration-device/revoke',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json'
    },
    body: '{}'
  });
  assert.equal(revoked.statusCode, 200);

  const close = await closed;
  assert.equal(close.code, 1008);
  assert.equal(close.reason, 'revoked');
});
