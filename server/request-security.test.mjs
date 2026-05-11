import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAuthCookie,
  clearAuthCookie,
  extractCookieToken,
  extractRequestToken,
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

test('parseCookies ignores malformed percent-encoded cookie values', () => {
  assert.deepEqual(parseCookies('bad=%E0%A4%A; codexmobile_token=abc'), {
    codexmobile_token: 'abc'
  });
});

test('extractRequestToken ignores Bearer tokens unless explicitly enabled', () => {
  const req = {
    headers: {
      cookie: 'codexmobile_token=cookie-token',
      authorization: 'Bearer bearer-token'
    }
  };
  assert.equal(extractRequestToken(req), 'cookie-token');
  assert.equal(extractRequestToken({ headers: { authorization: 'Bearer bearer-token' } }), '');
  assert.equal(extractRequestToken({ headers: { authorization: 'Bearer bearer-token' } }, { allowBearer: true }), 'bearer-token');
});

test('buildAuthCookie sets browser security attributes', () => {
  const cookie = buildAuthCookie('token-value', { secure: true, maxAgeSeconds: 60 });
  assert.match(cookie, /codexmobile_token=token-value/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
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

test('rejectSuspiciousFetchSite can protect safe API methods', () => {
  assert.equal(rejectSuspiciousFetchSite({
    method: 'GET',
    headers: { 'sec-fetch-site': 'cross-site' }
  }), null);

  const crossSiteResult = rejectSuspiciousFetchSite({
    method: 'GET',
    headers: { 'sec-fetch-site': 'cross-site' }
  }, { protectSafeMethod: true });
  assert.deepEqual(crossSiteResult, {
    statusCode: 403,
    error: 'Cross-site request rejected'
  });

  const sameSiteResult = rejectSuspiciousFetchSite({
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-site' }
  }, { protectSafeMethod: true });
  assert.deepEqual(sameSiteResult, {
    statusCode: 403,
    error: 'Cross-site request rejected'
  });

  assert.equal(rejectSuspiciousFetchSite({
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' }
  }, { protectSafeMethod: true }), null);
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
