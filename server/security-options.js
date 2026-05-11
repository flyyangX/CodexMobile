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
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function cidrMatches(address, cidr) {
  const [base, prefixText] = String(cidr || '').split('/');
  const prefix = Number(prefixText);
  const addressNumber = ipv4ToNumber(normalizeRemoteAddress(address));
  const baseNumber = ipv4ToNumber(normalizeRemoteAddress(base));
  if (addressNumber === null || baseNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (baseNumber & mask);
}

export function addressInCidrs(address, cidrs = []) {
  return cidrs.some((cidr) => cidrMatches(address, cidr));
}

export function isPrivateRemoteAddress(value, options = {}) {
  const address = normalizeRemoteAddress(value);
  const lower = address.toLowerCase();
  if (addressInCidrs(address, options.privateCidrs || [])) {
    return true;
  }
  if (address === 'localhost' || address === '127.0.0.1' || address === '::1') {
    return true;
  }
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }
  if (net.isIP(address) !== 4) {
    return false;
  }
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
    legacyBearerEnabled: envFlag(env, 'CODEXMOBILE_ALLOW_LEGACY_BEARER'),
    dangerFullAccessEnabled: envFlag(env, 'CODEXMOBILE_ENABLE_DANGER_FULL_ACCESS'),
    pairingCodeLength: readIntEnv(env, 'CODEXMOBILE_PAIRING_CODE_LENGTH', 10),
    pairingCodeTtlMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_CODE_TTL_MS', 10 * 60 * 1000),
    pairingRequestCooldownMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_REQUEST_COOLDOWN_MS', 30 * 1000),
    pairingMaxFailures: readIntEnv(env, 'CODEXMOBILE_PAIRING_MAX_FAILURES', 5),
    pairingWindowMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_WINDOW_MS', 10 * 60 * 1000),
    pairingLockMs: readIntEnv(env, 'CODEXMOBILE_PAIRING_LOCK_MS', 15 * 60 * 1000),
    tokenTtlMs: readIntEnv(env, 'CODEXMOBILE_TOKEN_TTL_MS', 90 * 24 * 60 * 60 * 1000)
  };
}

export function sameOriginAllowed(origin, options) {
  const value = String(origin || '').trim();
  return !value || (options.allowedOrigins || []).includes(value);
}

export function isTrustedProxy(address, options) {
  const normalized = normalizeRemoteAddress(address);
  return options.trustedProxyCidrs?.some((cidr) => {
    if (!cidr.includes('/')) {
      return normalizeRemoteAddress(cidr) === normalized;
    }
    return cidrMatches(normalized, cidr);
  }) || false;
}

export function clientRemoteAddress(req, options) {
  if (isTrustedProxy(req.socket?.remoteAddress || '', options)) {
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwardedFor) {
      return normalizeRemoteAddress(forwardedFor);
    }
  }
  return normalizeRemoteAddress(req.socket?.remoteAddress || '');
}

export function isRequestTransportSecure(req, options) {
  if (req.socket?.encrypted) {
    return true;
  }
  if (!isTrustedProxy(req.socket?.remoteAddress || '', options)) {
    return false;
  }
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

export function requestMayUsePublicHttp(req, options) {
  const remote = clientRemoteAddress(req, options);
  return !options.publicAccess || isPrivateRemoteAddress(remote, options) || isRequestTransportSecure(req, options);
}
