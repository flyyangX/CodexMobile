# CodexMobile Public Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden CodexMobile for a real public-router-port-forward deployment while preserving the product shape: a mobile React shell around local Codex, with first device binding allowed only from the LAN.

**Architecture:** CodexMobile is not an iframe around an official Codex page. It is a self-written React PWA in `client/src/App.jsx` served by `server/static-service.js`, backed by Node API routes and WebSocket upgrades in `server/index.js`, Codex session readers in `server/codex-data.js`, Desktop IPC/background execution in `server/chat-service.js` and `server/codex-runner.js`. The hardening adds explicit public-access policy, trusted-proxy CIDR handling, LAN-only client-initiated console-code pairing, cookie-only WebSocket authentication, active socket revocation, authenticated device management, server-side permission enforcement, upload/session/local-image access boundaries, and deployment smoke checks.

**Tech Stack:** Node.js ESM HTTP/HTTPS server, React 18 + Vite PWA, Node built-in test runner, local JSON state under `.codexmobile/state`.

---

## Product And Security Constraints

- Deployment target: local Windows machine, exposed through a public router port forward.
- Primary remote client: WeChat built-in browser opening the public URL.
- Default unauthenticated behavior: show only an authorization/binding gate; do not expose projects, sessions, active run ids, local file paths, or high-risk capability flags beyond coarse safe status.
- Binding behavior: unauthenticated client starts a binding request; if and only if the request comes from LAN/private IP, the server prints a short-lived high-entropy code to the local console; the user reads the console code and types it on the phone.
- Computer-side interaction: no local Web UI confirmation button is required. Physical console visibility is the local-presence check.
- Public binding: disabled by default. `CODEXMOBILE_ALLOW_REMOTE_PAIRING=1` is an explicit emergency override and still keeps rate limits and short TTL.
- Public transport: non-private remote access must use HTTPS directly or a trusted HTTPS reverse proxy.
- Trusted proxy handling: never blindly trust `X-Forwarded-*`; only accept forwarded headers when `req.socket.remoteAddress` is in `CODEXMOBILE_TRUSTED_PROXIES`.
- WebSocket posture: use HttpOnly cookie auth for `/ws` and `/ws/realtime`, reject cross-origin upgrades, and actively close already-open sockets when a device is revoked or logs out.
- Codex shell: after authentication, default route remains the existing CodexMobile shell. Device management is a lightweight `/security` authenticated view or shield-panel entry, not a new product home page.
- Dangerous execution: client requests must never be able to enable `danger-full-access`; server env must opt in with `CODEXMOBILE_ENABLE_DANGER_FULL_ACCESS=1`.
- Unauthenticated status: response fields must be an explicit whitelist; do not expose model names, projects, cwd, sessions, desktop bridge details, active run identifiers, or local paths.
- State storage: `.codexmobile/state` must be owner-only where the platform supports it, and must not be placed in OneDrive/Dropbox/sync directories.
- Existing uncommitted port-argument work must be preserved.
- No PRD file was found; update `README.md` and `.env.example`.

## Interaction Model

```text
Unauthenticated public/WAN device
  -> PairingGate: "首次绑定必须在同一局域网完成"
  -> no /api/pair/request is created

Unauthenticated LAN device
  -> PairingGate waits for the user to click "请求配对码"
  -> PairingGate then calls POST /api/pair/request
  -> server prints console code once
  -> phone enters code
  -> POST /api/pair completes binding
  -> HttpOnly auth cookie is set
  -> enters existing Codex shell

Authenticated device
  -> / opens existing Codex shell
  -> shield icon or /security opens a minimal security panel
  -> user can view/revoke devices or logout current device
```

## File Structure

- Create `server/security-options.js`: env parsing, LAN/private IP and private CIDR detection, trusted proxy CIDR handling, origin/public URL policy, HTTPS/public access checks.
- Create `server/security-options.test.mjs`: policy parsing, private IP/CGNAT/private CIDR, trusted proxy spoofing, origin, and transport tests.
- Create `server/request-security.js`: HSTS/CSP/security headers, cookie helpers, Origin/Sec-Fetch guard, auth cookie extraction helpers.
- Create `server/request-security.test.mjs`: cookie/header/origin tests.
- Modify `server/auth.js`: refactor into an injectable auth controller while keeping existing exported functions; add pending pairing requests, console-code generation, LAN-only binding, IP-level request rate limits, constant-time code comparison, token expiry/rotation, active WebSocket registry, device revoke/list, owner-only state writes.
- Create `server/auth.test.mjs`: pairing request, code completion, expiry, rate limit, token verify, revoke tests.
- Modify `server/index.js`: use security options, reject unsafe public HTTP, reduce public-mode HTTP listener exposure, add `/api/pair/request`, update `/api/pair`, add `/api/devices`, add `/api/logout`, add `/api/security/posture`, redact unauthenticated status by whitelist, store authenticated device on request, harden WebSocket upgrade.
- Create `client/src/pairing-flow.js`: pure helpers for pairing UI state and code normalization.
- Create `client/src/pairing-flow.test.mjs`: UI-state and code-normalization tests.
- Modify `client/src/App.jsx`: upgrade existing `PairingScreen`, add LAN/public unauthenticated states, add `/security` authenticated view and shield entry.
- Create `client/src/security-panel.js`: pure helpers for security panel route and device formatting.
- Create `client/src/security-panel.test.mjs`: route/format tests.
- Modify `client/src/api.js`: prefer HttpOnly cookie auth; keep localStorage bearer only as legacy fallback; add `credentials: 'same-origin'`.
- Create `server/permission-policy.js`: server-approved permission mapping.
- Create `server/permission-policy.test.mjs`: downgrade and opt-in tests.
- Modify `server/codex-runner.js`: use server-side permission policy for background Codex.
- Modify `server/chat-service.js`: default permissions to safe mode; use server-side policy for Desktop IPC/background paths; resolve attachments through whitelist.
- Modify `server/upload-service.js`: resolve and validate uploaded attachment references.
- Modify `server/upload-service.test.mjs`: reject arbitrary local paths and accept saved uploads only.
- Create `server/session-access.js`: readable-session and public-active-run helpers.
- Create `server/session-access.test.mjs`: hidden session and status-redaction tests.
- Create `server/status-policy.js`: explicit unauthenticated `/api/status` whitelist.
- Create `server/status-policy.test.mjs`: public status field-set tests.
- Modify `server/static-service.js`: restrict `/api/local-image` to approved generated/upload image roots.
- Modify `server/static-service.test.mjs`: reject arbitrary absolute images; accept generated/upload images.
- Modify `scripts/start-asr.mjs`: default Docker publish host to `127.0.0.1`.
- Create `scripts/start-asr.test.mjs`: Docker publish helper tests.
- Modify `scripts/smoke.mjs`: print security posture and fail unsafe public HTTP.
- Add bundle secret scan to verification: scan `client/dist` for obvious API key patterns after build.
- Modify `.env.example`: document public security env vars.
- Modify `README.md`: add public port-forward deployment and LAN-only binding checklist.

---

## Task 1: Security Options And Public Access Policy

**Files:**
- Create: `server/security-options.js`
- Create: `server/security-options.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `server/security-options.test.mjs`:

```js
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
  assert.deepEqual(options.trustedProxyCidrs, []);
  assert.equal(options.pairingCodeLength, 10);
  assert.equal(options.pairingCodeTtlMs, 600000);
  assert.deepEqual(options.allowedOrigins, []);
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
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
node --test server/security-options.test.mjs
```

Expected: fails because `server/security-options.js` does not exist.

- [ ] **Step 3: Implement `server/security-options.js`**

Create the module with this public contract:

```js
import net from 'node:net';

export function envFlag(env, key) {
  return ['1', 'true', 'yes', 'on'].includes(String(env[key] || '').trim().toLowerCase());
}

export function readIntEnv(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function normalizeRemoteAddress(value) {
  const raw = String(value || '').trim();
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function ipv4ToNumber(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function cidrMatches(address, cidr) {
  const [base, prefixText] = String(cidr || '').split('/');
  const prefix = Number(prefixText);
  const addressNumber = ipv4ToNumber(normalizeRemoteAddress(address));
  const baseNumber = ipv4ToNumber(normalizeRemoteAddress(base));
  if (addressNumber === null || baseNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (baseNumber & mask);
}

export function addressInCidrs(address, cidrs = []) {
  return cidrs.some((cidr) => cidrMatches(address, cidr));
}

export function isPrivateRemoteAddress(value, options = {}) {
  const address = normalizeRemoteAddress(value);
  const lower = address.toLowerCase();
  if (addressInCidrs(address, options.privateCidrs || [])) return true;
  if (address === 'localhost' || address === '127.0.0.1' || address === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

export function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

export function readSecurityOptions(env = process.env) {
  const publicUrl = String(env.CODEXMOBILE_PUBLIC_URL || '').trim();
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : '';
  const allowedOrigins = [...new Set([publicOrigin, ...parseOrigins(env.CODEXMOBILE_ALLOWED_ORIGINS)].filter(Boolean))];
  return {
    publicAccess: envFlag(env, 'CODEXMOBILE_PUBLIC_ACCESS'),
    publicUrl,
    publicOrigin,
    allowedOrigins,
    trustedProxyCidrs: String(env.CODEXMOBILE_TRUSTED_PROXIES || '').split(',').map((item) => item.trim()).filter(Boolean),
    privateCidrs: String(env.CODEXMOBILE_PRIVATE_CIDRS || '').split(',').map((item) => item.trim()).filter(Boolean),
    allowRemotePairing: envFlag(env, 'CODEXMOBILE_ALLOW_REMOTE_PAIRING'),
    dangerFullAccessEnabled: envFlag(env, 'CODEXMOBILE_ENABLE_DANGER_FULL_ACCESS'),
    pairingCodeLength: readIntEnv(env, 'CODEXMOBILE_PAIRING_CODE_LENGTH', 10),
    pairingCodeTtlMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_CODE_TTL_MS', 10 * 60 * 1000),
    pairingMaxFailures: readIntEnv(env, 'CODEXMOBILE_PAIRING_MAX_FAILURES', 5),
    pairingWindowMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_WINDOW_MS', 10 * 60 * 1000),
    pairingLockMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_LOCK_MS', 15 * 60 * 1000),
    tokenTtlMs: readIntEnv(env, 'CODEXMOBILE_TOKEN_TTL_MS', 90 * 24 * 60 * 60 * 1000)
  };
}

export function sameOriginAllowed(origin, options) {
  const value = String(origin || '').trim();
  return !value || options.allowedOrigins.includes(value);
}

export function clientRemoteAddress(req, options) {
  if (isTrustedProxy(req.socket?.remoteAddress || '', options)) {
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwardedFor) return normalizeRemoteAddress(forwardedFor);
  }
  return normalizeRemoteAddress(req.socket?.remoteAddress || '');
}

export function isTrustedProxy(address, options) {
  const normalized = normalizeRemoteAddress(address);
  return options.trustedProxyCidrs?.some((cidr) => {
    if (!cidr.includes('/')) return normalizeRemoteAddress(cidr) === normalized;
    return cidrMatches(normalized, cidr);
  }) || false;
}

export function isRequestTransportSecure(req, options) {
  if (req.socket?.encrypted) return true;
  if (!isTrustedProxy(req.socket?.remoteAddress || '', options)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

export function requestMayUsePublicHttp(req, options) {
  const remote = clientRemoteAddress(req, options);
  return !options.publicAccess || isPrivateRemoteAddress(remote, options) || isRequestTransportSecure(req, options);
}
```

- [ ] **Step 4: Verify**

Run:

```powershell
node --test server/security-options.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add server/security-options.js server/security-options.test.mjs
git commit -m "security: add public access policy options"
```

---

## Task 2: Request Security, Cookies, And Origin Guard

**Files:**
- Create: `server/request-security.js`
- Create: `server/request-security.test.mjs`
- Modify: `server/index.js`

- [ ] **Step 1: Write request-security tests**

Create `server/request-security.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAuthCookie,
  clearAuthCookie,
  extractCookieToken,
  parseCookies,
  rejectSuspiciousFetchSite,
  rejectUnsafeOrigin,
  setSecurityHeaders
} from './request-security.js';

test('parseCookies parses multiple cookies', () => {
  assert.deepEqual(parseCookies('a=1; codexmobile_token=abc.def; theme=dark'), {
    a: '1',
    codexmobile_token: 'abc.def',
    theme: 'dark'
  });
});

test('buildAuthCookie sets browser security attributes', () => {
  const cookie = buildAuthCookie('token-value', { secure: true, maxAgeSeconds: 60 });
  assert.match(cookie, /codexmobile_token=token-value/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=60/);
});

test('clearAuthCookie expires the cookie', () => {
  assert.match(clearAuthCookie({ secure: false }), /Max-Age=0/);
});

test('extractCookieToken reads the auth cookie only', () => {
  assert.equal(extractCookieToken({ headers: { cookie: 'x=1; codexmobile_token=abc' } }), 'abc');
});

test('rejectUnsafeOrigin rejects cross-origin state changes', () => {
  const result = rejectUnsafeOrigin({
    method: 'POST',
    headers: { origin: 'https://evil.example.com' }
  }, {
    allowedOrigins: ['https://codex.example.com']
  });
  assert.equal(result.statusCode, 403);
});

test('rejectSuspiciousFetchSite blocks cross-site state changes', () => {
  const result = rejectSuspiciousFetchSite({
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(result.statusCode, 403);
});

test('setSecurityHeaders sets CSP and HSTS on secure requests', () => {
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key.toLowerCase()] = value; } };
  setSecurityHeaders(res, { secure: true, cspReportOnly: false });
  assert.match(headers['strict-transport-security'], /max-age=15552000/);
  assert.match(headers['content-security-policy'], /default-src 'self'/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('setSecurityHeaders can run CSP in report-only mode', () => {
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key.toLowerCase()] = value; } };
  setSecurityHeaders(res, { secure: false, cspReportOnly: true });
  assert.equal(headers['strict-transport-security'], undefined);
  assert.match(headers['content-security-policy-report-only'], /default-src 'self'/);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
node --test server/request-security.test.mjs
```

Expected: fails because `server/request-security.js` does not exist.

- [ ] **Step 3: Implement `server/request-security.js`**

Create:

```js
const AUTH_COOKIE = 'codexmobile_token';

export function parseCookies(header = '') {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export function extractCookieToken(req) {
  return parseCookies(req.headers?.cookie || '')[AUTH_COOKIE] || '';
}

export function buildAuthCookie(token, { secure = false, maxAgeSeconds } = {}) {
  const parts = [`${AUTH_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join('; ');
}

export function clearAuthCookie({ secure = false } = {}) {
  return buildAuthCookie('', { secure, maxAgeSeconds: 0 });
}

export function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https: wss:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
}

export function setSecurityHeaders(res, { secure = false, cspReportOnly = false } = {}) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(cspReportOnly ? 'content-security-policy-report-only' : 'content-security-policy', contentSecurityPolicy());
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(self)');
  if (secure) {
    res.setHeader('strict-transport-security', 'max-age=15552000; includeSubDomains');
  }
}

export function rejectUnsafeOrigin(req, options) {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const origin = String(req.headers.origin || '').trim();
  if (!origin || options.allowedOrigins.includes(origin)) return null;
  return { statusCode: 403, error: 'Cross-origin request rejected' };
}

export function rejectSuspiciousFetchSite(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none') return null;
  return { statusCode: 403, error: 'Cross-site request rejected' };
}
```

- [ ] **Step 4: Wire it into `server/index.js`**

At the start of the request handler:

```js
setSecurityHeaders(res, {
  secure: isRequestTransportSecure(req, securityOptions),
  cspReportOnly: process.env.CODEXMOBILE_CSP_REPORT_ONLY === '1'
});
if (!requestMayUsePublicHttp(req, securityOptions)) {
  sendJson(res, 403, { error: 'Public access requires HTTPS' });
  return;
}
const fetchSiteRejection = rejectSuspiciousFetchSite(req);
if (fetchSiteRejection) {
  sendJson(res, fetchSiteRejection.statusCode, { error: fetchSiteRejection.error });
  return;
}
const originRejection = rejectUnsafeOrigin(req, securityOptions);
if (originRejection) {
  sendJson(res, originRejection.statusCode, { error: originRejection.error });
  return;
}
```

Update token extraction so cookies are preferred and the old bearer header remains a migration fallback:

```js
function requestToken(req) {
  return extractCookieToken(req) || extractBearerToken(req);
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
node --test server/request-security.test.mjs
node --check server/index.js
```

Expected: tests and syntax check pass.

- [ ] **Step 6: Commit**

```powershell
git add server/request-security.js server/request-security.test.mjs server/index.js
git commit -m "security: add request guards and auth cookies"
```

---

## Task 3: Auth Controller, Pairing Requests, And Device Tokens

**Files:**
- Modify: `server/auth.js`
- Create: `server/auth.test.mjs`

- [ ] **Step 1: Write auth controller tests**

Create `server/auth.test.mjs`:

```js
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
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test server/auth.test.mjs
```

Expected: fails because `createAuthController`, `startPairingRequest`, and related methods do not exist.

- [ ] **Step 3: Refactor `server/auth.js`**

Implement `createAuthController({ dataDir, now, logPairingCode })` and keep existing top-level exports delegating to the default controller:

```js
const DEFAULT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createAuthController({
  dataDir = DATA_DIR,
  now = () => Date.now(),
  logPairingCode = (entry) => console.log(`[pairing] request=${entry.requestId} device=${entry.deviceName} remote=${entry.remoteAddress} code=${entry.code} expiresAt=${entry.expiresAt}`)
} = {}) {
  // Controller owns authState, pendingPairingRequests, request buckets, failure buckets, and active socket registrations.
}
```

Required methods:

```js
initializeAuth()
startPairingRequest({ deviceName, userAgent, remoteAddress, securityOptions })
completePairingRequest({ requestId, code, remoteAddress, securityOptions })
verifyToken(token, { remoteAddress, userAgent, securityOptions })
revokeDevice(deviceId)
revokeToken(token)
registerSocket(tokenHash, socket)
unregisterSocket(tokenHash, socket)
listDevices({ currentToken } = {})
getTrustedDeviceCount()
getPendingPairingRequest(requestId)
```

Required state rules:

- Store device tokens only as SHA-256 hashes.
- Store pending pairing codes only as SHA-256 hashes.
- Compare submitted pairing code hashes with `crypto.timingSafeEqual()`.
- Generate raw codes with `crypto.randomInt()` over `DEFAULT_CODE_ALPHABET`.
- Pending request contains `requestId`, `codeHash`, `deviceName`, `userAgent`, `remoteAddress`, `createdAt`, `expiresAt`, `failedAttempts`.
- `startPairingRequest()` uses `pairingRequestsByRemote: Map<remote, { count, windowStart, lockedUntil }>` before generating or printing a code. Default: at most 5 requests per 10 minutes, lock for 15 minutes.
- Completion requires same normalized remote address as request creation unless `CODEXMOBILE_ALLOW_REMOTE_PAIRING=1`.
- Successful completion deletes the pending request.
- Expired completion deletes the pending request and returns `{ ok: false, statusCode: 410, error: 'Pairing code expired' }`.
- Token devices contain `id`, `name`, `tokenHash`, `createdAt`, `expiresAt`, `revokedAt`, `supersededAt`, `userAgent`, `lastUserAgent`, `lastSeenAt`, `lastRemoteAddress`.
- `verifyToken()` returns `{ ok: true, device, tokenHash, replacementToken: null }` normally.
- If token age is greater than 50% of `tokenTtlMs`, `verifyToken()` creates a replacement token, appends its hash to the same device record, marks the old token hash `supersededAt`, and returns `{ ok: true, device, tokenHash: newHash, replacementToken }`.
- Old superseded token hashes remain accepted for only 5 minutes to avoid breaking concurrent requests, then verify false.
- `revokeDevice()` and `revokeToken()` close active sockets registered for the revoked token hashes with `socket.close(1008, 'revoked')`.
- State directory creation uses owner-only permissions where possible: POSIX `mode: 0o700` for directories and `mode: 0o600` for state files; Windows attempts `icacls <stateDir> /inheritance:r /grant:r <userSid>:(OI)(CI)F` and logs a warning if unavailable.

- [ ] **Step 4: Verify**

Run:

```powershell
node --test server/auth.test.mjs
node --check server/auth.js
```

Expected: tests and syntax check pass.

- [ ] **Step 5: Commit**

```powershell
git add server/auth.js server/auth.test.mjs
git commit -m "security: add lan-only pairing auth controller"
```

---

## Task 4: Pairing API And Binding Page

**Files:**
- Create: `client/src/pairing-flow.js`
- Create: `client/src/pairing-flow.test.mjs`
- Modify: `server/index.js`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Write pairing UI helper tests**

Create `client/src/pairing-flow.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePairingCode,
  pairingGateState,
  secondsUntilExpiry
} from './pairing-flow.js';

test('normalizePairingCode uppercases and removes separators', () => {
  assert.equal(normalizePairingCode(' k7m4-q9 xr2p '), 'K7M4Q9XR2P');
  assert.equal(normalizePairingCode('abc<>123'), 'ABC123');
});

test('pairingGateState blocks non-LAN unauthenticated devices', () => {
  assert.equal(pairingGateState({
    authenticated: false,
    canPair: false,
    pendingRequest: null,
    error: ''
  }), 'remote-blocked');
});

test('pairingGateState shows code entry when LAN request exists', () => {
  assert.equal(pairingGateState({
    authenticated: false,
    canPair: true,
    pendingRequest: { requestId: 'r1', expiresAt: '2026-05-10T00:10:00.000Z' },
    error: ''
  }), 'enter-code');
});

test('secondsUntilExpiry never returns negative values', () => {
  assert.equal(secondsUntilExpiry('2026-05-10T00:00:05.000Z', Date.parse('2026-05-10T00:00:00.000Z')), 5);
  assert.equal(secondsUntilExpiry('2026-05-10T00:00:00.000Z', Date.parse('2026-05-10T00:00:05.000Z')), 0);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test client/src/pairing-flow.test.mjs
```

Expected: fails because `client/src/pairing-flow.js` does not exist.

- [ ] **Step 3: Implement pairing helpers**

Create `client/src/pairing-flow.js`:

```js
export function normalizePairingCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

export function secondsUntilExpiry(expiresAt, nowMs = Date.now()) {
  const expiryMs = Date.parse(expiresAt || '');
  if (!Number.isFinite(expiryMs)) return 0;
  return Math.max(0, Math.ceil((expiryMs - nowMs) / 1000));
}

export function pairingGateState({ authenticated, canPair, pendingRequest, error }) {
  if (authenticated) return 'authenticated';
  if (error) return 'error';
  if (!canPair) return 'remote-blocked';
  if (pendingRequest?.requestId) return 'enter-code';
  return 'requesting';
}
```

- [ ] **Step 4: Add API routes to `server/index.js`**

In unauthenticated route handling, add `POST /api/pair/request` before `requireAuth`:

```js
if (method === 'POST' && pathname === '/api/pair/request') {
  const body = await readBody(req);
  const requested = await startPairingRequest({
    deviceName: body.deviceName || 'iPhone',
    userAgent: req.headers['user-agent'],
    remoteAddress: remoteAddress(req),
    securityOptions
  });
  if (!requested.ok) {
    sendJson(res, requested.statusCode, { error: requested.error, retryAfterSeconds: requested.retryAfterSeconds || null });
    return;
  }
  sendJson(res, 200, {
    requestId: requested.requestId,
    expiresAt: requested.expiresAt,
    codeLength: requested.codeLength
  });
  return;
}
```

Update `POST /api/pair`:

```js
const paired = await completePairingRequest({
  requestId: body.requestId,
  code: body.code,
  remoteAddress: remoteAddress(req),
  securityOptions
});
if (!paired.ok) {
  sendJson(res, paired.statusCode, { error: paired.error, retryAfterSeconds: paired.retryAfterSeconds || null });
  return;
}
res.setHeader('set-cookie', buildAuthCookie(paired.token, {
  secure: isRequestTransportSecure(req, securityOptions),
  maxAgeSeconds: Math.floor(securityOptions.tokenTtlMs / 1000)
}));
sendJson(res, 200, { device: paired.device, token: paired.token });
```

Expose unauthenticated safe pairing status from `/api/status`:

```js
auth: {
  required: true,
  authenticated,
  trustedDevices: authenticated ? getTrustedDeviceCount() : 0,
  canPair: isPrivateRemoteAddress(remoteAddress(req)) || securityOptions.allowRemotePairing
}
```

- [ ] **Step 5: Replace current `PairingScreen` behavior in `client/src/App.jsx`**

Keep `PairingScreen` as the unauthenticated gate. Change it to:

- Load `/api/status` from the parent `bootstrap` as today.
- If `status.auth?.canPair` is false, show:

```text
不能在外网完成绑定
首次绑定必须在电脑所在的同一 Wi-Fi / 局域网内完成。
已绑定设备仍可从外网访问。
```

- If `canPair` is true, show a "请求配对码" button. Only call `/api/pair/request` after the user clicks it:

```js
const result = await apiFetch('/api/pair/request', {
  method: 'POST',
  body: { deviceName: navigator.platform || 'iPhone' }
});
setPendingRequest(result);
```

- Show:

```text
请查看电脑端 CodexMobile 控制台输出的配对码。
设备：iPhone / WeChat
有效期：09:58
控制台配对码
[__________]
```

- Submit:

```js
await apiFetch('/api/pair', {
  method: 'POST',
  body: {
    requestId: pendingRequest.requestId,
    code
  }
});
```

- After success, call `onPaired()` and let the app enter the existing Codex shell.

- [ ] **Step 6: Verify**

Run:

```powershell
node --test client/src/pairing-flow.test.mjs server/auth.test.mjs server/security-options.test.mjs server/request-security.test.mjs
npm.cmd run build
```

Expected: tests pass and the React build succeeds.

- [ ] **Step 7: Commit**

```powershell
git add client/src/pairing-flow.js client/src/pairing-flow.test.mjs server/index.js client/src/App.jsx
git commit -m "security: add console-code binding flow"
```

---

## Task 5: Device Management API And Authenticated Security Panel

**Files:**
- Create: `client/src/security-panel.js`
- Create: `client/src/security-panel.test.mjs`
- Modify: `server/index.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/api.js`

- [ ] **Step 1: Write security panel helper tests**

Create `client/src/security-panel.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDeviceLabel,
  formatLastSeen,
  isSecurityRoute,
  securitySummaryRows
} from './security-panel.js';

test('isSecurityRoute recognizes only the security view', () => {
  assert.equal(isSecurityRoute('/security'), true);
  assert.equal(isSecurityRoute('/security/'), true);
  assert.equal(isSecurityRoute('/'), false);
});

test('formatDeviceLabel prefers stored device name and falls back to user agent', () => {
  assert.equal(formatDeviceLabel({ name: 'iPhone / WeChat', userAgent: 'Mozilla' }), 'iPhone / WeChat');
  assert.equal(formatDeviceLabel({ name: '', userAgent: 'Mobile Safari' }), 'Mobile Safari');
  assert.equal(formatDeviceLabel({}), '未知设备');
});

test('formatLastSeen handles current and old devices', () => {
  assert.equal(formatLastSeen('2026-05-10T00:00:00.000Z', Date.parse('2026-05-10T00:00:30.000Z')), '刚刚');
  assert.equal(formatLastSeen('2026-05-09T00:00:00.000Z', Date.parse('2026-05-10T00:00:00.000Z')), '1 天前');
});

test('securitySummaryRows renders safe status labels', () => {
  assert.deepEqual(securitySummaryRows({
    publicAccess: true,
    pairing: { lanOnly: true },
    dangerFullAccessEnabled: false,
    httpsEnabled: true
  }), [
    ['公网访问', '已启用'],
    ['首次绑定', '仅局域网'],
    ['完全访问', '已关闭'],
    ['HTTPS', '已启用']
  ]);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test client/src/security-panel.test.mjs
```

Expected: fails because `client/src/security-panel.js` does not exist.

- [ ] **Step 3: Implement security panel helpers**

Create `client/src/security-panel.js`:

```js
export function isSecurityRoute(pathname = window.location.pathname) {
  return String(pathname || '').replace(/\/+$/, '') === '/security';
}

export function formatDeviceLabel(device = {}) {
  return String(device.name || device.userAgent || '未知设备').trim() || '未知设备';
}

export function formatLastSeen(value, nowMs = Date.now()) {
  const seenMs = Date.parse(value || '');
  if (!Number.isFinite(seenMs)) return '从未';
  const seconds = Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function securitySummaryRows(security = {}) {
  return [
    ['公网访问', security.publicAccess ? '已启用' : '未启用'],
    ['首次绑定', security.pairing?.lanOnly === false ? '允许远程' : '仅局域网'],
    ['完全访问', security.dangerFullAccessEnabled ? '已启用' : '已关闭'],
    ['HTTPS', security.httpsEnabled ? '已启用' : '未启用']
  ];
}
```

- [ ] **Step 4: Add authenticated device routes in `server/index.js`**

After `requireAuth`, add:

```js
if (method === 'GET' && pathname === '/api/devices') {
  sendJson(res, 200, {
    currentDeviceId: req.auth.device.id,
    devices: listDevices({ currentToken: requestToken(req) }),
    security: publicSecurityStatus(req, true)
  });
  return;
}

if (method === 'POST' && pathname === '/api/logout') {
  await revokeToken(requestToken(req));
  res.setHeader('set-cookie', clearAuthCookie({ secure: isRequestTransportSecure(req, securityOptions) }));
  sendJson(res, 200, { success: true });
  return;
}

if (method === 'DELETE' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'devices') {
  const result = await revokeDevice(decodeURIComponent(parts[2]));
  if (!result.ok) {
    sendJson(res, 404, { error: 'Device not found' });
    return;
  }
  if (result.deviceId === req.auth.device.id) {
    res.setHeader('set-cookie', clearAuthCookie({ secure: isRequestTransportSecure(req, securityOptions) }));
  }
  sendJson(res, 200, { success: true });
  return;
}
```

Update authentication helpers so `requireAuth()` sets `req.auth = { device }` after `verifyToken()` returns `{ ok: true, device }`.

- [ ] **Step 5: Add the authenticated security panel in `client/src/App.jsx`**

Add a lightweight view, not a new home page:

- `TopBar` receives `onOpenSecurity`.
- `TopBar` renders a shield icon button with `aria-label="安全与设备"`.
- Clicking it uses `window.history.pushState(null, '', '/security')` and sets route state.
- If authenticated and `isSecurityRoute(routePath)`, render `SecurityPanel` instead of the chat shell.
- `SecurityPanel` loads `/api/devices`, displays `securitySummaryRows(data.security)`, lists devices, and calls:
  - `DELETE /api/devices/:id` for revoke.
  - `POST /api/logout` for current-device logout.
- A back button returns to `/` and restores the existing Codex shell.

Required text:

```text
安全
公网访问：已启用 / 未启用
首次绑定：仅局域网
完全访问：已关闭 / 已启用
HTTPS：已启用 / 未启用
已绑定设备
当前设备
退出登录
撤销
返回 Codex
```

- [ ] **Step 6: Prefer HttpOnly cookies in `client/src/api.js`**

Change both `apiFetch()` and `apiBlobFetch()` to include credentials:

```js
const response = await fetch(path, {
  ...options,
  credentials: 'same-origin',
  headers,
  body:
    options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
});
```

Keep existing `Authorization` bearer fallback only for HTTP requests when `localStorage` still has the legacy token. Update `websocketUrl()` and `realtimeVoiceWebsocketUrl()` so they never put a token in the URL; WebSocket authentication must use the HttpOnly cookie sent by the browser during upgrade:

```js
return base;
```

- [ ] **Step 7: Verify**

Run:

```powershell
node --test client/src/security-panel.test.mjs server/auth.test.mjs
npm.cmd run build
```

Expected: tests pass and the React build succeeds.

- [ ] **Step 8: Commit**

```powershell
git add client/src/security-panel.js client/src/security-panel.test.mjs server/index.js client/src/App.jsx client/src/api.js
git commit -m "security: add authenticated device management"
```

---

## Task 6: Server-Side Permission Policy

**Files:**
- Create: `server/permission-policy.js`
- Create: `server/permission-policy.test.mjs`
- Modify: `server/codex-runner.js`
- Modify: `server/chat-service.js`
- Modify: `server/index.js`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Write permission policy tests**

Create `server/permission-policy.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePermissionMode } from './permission-policy.js';

test('bypassPermissions is downgraded unless explicitly enabled', () => {
  assert.deepEqual(resolvePermissionMode('bypassPermissions', { dangerFullAccessEnabled: false }), {
    permissionMode: 'default',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    desktopSandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    downgraded: true
  });
});

test('bypassPermissions maps to danger-full-access only when enabled', () => {
  assert.deepEqual(resolvePermissionMode('bypassPermissions', { dangerFullAccessEnabled: true }), {
    permissionMode: 'bypassPermissions',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    desktopSandboxPolicy: { type: 'dangerFullAccess' },
    downgraded: false
  });
});

test('default and acceptEdits remain workspace-write', () => {
  assert.equal(resolvePermissionMode('', { dangerFullAccessEnabled: false }).permissionMode, 'default');
  assert.equal(resolvePermissionMode('acceptEdits', { dangerFullAccessEnabled: false }).sandboxMode, 'workspace-write');
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test server/permission-policy.test.mjs
```

Expected: fails because module does not exist.

- [ ] **Step 3: Implement policy and backend wiring**

Create `server/permission-policy.js`:

```js
export function resolvePermissionMode(permissionMode, securityOptions = {}) {
  const requested = String(permissionMode || 'default');
  if (requested === 'bypassPermissions') {
    if (securityOptions.dangerFullAccessEnabled) {
      return {
        permissionMode: 'bypassPermissions',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        desktopSandboxPolicy: { type: 'dangerFullAccess' },
        downgraded: false
      };
    }
    return {
      permissionMode: 'default',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      desktopSandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      downgraded: true
    };
  }
  return {
    permissionMode: requested === 'acceptEdits' ? 'acceptEdits' : 'default',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    desktopSandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    downgraded: false
  };
}
```

Wire it:

- `server/codex-runner.js`: replace local `mapPermissionMode()` with `resolvePermissionMode(permissionMode, securityOptions)`.
- `server/chat-service.js`: inject `securityOptions`, default `permissionMode` to `default`, and use `desktopSandboxPolicy` in `sendViaDesktopIpc()`.
- `server/index.js`: pass `securityOptions` into `createChatService()` and `runCodexTurn()`.

- [ ] **Step 4: Update frontend permission UI**

In `client/src/App.jsx`:

- Set `const DEFAULT_PERMISSION_MODE = 'default';`.
- Hide or disable `完全访问` unless `status.security?.dangerFullAccessEnabled` is true.
- If the stored or current permission mode is `bypassPermissions` while disabled, reset to `default`.

- [ ] **Step 5: Verify**

Run:

```powershell
node --test server/permission-policy.test.mjs server/chat-service.test.mjs server/codex-runner-status.test.mjs
npm.cmd run build
```

Expected: all tests and build pass.

- [ ] **Step 6: Commit**

```powershell
git add server/permission-policy.js server/permission-policy.test.mjs server/codex-runner.js server/chat-service.js server/index.js client/src/App.jsx
git commit -m "security: disable danger full access by default"
```

---

## Task 7: Uploaded Attachment Whitelist

**Files:**
- Modify: `server/upload-service.js`
- Modify: `server/upload-service.test.mjs`
- Modify: `server/chat-service.js`
- Modify: `server/index.js`
- Modify: `server/codex-native-images.test.js`

- [ ] **Step 1: Replace upload tests with whitelist tests**

Update `server/upload-service.test.mjs` to include:

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
```

Add tests:

```js
test('resolveUploadedAttachments rejects client supplied absolute paths outside upload root', async () => {
  const uploadRoot = path.join(os.tmpdir(), 'codexmobile-uploads');
  await assert.rejects(
    () => resolveUploadedAttachments([
      { id: 'not-uploaded', name: 'secret.txt', path: 'C:\\Users\\Ray\\.codex\\auth.json', kind: 'file' }
    ], { uploadRoot }),
    /Invalid attachment/
  );
});

test('resolveUploadedAttachments accepts files saved below upload root with matching id prefix', async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-uploads-'));
  const id = crypto.randomUUID();
  const dir = path.join(uploadRoot, '2026-05-10');
  const filePath = path.join(dir, `${id}-photo.png`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, Buffer.from('image'));

  const [attachment] = await resolveUploadedAttachments([
    { id, name: 'photo.png', path: filePath, kind: 'image', mimeType: 'image/png' }
  ], { uploadRoot });

  assert.equal(attachment.path, filePath);
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.size, 5);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test server/upload-service.test.mjs
```

Expected: fails because `resolveUploadedAttachments` does not exist and old expectations still trust arbitrary paths.

- [ ] **Step 3: Implement resolver**

In `server/upload-service.js`, add:

```js
export async function resolveUploadedAttachments(value, { uploadRoot }) {
  const attachments = normalizeAttachments(value);
  const root = path.resolve(uploadRoot);
  const resolved = [];
  for (const attachment of attachments) {
    const filePath = path.resolve(String(attachment.path || ''));
    const relative = path.relative(root, filePath);
    const insideRoot = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const fileBase = path.basename(filePath);
    const idMatchesName = attachment.id && fileBase.startsWith(`${attachment.id}-`);
    if (!insideRoot || !idMatchesName) {
      const error = new Error('Invalid attachment');
      error.statusCode = 400;
      throw error;
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      const error = new Error('Invalid attachment');
      error.statusCode = 400;
      throw error;
    }
    resolved.push({ ...attachment, path: filePath, size: attachment.size || stat.size });
  }
  return resolved;
}
```

- [ ] **Step 4: Wire chat service**

In `server/index.js`, pass `uploadRoot: UPLOAD_ROOT` into `createChatService()`. In `server/chat-service.js`, replace:

```js
const attachments = normalizeAttachments(body.attachments);
```

with:

```js
const attachments = await resolveUploadedAttachments(body.attachments, { uploadRoot });
```

- [ ] **Step 5: Verify**

Run:

```powershell
node --test server/upload-service.test.mjs server/chat-service.test.mjs server/codex-native-images.test.js
npm.cmd run build
```

Expected: arbitrary paths are rejected, uploaded files still work, and build succeeds.

- [ ] **Step 6: Commit**

```powershell
git add server/upload-service.js server/upload-service.test.mjs server/chat-service.js server/index.js server/codex-native-images.test.js
git commit -m "security: restrict attachments to uploaded files"
```

---

## Task 8: Session, Active Run, And Local Image Access Boundaries

**Files:**
- Create: `server/session-access.js`
- Create: `server/session-access.test.mjs`
- Create: `server/status-policy.js`
- Create: `server/status-policy.test.mjs`
- Modify: `server/index.js`
- Modify: `server/static-service.js`
- Modify: `server/static-service.test.mjs`

- [ ] **Step 1: Write session-access tests**

Create `server/session-access.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { canReadSessionId, publicActiveRuns } from './session-access.js';

test('canReadSessionId allows visible listed sessions', () => {
  assert.equal(canReadSessionId('s1', {
    getSession: (id) => id === 's1' ? { id: 's1' } : null,
    activeRuns: []
  }), true);
});

test('canReadSessionId rejects unknown hidden sessions', () => {
  assert.equal(canReadSessionId('hidden', {
    getSession: () => null,
    activeRuns: []
  }), false);
});

test('canReadSessionId allows active mobile-created runs', () => {
  assert.equal(canReadSessionId('draft-1', {
    getSession: () => null,
    activeRuns: [{ sessionId: 'draft-1' }]
  }), true);
});

test('publicActiveRuns hides identifiers from unauthenticated status', () => {
  assert.deepEqual(publicActiveRuns(false, [{ turnId: 't1', sessionId: 's1' }]), { count: 1, items: [] });
  assert.deepEqual(publicActiveRuns(true, [{ turnId: 't1', sessionId: 's1' }]), { count: 1, items: [{ turnId: 't1', sessionId: 's1' }] });
});
```

Create `server/status-policy.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { publicStatusForAuthState } from './status-policy.js';

test('unauthenticated status exposes only auth security and version', () => {
  const status = publicStatusForAuthState(false, {
    auth: { required: true, authenticated: false, canPair: false, trustedDevices: 4 },
    security: { publicAccess: true, dangerFullAccessEnabled: false },
    version: '0.1.0',
    model: 'gpt-5.5',
    projects: [{ id: 'secret' }],
    activeRuns: [{ sessionId: 's1' }],
    desktopBridge: { connected: true },
    cwd: 'D:\\Git\\secret'
  });
  assert.deepEqual(Object.keys(status).sort(), ['auth', 'security', 'version']);
  assert.equal(status.auth.trustedDevices, 0);
  assert.equal(status.security.publicAccess, true);
});

test('authenticated status passes through full status object', () => {
  const source = { auth: { authenticated: true }, model: 'gpt-5.5', activeRuns: [] };
  assert.deepEqual(publicStatusForAuthState(true, source), source);
});
```

- [ ] **Step 2: Run failing session tests**

Run:

```powershell
node --test server/session-access.test.mjs server/status-policy.test.mjs
```

Expected: fails because `server/session-access.js` and `server/status-policy.js` do not exist.

- [ ] **Step 3: Implement session-access module**

Create `server/session-access.js`:

```js
export function canReadSessionId(sessionId, { getSession, activeRuns = [] }) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  if (getSession(id)) return true;
  return activeRuns.some((run) => run.sessionId === id || run.previousSessionId === id || run.draftSessionId === id);
}

export function publicActiveRuns(authenticated, runs = []) {
  const items = authenticated ? runs : [];
  return { count: runs.length, items };
}
```

- [ ] **Step 4: Implement public status whitelist**

Create `server/status-policy.js`:

```js
const PUBLIC_STATUS_FIELDS = ['auth', 'security', 'version'];

export function publicStatusForAuthState(authenticated, status) {
  if (authenticated) return status;
  return {
    auth: {
      required: true,
      authenticated: false,
      trustedDevices: 0,
      canPair: Boolean(status.auth?.canPair)
    },
    security: status.security || {},
    version: status.version || '0.1.0'
  };
}

export function publicStatusFields() {
  return [...PUBLIC_STATUS_FIELDS];
}
```

- [ ] **Step 5: Wire status and session checks**

In `server/index.js`:

- Build the full status object internally, then return `publicStatusForAuthState(authenticated, fullStatus)`.
- For unauthenticated `/api/status`, do not include `model`, `models`, `projects`, `sessions`, `cwd`, `desktopBridge`, `activeRuns`, `activeRunCount`, `skills`, provider config, local paths, or active turn ids.
- Before `readSessionMessages(sessionId, ...)`, call `canReadSessionId(sessionId, { getSession, activeRuns: [...getActiveRuns(), ...chatService.getActiveImageRuns()] })`.
- Before `hideSessionMessage(sessionId, messageId)`, apply the same check.
- Return `404` for rejected session ids.

- [ ] **Step 6: Restrict `/api/local-image`**

Update `server/static-service.js` so `sendLocalImage()` accepts roots:

```js
export async function sendLocalImage(req, res, url, {
  mimeTypes = DEFAULT_MIME_TYPES,
  allowedRoots = []
} = {}) {
  const roots = allowedRoots.map((root) => path.resolve(root));
  function isAllowed(filePath) {
    return roots.some((root) => {
      const relative = path.relative(root, filePath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  }
}
```

In `server/index.js`, call it with generated/upload roots only:

```js
await staticService.sendLocalImage(req, res, url, {
  allowedRoots: [GENERATED_ROOT, UPLOAD_ROOT]
});
```

Update `server/static-service.test.mjs` with:

```js
test('sendLocalImage rejects absolute image outside allowed roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-static-image-'));
  const allowedRoot = path.join(root, 'allowed');
  const blockedRoot = path.join(root, 'blocked');
  const blockedImage = path.join(blockedRoot, 'secret.png');
  await fs.mkdir(allowedRoot, { recursive: true });
  await fs.mkdir(blockedRoot, { recursive: true });
  await fs.writeFile(blockedImage, Buffer.from([137, 80, 78, 71]));

  const service = createStaticService({
    clientDist: allowedRoot,
    generatedRoot: allowedRoot,
    httpsRootCaPath: path.join(root, 'root.cer')
  });
  const response = res();
  await service.sendLocalImage(
    req(),
    response,
    new URL(`http://local/api/local-image?path=${encodeURIComponent(blockedImage)}`),
    { allowedRoots: [allowedRoot] }
  );

  assert.equal(response.statusCode, 403);
});

test('sendLocalImage serves images below allowed roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-static-image-'));
  const allowedRoot = path.join(root, 'allowed');
  const image = path.join(allowedRoot, 'image.png');
  await fs.mkdir(allowedRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from([137, 80, 78, 71]));

  const service = createStaticService({
    clientDist: allowedRoot,
    generatedRoot: allowedRoot,
    httpsRootCaPath: path.join(root, 'root.cer')
  });
  const response = res();
  await service.sendLocalImage(
    req(),
    response,
    new URL(`http://local/api/local-image?path=${encodeURIComponent(image)}`),
    { allowedRoots: [allowedRoot] }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
});
```

- [ ] **Step 7: Verify**

Run:

```powershell
node --test server/session-access.test.mjs server/status-policy.test.mjs server/static-service.test.mjs
node --check server/index.js server/static-service.js
```

Expected: tests and syntax checks pass.

- [ ] **Step 8: Commit**

```powershell
git add server/session-access.js server/session-access.test.mjs server/status-policy.js server/status-policy.test.mjs server/index.js server/static-service.js server/static-service.test.mjs
git commit -m "security: constrain session and local image access"
```

---

## Task 9: Local-Only ASR

**Files:**
- Modify: `scripts/start-asr.mjs`
- Create: `scripts/start-asr.test.mjs`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write ASR publish tests**

Create `scripts/start-asr.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublishArg } from './start-asr.mjs';

test('buildPublishArg defaults to localhost binding', () => {
  assert.equal(buildPublishArg({ host: '127.0.0.1', port: '8000' }), '127.0.0.1:8000:8000');
});

test('buildPublishArg keeps explicit exposure visible', () => {
  assert.equal(buildPublishArg({ host: '0.0.0.0', port: '9000' }), '0.0.0.0:9000:8000');
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test scripts/start-asr.test.mjs
```

Expected: fails because `buildPublishArg` is not exported.

- [ ] **Step 3: Extract helper and change Docker args**

In `scripts/start-asr.mjs`, export:

```js
export function buildPublishArg({ host = '127.0.0.1', port = '8000' } = {}) {
  return `${host}:${port}:8000`;
}
```

Set:

```js
const host = process.env.CODEXMOBILE_ASR_HOST || '127.0.0.1';
```

Use:

```js
'--publish',
buildPublishArg({ host, port }),
```

- [ ] **Step 4: Document ASR binding**

Add to `.env.example`:

```dotenv
# Local SenseVoice ASR binds to localhost by default.
# Use 0.0.0.0 only if another trusted machine must call ASR directly.
# CODEXMOBILE_ASR_HOST=127.0.0.1
```

Add to `README.md`: the public router should forward only the CodexMobile HTTPS/reverse-proxy port, never ASR, CLIProxyAPI, provider API, or model service ports.

- [ ] **Step 5: Verify**

Run:

```powershell
node --test scripts/start-asr.test.mjs
node --check scripts/start-asr.mjs
```

Expected: tests and syntax check pass.

- [ ] **Step 6: Commit**

```powershell
git add scripts/start-asr.mjs scripts/start-asr.test.mjs .env.example README.md
git commit -m "security: bind local ASR to localhost by default"
```

---

## Task 10: Public Deployment Docs And Smoke Checks

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `server/index.js`
- Modify: `scripts/start-server.mjs`
- Modify: `scripts/start-all.ps1`
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: Add public deployment env template**

Add to `.env.example`:

```dotenv
# Public exposure profile. Enable only when using HTTPS through CodexMobile or a trusted reverse proxy.
# CODEXMOBILE_PUBLIC_ACCESS=1
# CODEXMOBILE_PUBLIC_URL=https://codex.example.com/
# CODEXMOBILE_ALLOWED_ORIGINS=https://codex.example.com
# Trust forwarded headers only from these proxy IPs/CIDRs. Leave empty for direct router forwarding.
# CODEXMOBILE_TRUSTED_PROXIES=127.0.0.1
# Optional extra private CIDRs, e.g. VPN ranges not covered by defaults.
# CODEXMOBILE_PRIVATE_CIDRS=100.64.0.0/10
# CODEXMOBILE_ALLOW_REMOTE_PAIRING=0
# CODEXMOBILE_ENABLE_DANGER_FULL_ACCESS=0
# CODEXMOBILE_PAIRING_CODE_LENGTH=10
# CODEXMOBILE_PAIRING_CODE_TTL_MS=600000
# CODEXMOBILE_PAIRING_MAX_FAILURES=5
# CODEXMOBILE_PAIRING_LOCK_MS=900000
# CODEXMOBILE_TOKEN_TTL_MS=7776000000
```

- [ ] **Step 2: Add README section**

Add a section named `公网端口转发安全部署` with this checklist:

```markdown
## 公网端口转发安全部署

CodexMobile 可以放在家用/办公路由器后面使用公网端口转发，但必须按下面边界部署：

- 只转发 CodexMobile HTTPS 端口，或只转发可信反向代理的 HTTPS 端口。
- 不要转发 ASR、CLIProxyAPI、OpenAI-compatible provider、模型服务、Docker 容器端口。
- 首次绑定手机时，把手机连接到电脑所在的同一 Wi-Fi / 局域网。
- 保持 `CODEXMOBILE_ALLOW_REMOTE_PAIRING=0`，外网未绑定设备只能看到绑定说明，不能创建配对请求。
- 保持 `CODEXMOBILE_ENABLE_DANGER_FULL_ACCESS=0`，公网设备不能打开完全访问。
- 如果使用反向代理，不要使用布尔型 trust proxy；只配置 `CODEXMOBILE_TRUSTED_PROXIES=<代理 IP 或 CIDR>`，并确保代理清洗外部传入的 `X-Forwarded-*`。
- 公网模式下 HTTP 监听只用于本机健康检查；对外转发只使用 HTTPS。
- 不要把 `.codexmobile/state` 放进 OneDrive、Dropbox、网盘同步目录或公开备份。
- 手机丢失或微信环境不可信时，访问 `/security` 撤销对应设备。
```

- [ ] **Step 3: Reduce public-mode HTTP listener exposure**

In `server/index.js`, compute the HTTP listen host:

```js
function httpListenHost() {
  if (!securityOptions.publicAccess) return HOST;
  return process.env.CODEXMOBILE_PUBLIC_HTTP_HOST || '127.0.0.1';
}
```

Use it for the HTTP server:

```js
const httpHost = httpListenHost();
server.listen(PORT, httpHost, () => {
  console.log(`CodexMobile listening on http://${httpHost}:${PORT}`);
});
```

Keep HTTPS on `HOST` / `HTTPS_PORT`. In `scripts/start-server.mjs` and `scripts/start-all.ps1`, document and forward `CODEXMOBILE_PUBLIC_HTTP_HOST` only as an advanced override. Do not default public mode to `0.0.0.0` for HTTP.

- [ ] **Step 4: Add `/api/security/posture` for smoke and operations**

In `server/index.js`, add a public low-detail endpoint:

```js
if (method === 'GET' && pathname === '/api/security/posture') {
  sendJson(res, 200, {
    publicAccess: securityOptions.publicAccess,
    trustedProxyCidrs: securityOptions.trustedProxyCidrs,
    dangerFullAccessEnabled: securityOptions.dangerFullAccessEnabled,
    httpsActive: isRequestTransportSecure(req, securityOptions),
    hstsEnabled: isRequestTransportSecure(req, securityOptions),
    httpListenHost: httpListenHost(),
    httpsPort: HTTPS_PORT
  });
  return;
}
```

Do not include device counts, model names, project paths, active sessions, IP history, or token metadata.

- [ ] **Step 5: Extend smoke checks**

In `scripts/smoke.mjs`, after reading `/api/status`, print:

```js
console.log(`publicAccess=${Boolean(data.security?.publicAccess)}`);
console.log(`dangerFullAccessEnabled=${Boolean(data.security?.dangerFullAccessEnabled)}`);
console.log(`authenticated=${Boolean(data.auth?.authenticated)}`);
console.log(`trustedDevices=${Number(data.auth?.trustedDevices || 0)}`);
```

If public mode is enabled and URL is plain HTTP to a non-localhost host, fail:

```js
const parsed = new URL(url);
const localHost = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
if (process.env.CODEXMOBILE_PUBLIC_ACCESS === '1' && parsed.protocol === 'http:' && !localHost) {
  throw new Error('Public access mode requires HTTPS or a trusted HTTPS reverse proxy.');
}
```

Then read `/api/security/posture` and print:

```js
const posture = await fetchJson(new URL('/api/security/posture', url).toString());
console.log(`httpsActive=${Boolean(posture.httpsActive)}`);
console.log(`hstsEnabled=${Boolean(posture.hstsEnabled)}`);
console.log(`httpListenHost=${posture.httpListenHost || ''}`);
```

- [ ] **Step 6: Verify**

Run:

```powershell
node --check server/index.js scripts/start-server.mjs
node --check scripts/smoke.mjs
npm.cmd run build
```

Expected: syntax check and build pass.

- [ ] **Step 7: Commit**

```powershell
git add .env.example README.md server/index.js scripts/start-server.mjs scripts/start-all.ps1 scripts/smoke.mjs
git commit -m "docs: add public deployment security checklist"
```

---

## Task 11: WebSocket Cookie Auth, Origin Guard, And Revocation

**Files:**
- Create: `server/websocket-security.js`
- Create: `server/websocket-security.test.mjs`
- Modify: `server/index.js`
- Modify: `server/auth.js`
- Modify: `client/src/api.js`

- [ ] **Step 1: Write WebSocket security helper tests**

Create `server/websocket-security.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  websocketOriginAllowed,
  websocketToken
} from './websocket-security.js';

test('websocketToken reads cookie and ignores query token', () => {
  const token = websocketToken({
    url: '/ws?token=query-token',
    headers: { cookie: 'codexmobile_token=cookie-token' }
  });
  assert.equal(token, 'cookie-token');
});

test('websocketToken does not accept URL query tokens', () => {
  const token = websocketToken({
    url: '/ws?token=query-token',
    headers: {}
  });
  assert.equal(token, '');
});

test('websocketOriginAllowed rejects cross-origin upgrades', () => {
  assert.equal(websocketOriginAllowed({
    headers: { origin: 'https://evil.example.com' }
  }, {
    allowedOrigins: ['https://codex.example.com']
  }), false);
  assert.equal(websocketOriginAllowed({
    headers: { origin: 'https://codex.example.com' }
  }, {
    allowedOrigins: ['https://codex.example.com']
  }), true);
});

test('websocketOriginAllowed allows missing Origin for native clients and local tools', () => {
  assert.equal(websocketOriginAllowed({ headers: {} }, { allowedOrigins: ['https://codex.example.com'] }), true);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node --test server/websocket-security.test.mjs
```

Expected: fails because `server/websocket-security.js` does not exist.

- [ ] **Step 3: Implement `server/websocket-security.js`**

Create:

```js
import { extractCookieToken } from './request-security.js';
import { sameOriginAllowed } from './security-options.js';

export function websocketToken(req) {
  return extractCookieToken(req);
}

export function websocketOriginAllowed(req, securityOptions) {
  const origin = String(req.headers?.origin || '').trim();
  return sameOriginAllowed(origin, securityOptions);
}
```

- [ ] **Step 4: Harden `client/src/api.js` WebSocket URLs**

Replace both WebSocket URL builders with cookie-only URLs:

```js
export function websocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function realtimeVoiceWebsocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/realtime`;
}
```

Do not append `?token=` even when a legacy localStorage token exists. Legacy bearer fallback is HTTP-only and should not be preserved for WebSockets.

- [ ] **Step 5: Harden `server/index.js` upgrade handler**

Replace the current query-token logic:

```js
const token = url.searchParams.get('token') || '';
const ok = await verifyToken(token, { remoteAddress: remoteAddress(req) });
```

with:

```js
if (!websocketOriginAllowed(req, securityOptions)) {
  socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  socket.destroy();
  return;
}

const token = websocketToken(req);
const verified = await verifyToken(token, {
  remoteAddress: remoteAddress(req),
  userAgent: req.headers['user-agent'],
  securityOptions
});
if (!verified.ok) {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  socket.destroy();
  return;
}
```

After `handleUpgrade` succeeds, register sockets against the verified token hash:

```js
function trackSocket(ws, tokenHash) {
  registerSocket(tokenHash, ws);
  ws.on('close', () => unregisterSocket(tokenHash, ws));
}

if (url.pathname === '/ws/realtime') {
  realtimeWss.handleUpgrade(req, socket, head, (ws) => {
    trackSocket(ws, verified.tokenHash);
    startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
  });
  return;
}

wss.handleUpgrade(req, socket, head, async (ws) => {
  trackSocket(ws, verified.tokenHash);
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true, req) }));
});
```

If `verifyToken()` returns a `replacementToken` during an upgrade, do not send it over WebSocket. Let the next HTTP request rotate the cookie. This avoids reintroducing token material into WS messages.

- [ ] **Step 6: Ensure revoke/logout closes active sockets**

In `server/auth.js`, `registerSocket(tokenHash, socket)` stores:

```js
const socketsByTokenHash = new Map();

function registerSocket(tokenHash, socket) {
  if (!socketsByTokenHash.has(tokenHash)) socketsByTokenHash.set(tokenHash, new Set());
  socketsByTokenHash.get(tokenHash).add(socket);
}

function unregisterSocket(tokenHash, socket) {
  const set = socketsByTokenHash.get(tokenHash);
  if (!set) return;
  set.delete(socket);
  if (!set.size) socketsByTokenHash.delete(tokenHash);
}

function closeSocketsForTokenHash(tokenHash) {
  const set = socketsByTokenHash.get(tokenHash);
  if (!set) return;
  for (const socket of set) socket.close(1008, 'revoked');
  socketsByTokenHash.delete(tokenHash);
}
```

Call `closeSocketsForTokenHash()` from `revokeDevice()` for every token hash belonging to that device and from `revokeToken()` for the current token hash.

- [ ] **Step 7: Verify**

Run:

```powershell
node --test server/websocket-security.test.mjs server/auth.test.mjs
node --check server/index.js client/src/api.js
npm.cmd run build
```

Expected: WebSocket helper tests pass, auth tests pass, syntax checks pass, and build succeeds.

- [ ] **Step 8: Commit**

```powershell
git add server/websocket-security.js server/websocket-security.test.mjs server/index.js server/auth.js client/src/api.js
git commit -m "security: harden websocket authentication"
```

---

## Task 12: End-To-End Verification

**Files:**
- No source changes in this task.

- [ ] **Step 1: Run focused security tests**

```powershell
node --test server/security-options.test.mjs server/request-security.test.mjs server/auth.test.mjs server/websocket-security.test.mjs server/permission-policy.test.mjs server/upload-service.test.mjs server/session-access.test.mjs server/static-service.test.mjs scripts/start-asr.test.mjs
```

Expected: all tests pass.

- [ ] **Step 2: Run affected existing tests**

```powershell
node --test server/chat-service.test.mjs server/codex-runner-status.test.mjs server/codex-native-images.test.js client/src/pairing-flow.test.mjs client/src/security-panel.test.mjs client/src/send-state.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Build production frontend**

```powershell
npm.cmd run build
```

Expected: Vite build succeeds.

- [ ] **Step 4: Scan built frontend for obvious secret leaks**

Run after build:

```powershell
rg --encoding utf-8 -n -i "sk-[a-z0-9_-]{16,}|api[_-]?key|secret|bearer\\s+[a-z0-9._-]{16,}" client\\dist
```

Expected: no matches. If the scan finds expected static text in docs or labels, document the exact benign match before continuing.

- [ ] **Step 5: Manual LAN binding check**

Start:

```powershell
npm start -- --host 0.0.0.0 --port 33321
```

From a phone on the same Wi-Fi:

- Open `http://<lan-ip>:33321`.
- Confirm the binding page requests a code.
- Confirm the server console prints one code.
- Enter the code.
- Confirm the app enters the existing Codex shell.

- [ ] **Step 6: Manual public-mode denial check**

Start:

```powershell
$env:CODEXMOBILE_PUBLIC_ACCESS='1'
$env:CODEXMOBILE_PUBLIC_URL='https://codex.example.com/'
$env:CODEXMOBILE_ALLOW_REMOTE_PAIRING='0'
$env:CODEXMOBILE_ENABLE_DANGER_FULL_ACCESS='0'
npm start -- --host 0.0.0.0 --port 33321
```

From a non-private simulated request or unit test path:

- `POST /api/pair/request` returns `403`.
- `POST /api/pair` returns `403` or `404`.
- Unauthenticated `/api/status` has no active run identifiers.
- Unauthenticated `/api/status` field set is exactly `auth`, `security`, and `version`.
- `security.dangerFullAccessEnabled` is false.

- [ ] **Step 7: Manual WebSocket security check**

After binding:

- Open the app and confirm `/ws` connects without a `?token=` query string in DevTools Network.
- Logout from `/security`; the old app tab WebSocket closes within 1 second with close code `1008`.
- Send an upgrade request with `Origin: https://evil.example.com`; the server rejects it with `403` or destroys the socket.

- [ ] **Step 8: Manual headers and proxy-spoof checks**

Run:

```powershell
curl.exe -I https://your-host/
curl.exe -i -H "X-Forwarded-For: 192.168.1.1" http://your-public-host/api/pair/request
```

Expected:

- HTTPS response includes `strict-transport-security`.
- Public HTTP response is rejected.
- Spoofed `X-Forwarded-For` does not make a WAN request eligible for pairing unless the socket peer is listed in `CODEXMOBILE_TRUSTED_PROXIES`.

- [ ] **Step 9: Manual WeChat cookie check**

On a real phone:

- Open the public URL in WeChat after binding and refresh; the session remains authenticated.
- Open the same URL in Safari/Chrome; it is a separate browser context and should require its own binding.

- [ ] **Step 10: Manual security panel check**

After binding:

- Open `/security`.
- Confirm current device is marked.
- Confirm revoking another device removes it from the list.
- Confirm current-device logout clears auth and returns to the binding gate.
- Confirm `/` still opens the Codex shell, not a new management home page.

- [ ] **Step 11: Final status**

```powershell
git status --short --branch
```

Expected: clean working tree after commits, except intentionally untracked local runtime files.

---

## Self-Review

- Spec coverage: the plan covers public router forwarding, WeChat browser use, LAN-only first binding, console-code binding without computer-side UI, existing React shell integration, WebSocket cookie auth/origin checks/revocation, authenticated device management, trusted proxy CIDRs, CGNAT/Tailscale private addressing, HSTS/CSP, unauthenticated status whitelisting, token rotation, owner-only auth state storage, HTTPS/public HTTP listener boundaries, dangerous permission gating, upload/session/local-image access, ASR exposure, docs, bundle secret scanning, and smoke checks.
- Placeholder scan: the plan contains concrete file paths, test contents, API payloads, UI text, commands, and expected results. It avoids unresolved markers.
- Type consistency: `securityOptions`, `clientRemoteAddress`, `isTrustedProxy`, `isRequestTransportSecure`, `startPairingRequest`, `completePairingRequest`, `registerSocket`, `unregisterSocket`, `websocketToken`, `websocketOriginAllowed`, `resolvePermissionMode`, `resolveUploadedAttachments`, `canReadSessionId`, `publicStatusForAuthState`, `pairingGateState`, and `securitySummaryRows` are defined before use.
