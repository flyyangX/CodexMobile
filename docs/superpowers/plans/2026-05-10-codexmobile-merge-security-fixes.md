# CodexMobile Merge Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining merge-blocking public-exposure security issues and document the lower-priority follow-up hardening tasks.

**Architecture:** Keep the server as the single security boundary: allowed origins come only from configuration plus explicit localhost defaults, authentication uses `HttpOnly` cookies with `SameSite=Strict`, and public mode avoids exposing the HTTP listener on non-loopback when HTTPS is available. Tests should exercise the real HTTP/WS contracts where a pure unit test would miss the deployment behavior.

**Tech Stack:** Node.js 22 built-in test runner, `ws`, Vite/React client, PowerShell startup scripts.

---

## File Structure

- `server/index.js`: remove Host-derived origin trust, add fixed local origin defaults, use static `securityOptions` for HTTP and WebSocket origin checks, and start HTTPS before deciding the HTTP bind address.
- `server/server-options.js`: expose the small pure HTTP bind decision helper used by `server/index.js`.
- `server/server-options.test.mjs`: assert public HTTPS mode binds HTTP to loopback only after HTTPS has actually started.
- `server/request-security.js`: change auth cookie SameSite policy to `Strict`; optionally extend `rejectSuspiciousFetchSite` for protected GET endpoints.
- `server/request-security.test.mjs`: assert `SameSite=Strict` and cross-site protected GET rejection behavior.
- `server/integration.test.mjs`: spawn a real temporary server for Host/Origin rejection and the Phase C WebSocket revocation contract test.
- `scripts/start-all.ps1`: rename parameter `$Host` to `$BindHost` to avoid colliding with PowerShell's built-in `$Host`.
- `client/src/api.js`: keep legacy localStorage cleanup only as an explicitly named migration cleanup helper.
- `server/auth.js`: split pairing code logging so the full pairing code only goes to direct stdout; Phase C adds rotation-race mitigation and atomic state writes.
- `server/auth.test.mjs`: add regression tests for pairing-code logging, token rotation race, and atomic writes.
- `server/upload-service.js`: Phase C adds minimal magic-byte sniffing and MIME normalization.
- `server/upload-service.test.mjs`: Phase C asserts mismatched upload MIME is downgraded to `application/octet-stream`.
- `README.md` / `.env.example`: update only if behavior or operator guidance changes.

---

## Phase A: Merge-Blocking Fixes

### Task 1: Remove Host-Origin Auto Allowlist (C1)

**Files:**
- Modify: `server/index.js`
- Create: `server/integration.test.mjs`

- [ ] **Step 1: Write the failing integration test**

Create `server/integration.test.mjs` with this initial content:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForOutput(lines, matcher, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const existing = lines.find((line) => matcher.test(line));
    if (existing) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${matcher}`));
    }, timeoutMs);
    lines.waiters.push((line) => {
      if (matcher.test(line)) {
        clearTimeout(timer);
        resolve(line);
        return true;
      }
      return false;
    });
  });
}

function pushOutputLine(lines, line) {
  lines.push(line);
  lines.waiters = lines.waiters.filter((waiter) => !waiter(line));
}

async function startServer(t, extraEnv = {}) {
  const port = await freePort();
  const httpsPort = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-integration-'));
  const stdout = [];
  stdout.waiters = [];
  const stderr = [];
  stderr.waiters = [];
  const child = spawn(process.execPath, [
    'server/index.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--https-port',
    String(httpsPort)
  ], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEXMOBILE_HOME: home,
      CODEXMOBILE_PUBLIC_ACCESS: '0',
      HTTPS_PFX_PATH: path.join(home, 'missing-server.pfx'),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      pushOutputLine(stdout, line);
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      pushOutputLine(stderr, line);
    }
  });

  t.after(() => {
    child.kill();
  });

  await waitForOutput(stdout, /CodexMobile listening on http:\/\/127\.0\.0\.1:/);
  return { port, httpsPort, home, stdout, stderr, child };
}

function httpRequest({ port, method = 'GET', path: requestPath = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        'content-length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('state-changing requests do not trust matching Host and Origin automatically', async (t) => {
  const { port } = await startServer(t);
  const response = await httpRequest({
    port,
    method: 'POST',
    path: '/api/chat/send',
    headers: {
      host: 'evil.com',
      origin: 'https://evil.com',
      'content-type': 'application/json'
    },
    body: '{}'
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /Cross-origin request rejected/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test server/integration.test.mjs
```

Expected: FAIL because the server currently derives `https://evil.com` from the request `Host` header and accepts the matching `Origin`.

- [ ] **Step 3: Add fixed local allowed origins**

In `server/index.js`, replace:

```js
const securityOptions = readSecurityOptions();
```

with:

```js
function withLocalAllowedOrigins(options) {
  return {
    ...options,
    allowedOrigins: [
      ...new Set([
        ...(options.allowedOrigins || []),
        `http://127.0.0.1:${PORT}`,
        `http://localhost:${PORT}`,
        `https://127.0.0.1:${HTTPS_PORT}`
      ])
    ]
  };
}

const securityOptions = withLocalAllowedOrigins(readSecurityOptions());
```

- [ ] **Step 4: Delete request-derived origin helpers**

In `server/index.js`, delete these functions entirely:

```js
function requestHostOrigin(req) {
  const host = String(req.headers.host || '').trim();
  if (!host) {
    return '';
  }
  const protocol = isRequestTransportSecure(req, securityOptions) ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function requestSecurityOptions(req) {
  const origin = requestHostOrigin(req);
  return {
    ...securityOptions,
    allowedOrigins: [...new Set([...(securityOptions.allowedOrigins || []), origin].filter(Boolean))]
  };
}
```

- [ ] **Step 5: Use static security options for HTTP origin rejection**

In `requestHandler`, replace:

```js
const originRejection = rejectUnsafeOrigin(req, requestSecurityOptions(req));
```

with:

```js
const originRejection = rejectUnsafeOrigin(req, securityOptions);
```

- [ ] **Step 6: Use static security options for WebSocket origin rejection**

Add `sameOriginAllowed` to the `server/security-options.js` import list in `server/index.js`:

```js
  requestMayUsePublicHttp,
  sameOriginAllowed
} from './security-options.js';
```

Then replace this check:

```js
if (origin && !requestSecurityOptions(req).allowedOrigins.includes(origin)) {
```

with:

```js
if (!sameOriginAllowed(origin, securityOptions)) {
```

- [ ] **Step 7: Run the integration test**

Run:

```powershell
node --test server/integration.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add server/index.js server/integration.test.mjs
git commit -m "fix: stop trusting Host-derived origins"
```

---

### Task 2: Set Auth Cookie SameSite=Strict (C2)

**Files:**
- Modify: `server/request-security.js`
- Modify: `server/request-security.test.mjs`

- [ ] **Step 1: Update the cookie test first**

In `server/request-security.test.mjs`, update the existing `buildAuthCookie` assertion so it expects `SameSite=Strict`:

```js
test('buildAuthCookie sets browser security attributes', () => {
  const cookie = buildAuthCookie('abc', { secure: true, maxAgeSeconds: 60 });
  assert.match(cookie, /codexmobile_token=abc/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test server/request-security.test.mjs
```

Expected: FAIL because the cookie currently contains `SameSite=Lax`.

- [ ] **Step 3: Change the cookie attribute**

In `server/request-security.js`, replace:

```js
'SameSite=Lax'
```

with:

```js
'SameSite=Strict'
```

- [ ] **Step 4: Add optional protected GET fetch-site defense**

In `server/request-security.js`, replace `rejectSuspiciousFetchSite` with:

```js
export function rejectSuspiciousFetchSite(req, { protectSafeMethod = false } = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method) && !protectSafeMethod) {
    return null;
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') {
    return null;
  }
  return { statusCode: 403, error: 'Cross-site request rejected' };
}
```

Then in `server/index.js`, replace:

```js
const fetchSiteRejection = rejectSuspiciousFetchSite(req);
```

with:

```js
const fetchSiteRejection = rejectSuspiciousFetchSite(req, {
  protectSafeMethod: url.pathname.startsWith('/api/')
});
```

This keeps normal top-level SPA/static navigation working while rejecting cross-site GET probes against API endpoints when browsers send `Sec-Fetch-Site: cross-site`.

- [ ] **Step 5: Add the protected GET test**

Append this test to `server/request-security.test.mjs`:

```js
test('rejectSuspiciousFetchSite can protect API GET requests', () => {
  const allowed = rejectSuspiciousFetchSite({
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' }
  }, { protectSafeMethod: true });
  assert.equal(allowed, null);

  const rejected = rejectSuspiciousFetchSite({
    method: 'GET',
    headers: { 'sec-fetch-site': 'cross-site' }
  }, { protectSafeMethod: true });
  assert.deepEqual(rejected, { statusCode: 403, error: 'Cross-site request rejected' });
});
```

- [ ] **Step 6: Run the security request tests**

Run:

```powershell
node --test server/request-security.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add server/request-security.js server/request-security.test.mjs server/index.js
git commit -m "fix: use strict same-site auth cookies"
```

---

### Task 3: Bind HTTP to Loopback in Public HTTPS Mode (H1)

**Files:**
- Modify: `server/index.js`
- Modify: `server/server-options.js`
- Create: `server/server-options.test.mjs`

- [ ] **Step 1: Add the bind decision test**

Create `server/server-options.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHttpListenHost } from './server-options.js';

test('resolveHttpListenHost binds public-mode HTTP to loopback only after HTTPS starts', () => {
  assert.equal(resolveHttpListenHost({
    publicAccess: true,
    httpsStarted: true,
    host: '0.0.0.0'
  }), '127.0.0.1');

  assert.equal(resolveHttpListenHost({
    publicAccess: true,
    httpsStarted: false,
    host: '0.0.0.0'
  }), '0.0.0.0');

  assert.equal(resolveHttpListenHost({
    publicAccess: false,
    httpsStarted: true,
    host: '0.0.0.0'
  }), '0.0.0.0');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test server/server-options.test.mjs
```

Expected: FAIL because `resolveHttpListenHost` is not exported yet.

- [ ] **Step 3: Add the pure bind helper**

In `server/server-options.js`, add this before `serverOptionsHelp`:

```js
export function resolveHttpListenHost({ publicAccess = false, httpsStarted = false, host = '0.0.0.0' } = {}) {
  return publicAccess && httpsStarted ? '127.0.0.1' : host;
}
```

- [ ] **Step 4: Add a listen promise helper**

In `server/index.js`, add this function before `main()`:

```js
function listen(serverToStart, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      serverToStart.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      serverToStart.off('error', onError);
      resolve();
    };
    serverToStart.once('error', onError);
    serverToStart.once('listening', onListening);
    serverToStart.listen(port, host);
  });
}
```

- [ ] **Step 5: Start HTTPS before deciding HTTP bind address**

Add `resolveHttpListenHost` to the `server/server-options.js` import list in `server/index.js`:

```js
import { readServerOptions, resolveHttpListenHost, serverOptionsHelp } from './server-options.js';
```

In `main()`, replace the current `server.listen(...)` block and HTTPS `try/catch` block with:

```js
  let httpsStarted = false;

  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    const httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    await listen(httpsServer, HTTPS_PORT, HOST);
    httpsStarted = true;
    console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
    if (PUBLIC_URL) {
      console.log(`Public/private URL: ${PUBLIC_URL}`);
    } else {
      console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
  }

  const httpHost = resolveHttpListenHost({
    publicAccess: securityOptions.publicAccess,
    httpsStarted,
    host: HOST
  });
  await listen(server, PORT, httpHost);
  console.log(`CodexMobile listening on http://${httpHost}:${PORT}`);
  console.log(`Pairing: open CodexMobile from the same LAN, then click "请求配对码" to print a one-time console code (${auth.trustedDevices} trusted device(s)).`);
  console.log(`Use Tailscale and open http://<this-pc-tailscale-ip>:${PORT} on iPhone.`);
```

The important implementation detail is that `httpsStarted` is set only after `await listen(...)` resolves. Setting it inside an async `listen` callback and then immediately deciding the HTTP host would race.

- [ ] **Step 6: Run tests**

Run:

```powershell
node --check server/index.js
node --test server/server-options.test.mjs
```

Expected: syntax check passes; bind decision tests pass.

- [ ] **Step 7: Manual acceptance check**

With a valid `HTTPS_PFX_PATH`:

```powershell
$env:CODEXMOBILE_PUBLIC_ACCESS='1'
npm start -- --host 0.0.0.0 --port 3321 --https-port 3443
curl.exe http://127.0.0.1:3321/api/status
```

Expected: local curl works. From another machine or public port scan, TCP/3321 is not reachable because HTTP is bound to `127.0.0.1`.

- [ ] **Step 8: Commit**

Run:

```powershell
git add server/index.js server/server-options.js server/server-options.test.mjs
git commit -m "fix: bind public-mode http to loopback"
```

---

## Phase B: Same-Batch Small Fixes

### Task 4: Rename start-all.ps1 Host Parameter (H3)

**Files:**
- Modify: `scripts/start-all.ps1`

- [ ] **Step 1: Rename the parameter**

In `scripts/start-all.ps1`, replace:

```powershell
[string]$Host
```

with:

```powershell
[string]$BindHost
```

- [ ] **Step 2: Update all references**

Replace:

```powershell
if ($Host) {
  $serverArgs += '--host'
  $serverArgs += $Host
}
```

with:

```powershell
if ($BindHost) {
  $serverArgs += '--host'
  $serverArgs += $BindHost
}
```

- [ ] **Step 3: Syntax-check the script**

Run:

```powershell
powershell.exe -NoProfile -Command "$null = [scriptblock]::Create((Get-Content -LiteralPath 'scripts/start-all.ps1' -Encoding UTF8 -Raw)); 'ok'"
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

Run:

```powershell
git add scripts/start-all.ps1
git commit -m "fix: avoid powershell host parameter collision"
```

---

### Task 5: Mark localStorage Token Cleanup as Legacy (L3)

**Files:**
- Modify: `client/src/api.js`

- [ ] **Step 1: Confirm current references**

Run:

```powershell
rg --encoding utf-8 -n 'clearToken|TOKEN_KEY|codexmobile.deviceToken' client
```

Expected: `clearToken` is still imported and called from `client/src/App.jsx`, so keep the cleanup helper.

- [ ] **Step 2: Rename the constant and add a migration comment**

In `client/src/api.js`, replace:

```js
const TOKEN_KEY = 'codexmobile.deviceToken';

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
```

with:

```js
const LEGACY_TOKEN_KEY = 'codexmobile.deviceToken';

export function clearToken() {
  // Clear old pre-cookie localStorage auth state left by previous builds.
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}
```

- [ ] **Step 3: Run client build**

Run:

```powershell
npm.cmd run build
```

Expected: Vite build succeeds.

- [ ] **Step 4: Commit**

Run:

```powershell
git add client/src/api.js client/dist
git commit -m "chore: mark legacy token cleanup"
```

---

### Task 6: Keep Pairing Code Out of File-Style Logs (M4)

**Files:**
- Modify: `server/auth.js`
- Modify: `server/auth.test.mjs`

- [ ] **Step 1: Add the logger regression test**

Append this test to `server/auth.test.mjs`:

```js
test('default pairing logger writes full code only to stdout', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-log-'));
  const stdoutWrites = [];
  const consoleLogs = [];
  const originalStdoutWrite = process.stdout.write;
  const originalConsoleLog = console.log;

  process.stdout.write = function patchedStdoutWrite(chunk, encoding, callback) {
    stdoutWrites.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  };
  console.log = (...args) => {
    consoleLogs.push(args.map(String).join(' '));
  };

  try {
    const auth = createAuthController({ dataDir });
    await auth.initializeAuth();
    const result = await auth.startPairingRequest({
      deviceName: 'iPhone / WeChat',
      userAgent: 'WeChat',
      remoteAddress: '192.168.1.23',
      securityOptions: readSecurityOptions()
    });

    assert.equal(result.ok, true);
    assert.ok(stdoutWrites.some((line) => line.includes(`code=${result.code}`)));
    assert.equal(consoleLogs.some((line) => line.includes(result.code)), false);
    assert.ok(consoleLogs.some((line) => line.includes(`request=${result.requestId}`)));
  } finally {
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test server/auth.test.mjs
```

Expected: FAIL because the default logger currently writes the full pairing code through `console.log`.

- [ ] **Step 3: Split the default logger**

In `server/auth.js`, replace the `logPairingCode` default in `createAuthController`:

```js
logPairingCode = (entry) => console.log(`[pairing] request=${entry.requestId} device=${entry.deviceName} remote=${entry.remoteAddress} code=${entry.code} expiresAt=${entry.expiresAt}`)
```

with:

```js
logPairingCode = (entry) => {
  process.stdout.write(`[pairing] code=${entry.code}\n`);
  console.log(`[pairing] request=${entry.requestId} device=${entry.deviceName} remote=${entry.remoteAddress} expiresAt=${entry.expiresAt}`);
}
```

- [ ] **Step 4: Run auth tests**

Run:

```powershell
node --test server/auth.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add server/auth.js server/auth.test.mjs
git commit -m "fix: keep pairing codes out of structured logs"
```

---

## Phase C: Follow-Up PR Tasks

### Task 7: Avoid Token Rotation Stampedes (M1)

**Files:**
- Modify: `server/auth.js`
- Modify: `server/auth.test.mjs`

- [ ] **Step 1: Add a rotation reuse test**

Append this test to `server/auth.test.mjs`:

```js
test('verifyToken reuses a very recent replacement token instead of rotating twice', async () => {
  const t = await tempAuth();
  const paired = await t.auth.completePairingRequest(await (async () => {
    const requested = await t.auth.startPairingRequest({
      deviceName: 'iPhone / WeChat',
      userAgent: 'WeChat',
      remoteAddress: '192.168.1.23',
      securityOptions: t.security()
    });
    return {
      requestId: requested.requestId,
      code: requested.code,
      remoteAddress: '192.168.1.23',
      securityOptions: t.security()
    };
  })());

  t.advance(46 * 24 * 60 * 60 * 1000);
  const first = await t.auth.verifyToken(paired.token, {
    remoteAddress: '192.168.1.23',
    userAgent: 'WeChat',
    securityOptions: t.security()
  });
  const second = await t.auth.verifyToken(paired.token, {
    remoteAddress: '192.168.1.23',
    userAgent: 'WeChat',
    securityOptions: t.security()
  });

  assert.equal(first.ok, true);
  assert.ok(first.replacementToken);
  assert.equal(second.ok, true);
  assert.equal(second.replacementToken, null);
  assert.equal(second.tokenHash, first.tokenHash);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test server/auth.test.mjs
```

Expected: FAIL because the second old-token verification currently returns the old token hash or rotates independently.

- [ ] **Step 3: Add recent replacement reuse**

In `server/auth.js`, inside `verifyToken`, immediately before the current rotation `if`, add:

```js
      const recentReplacement = deviceTokenRecords(device).find((record) => {
        if (record.hash === tokenHash || record.supersededAt) {
          return false;
        }
        const replacementCreatedMs = Date.parse(record.createdAt || '');
        return Number.isFinite(replacementCreatedMs) && nowMs - replacementCreatedMs < 1000;
      });
      if (rotate && tokenRecord.supersededAt && recentReplacement) {
        activeTokenHash = recentReplacement.hash;
      }
```

Then change the rotation condition from:

```js
if (rotate && !tokenRecord.supersededAt && ageMs > securityOptions.tokenTtlMs / 2) {
```

to:

```js
if (rotate && !recentReplacement && !tokenRecord.supersededAt && ageMs > securityOptions.tokenTtlMs / 2) {
```

- [ ] **Step 4: Run auth tests**

Run:

```powershell
node --test server/auth.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add server/auth.js server/auth.test.mjs
git commit -m "fix: avoid duplicate token rotation"
```

---

### Task 8: Normalize Uploaded MIME by Magic Bytes (M3)

**Files:**
- Modify: `server/upload-service.js`
- Modify: `server/upload-service.test.mjs`

- [ ] **Step 1: Add MIME mismatch tests**

Append this test to `server/upload-service.test.mjs`:

```js
test('parseMultipartFile downgrades mismatched file mime type', () => {
  const boundary = 'codex-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('content-disposition: form-data; name="file"; filename="fake.png"\r\n'),
    Buffer.from('content-type: image/png\r\n\r\n'),
    Buffer.from('%PDF-1.7\n'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const file = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(file.mimeType, 'application/octet-stream');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test server/upload-service.test.mjs
```

Expected: FAIL because the declared MIME type is currently trusted.

- [ ] **Step 3: Add minimal sniffing helpers**

In `server/upload-service.js`, add these functions after `classifyUpload`:

```js
export function sniffMimeType(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF') {
    return 'application/pdf';
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'video/mp4';
  }
  return '';
}

export function normalizeUploadMimeType(declaredMimeType, data) {
  const declared = String(declaredMimeType || 'application/octet-stream').toLowerCase();
  const sniffed = sniffMimeType(data);
  if (!sniffed || declared === sniffed) {
    return declared;
  }
  return 'application/octet-stream';
}
```

- [ ] **Step 4: Use the normalized MIME**

In `parseMultipartFile`, replace:

```js
return {
  fileName: sanitizeFileName(fileName),
  mimeType,
  data: buffer.slice(headerEnd + 4, contentEnd)
};
```

with:

```js
const data = buffer.slice(headerEnd + 4, contentEnd);
return {
  fileName: sanitizeFileName(fileName),
  mimeType: normalizeUploadMimeType(mimeType, data),
  data
};
```

- [ ] **Step 5: Run upload tests**

Run:

```powershell
node --test server/upload-service.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add server/upload-service.js server/upload-service.test.mjs
git commit -m "fix: normalize uploaded file mime types"
```

---

### Task 9: Make Auth State Writes Atomic (L2)

**Files:**
- Modify: `server/auth.js`
- Modify: `server/auth.test.mjs`

- [ ] **Step 1: Add a state write assertion**

Append this test to `server/auth.test.mjs`:

```js
test('auth state writes leave a valid json state file', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-atomic-'));
  const auth = createAuthController({ dataDir });
  await auth.initializeAuth();
  const files = await fs.readdir(dataDir);
  assert.ok(files.includes('auth-state.json'));
  assert.equal(files.includes('auth-state.json.tmp'), false);
  const parsed = JSON.parse(await fs.readFile(path.join(dataDir, 'auth-state.json'), 'utf8'));
  assert.deepEqual(parsed, { devices: [] });
});
```

- [ ] **Step 2: Implement atomic rename**

In `server/auth.js`, replace `writeState()` with:

```js
  async function writeState() {
    await ensurePrivateStatePath(dataDir);
    const tmpFile = `${stateFile}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(authState, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      await fs.chmod(tmpFile, 0o600).catch(() => {});
    }
    await fs.rename(tmpFile, stateFile);
    if (process.platform !== 'win32') {
      await fs.chmod(stateFile, 0o600).catch(() => {});
    }
  }
```

- [ ] **Step 3: Run auth tests**

Run:

```powershell
node --test server/auth.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```powershell
git add server/auth.js server/auth.test.mjs
git commit -m "fix: write auth state atomically"
```

---

### Task 10: Add End-to-End G1/G2 Contract Test

**Files:**
- Modify: `server/integration.test.mjs`

- [ ] **Step 1: Add WebSocket dependency imports**

At the top of `server/integration.test.mjs`, add:

```js
import WebSocket from 'ws';
```

- [ ] **Step 2: Add JSON helper and pairing-code waiter**

Append these helpers:

```js
async function jsonRequest({ port, method = 'GET', path: requestPath, headers = {}, body = {} }) {
  const payload = JSON.stringify(body);
  const response = await httpRequest({
    port,
    method,
    path: requestPath,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: payload
  });
  return {
    ...response,
    json: response.body ? JSON.parse(response.body) : {}
  };
}

async function waitForPairingCode(stdout) {
  const line = await waitForOutput(stdout, /\[pairing\] code=/);
  return line.match(/code=([A-Z2-9]+)/)?.[1] || '';
}
```

- [ ] **Step 3: Add the WebSocket revoke test**

Append this test:

```js
test('websocket uses cookie auth and closes after current device revoke', async (t) => {
  const { port, stdout } = await startServer(t);
  const origin = `http://127.0.0.1:${port}`;

  const requested = await jsonRequest({
    port,
    method: 'POST',
    path: '/api/pair/request',
    headers: { origin },
    body: { deviceName: 'iPhone / WeChat' }
  });
  assert.equal(requested.statusCode, 200);

  const code = await waitForPairingCode(stdout);
  assert.match(code, /^[A-Z2-9]+$/);

  const paired = await jsonRequest({
    port,
    method: 'POST',
    path: '/api/pair',
    headers: { origin },
    body: { requestId: requested.json.requestId, code }
  });
  assert.equal(paired.statusCode, 200);
  const cookie = paired.headers['set-cookie']?.[0] || '';
  assert.match(cookie, /codexmobile_token=/);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { cookie, origin }
  });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const devices = await jsonRequest({
    port,
    method: 'GET',
    path: '/api/devices',
    headers: { cookie }
  });
  const current = devices.json.devices.find((device) => device.current);
  assert.ok(current);

  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket was not closed after revoke')), 1000);
    ws.once('close', (codeValue, reason) => {
      clearTimeout(timer);
      resolve({ code: codeValue, reason: reason.toString() });
    });
  });

  const revoked = await jsonRequest({
    port,
    method: 'POST',
    path: `/api/devices/${encodeURIComponent(current.id)}/revoke`,
    headers: { cookie, origin },
    body: {}
  });
  assert.equal(revoked.statusCode, 200);

  const close = await closed;
  assert.equal(close.code, 1008);
  assert.equal(close.reason, 'revoked');
});
```

- [ ] **Step 4: Run integration tests**

Run:

```powershell
node --test server/integration.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add server/integration.test.mjs
git commit -m "test: cover websocket auth revocation"
```

---

## Final Verification

- [ ] **Run full tests**

```powershell
node --test
```

Expected: all tests pass. If sandbox blocks writes under `D:\tmp`, rerun externally because `server/chat-service.test.mjs` creates projectless temporary directories there.

- [ ] **Run production build**

```powershell
npm.cmd run build
```

Expected: Vite build succeeds and updates `client/dist`.

- [ ] **Scan bundle for accidental secrets**

```powershell
rg --encoding utf-8 -n -i 'sk-[a-z0-9_-]{16,}|api[_-]?key|secret[_-]?(key|token|value)' client/dist
```

Expected: exit code 1 with no matches.

- [ ] **Scan for removed token-in-URL patterns**

```powershell
rg --encoding utf-8 -n '\?token=|ws\?token|extractBearerToken|x-codexmobile-token' server client README.md .env.example
```

Expected: exit code 1 with no matches.

- [ ] **Manual cookie check**

Start the app, pair a device, and inspect the `/api/pair` response in DevTools.

Expected: `Set-Cookie` contains `HttpOnly; SameSite=Strict`; on HTTPS it also contains `Secure`.

- [ ] **Manual public-mode bind check**

With a valid HTTPS PFX:

```powershell
$env:CODEXMOBILE_PUBLIC_ACCESS='1'
npm start -- --host 0.0.0.0 --port 3321 --https-port 3443
curl.exe http://127.0.0.1:3321/api/status
```

Expected: local HTTP status works. Public/router scan for TCP/3321 does not show an open listener.

---

## Self-Review Notes

- Spec coverage: C1 is covered by Task 1; C2 by Task 2; H1 by Task 3; H3 by Task 4; L3 by Task 5; M4 by Task 6; M1/M3/L2/G1+G2 follow-up items by Tasks 7-10.
- Scope split: Tasks 1-6 are the merge-before-main batch. Tasks 7-10 are intentionally grouped as follow-up PR work.
- Type consistency: new helper names are `withLocalAllowedOrigins`, `listen`, `rejectSuspiciousFetchSite(req, { protectSafeMethod })`, `LEGACY_TOKEN_KEY`, `sniffMimeType`, and `normalizeUploadMimeType`.
