const AUTH_COOKIE = 'codexmobile_token';

function safeDecodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      const decoded = safeDecodeCookieValue(value);
      if (decoded !== null) {
        result[key] = decoded;
      }
    }
  }
  return result;
}

export function extractCookieToken(req) {
  return parseCookies(req.headers?.cookie || '')[AUTH_COOKIE] || '';
}

export function extractRequestToken(req, { allowBearer = false } = {}) {
  const cookieToken = extractCookieToken(req);
  if (cookieToken || !allowBearer) {
    return cookieToken;
  }
  const header = String(req.headers?.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function buildAuthCookie(token, { secure = false, maxAgeSeconds } = {}) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (secure) {
    parts.push('Secure');
  }
  if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
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
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return null;
  }
  const origin = String(req.headers.origin || '').trim();
  if (!origin || options.allowedOrigins.includes(origin)) {
    return null;
  }
  return { statusCode: 403, error: 'Cross-origin request rejected' };
}

export function rejectSuspiciousFetchSite(req, { protectSafeMethod = false } = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const isSafeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (isSafeMethod && !protectSafeMethod) {
    return null;
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const allowedFetchSites = isSafeMethod
    ? ['', 'same-origin', 'none']
    : ['', 'same-origin', 'same-site', 'none'];
  if (allowedFetchSites.includes(fetchSite)) {
    return null;
  }
  return { statusCode: 403, error: 'Cross-site request rejected' };
}
