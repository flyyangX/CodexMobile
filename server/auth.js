import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPrivateRemoteAddress, normalizeRemoteAddress, readSecurityOptions } from './security-options.js';

export const DATA_DIR = process.env.CODEXMOBILE_HOME || path.join(process.cwd(), '.codexmobile', 'state');
const STATE_FILE_NAME = 'auth-state.json';
const DEFAULT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SUPERSEDED_TOKEN_GRACE_MS = 5 * 60 * 1000;

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function timingSafeHexEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length !== right.length || !left.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function createPairingCode(length = 10) {
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += DEFAULT_CODE_ALPHABET[crypto.randomInt(0, DEFAULT_CODE_ALPHABET.length)];
  }
  return value;
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[auth] Failed to read auth state, starting fresh:', error.message);
    }
    return {};
  }
}

function publicDevice(device, currentTokenHash = '') {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt || null,
    revokedAt: device.revokedAt || null,
    userAgent: device.userAgent || null,
    lastUserAgent: device.lastUserAgent || null,
    lastSeenAt: device.lastSeenAt || null,
    lastRemoteAddress: device.lastRemoteAddress || null,
    current: Boolean(currentTokenHash && deviceTokenRecords(device).some((record) => record.hash === currentTokenHash))
  };
}

function deviceTokenRecords(device) {
  if (Array.isArray(device.tokens) && device.tokens.length) {
    return device.tokens;
  }
  if (device.tokenHash) {
    return [{
      hash: device.tokenHash,
      createdAt: device.createdAt,
      expiresAt: device.expiresAt || null,
      supersededAt: device.supersededAt || null
    }];
  }
  return [];
}

function retryAfterSeconds(lockedUntil, nowMs) {
  return Math.max(1, Math.ceil((lockedUntil - nowMs) / 1000));
}

function consumeBucket(map, key, { maxFailures, windowMs, lockMs }, nowMs) {
  const bucket = map.get(key) || { count: 0, windowStart: nowMs, lockedUntil: 0 };
  if (bucket.lockedUntil && bucket.lockedUntil > nowMs) {
    return { ok: false, retryAfterSeconds: retryAfterSeconds(bucket.lockedUntil, nowMs) };
  }
  if (nowMs - bucket.windowStart > windowMs) {
    bucket.count = 0;
    bucket.windowStart = nowMs;
    bucket.lockedUntil = 0;
  }
  bucket.count += 1;
  if (bucket.count > maxFailures) {
    bucket.lockedUntil = nowMs + lockMs;
    map.set(key, bucket);
    return { ok: false, retryAfterSeconds: retryAfterSeconds(bucket.lockedUntil, nowMs) };
  }
  map.set(key, bucket);
  return { ok: true };
}

async function ensurePrivateStatePath(dataDir) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(dataDir, 0o700).catch(() => {});
  }
}

export function createAuthController({
  dataDir = DATA_DIR,
  now = () => Date.now(),
  logPairingCode = (entry) => {
    if (process.stdout.isTTY) {
      process.stdout.write(`[pairing] code=${entry.code}\n`);
    } else {
      console.log('[pairing] code hidden because stdout is not an interactive terminal');
    }
    console.log(`[pairing] request=${entry.requestId} device=${entry.deviceName} remote=${entry.remoteAddress} expiresAt=${entry.expiresAt}`);
  }
} = {}) {
  const stateFile = path.join(dataDir, STATE_FILE_NAME);
  const pendingPairingRequests = new Map();
  const pairingRequestsByRemote = new Map();
  const pairingCooldownsByRemote = new Map();
  const pairingFailuresByRemote = new Map();
  const socketsByTokenHash = new Map();
  let authState = { devices: [] };
  let stateWriteChain = Promise.resolve();

  async function writeStateSnapshot(snapshot) {
    await ensurePrivateStatePath(dataDir);
    const tmpFile = `${stateFile}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(tmpFile, snapshot, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') {
        await fs.chmod(tmpFile, 0o600).catch(() => {});
      }
      await fs.rename(tmpFile, stateFile);
      if (process.platform !== 'win32') {
        await fs.chmod(stateFile, 0o600).catch(() => {});
      }
    } catch (error) {
      await fs.unlink(tmpFile).catch(() => {});
      throw error;
    }
  }

  async function writeState() {
    const snapshot = JSON.stringify(authState, null, 2);
    const write = stateWriteChain.then(() => writeStateSnapshot(snapshot));
    stateWriteChain = write.catch(() => {});
    await write;
  }

  function addDevice({ token, deviceName, userAgent, remoteAddress, securityOptions }) {
    const nowMs = now();
    const createdAt = iso(nowMs);
    const expiresAt = iso(nowMs + securityOptions.tokenTtlMs);
    const tokenHash = hashToken(token);
    const device = {
      id: crypto.randomUUID(),
      name: deviceName || 'iPhone',
      tokenHash,
      tokens: [{
        hash: tokenHash,
        createdAt,
        expiresAt,
        supersededAt: null
      }],
      createdAt,
      expiresAt,
      revokedAt: null,
      userAgent: userAgent || null,
      lastUserAgent: userAgent || null,
      lastSeenAt: createdAt,
      lastRemoteAddress: remoteAddress || null
    };
    authState.devices.push(device);
    return { tokenHash, device };
  }

  function registerSocket(tokenHash, socket) {
    if (!tokenHash || !socket) {
      return;
    }
    if (!socketsByTokenHash.has(tokenHash)) {
      socketsByTokenHash.set(tokenHash, new Set());
    }
    socketsByTokenHash.get(tokenHash).add(socket);
  }

  function unregisterSocket(tokenHash, socket) {
    const set = socketsByTokenHash.get(tokenHash);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (!set.size) {
      socketsByTokenHash.delete(tokenHash);
    }
  }

  function closeSocketsForTokenHash(tokenHash) {
    const set = socketsByTokenHash.get(tokenHash);
    if (!set) {
      return;
    }
    for (const socket of set) {
      if (typeof socket.close === 'function') {
        socket.close(1008, 'revoked');
      }
    }
    socketsByTokenHash.delete(tokenHash);
  }

  async function initializeAuth() {
    const parsed = await readJson(stateFile);
    authState = {
      devices: Array.isArray(parsed.devices) ? parsed.devices : []
    };
    for (const device of authState.devices) {
      if (!Array.isArray(device.tokens) && device.tokenHash) {
        device.tokens = deviceTokenRecords(device);
      }
    }
    await writeState();
    return { trustedDevices: authState.devices.length };
  }

  async function startPairingRequest({ deviceName, userAgent, remoteAddress, securityOptions = readSecurityOptions() }) {
    const normalizedRemote = normalizeRemoteAddress(remoteAddress);
    if (!isPrivateRemoteAddress(normalizedRemote, securityOptions) && !securityOptions.allowRemotePairing) {
      return { ok: false, statusCode: 403, error: 'Pairing is only allowed from the local network' };
    }

    const nowMs = now();
    const cooldownUntil = pairingCooldownsByRemote.get(normalizedRemote) || 0;
    if (cooldownUntil > nowMs) {
      return {
        ok: false,
        statusCode: 429,
        error: 'Pairing request cooldown',
        retryAfterSeconds: retryAfterSeconds(cooldownUntil, nowMs)
      };
    }

    const requestBucket = consumeBucket(pairingRequestsByRemote, normalizedRemote, {
      maxFailures: securityOptions.pairingMaxFailures,
      windowMs: securityOptions.pairingWindowMs,
      lockMs: securityOptions.pairingLockMs
    }, nowMs);
    if (!requestBucket.ok) {
      return {
        ok: false,
        statusCode: 429,
        error: 'Too many pairing requests',
        retryAfterSeconds: requestBucket.retryAfterSeconds
      };
    }

    const code = createPairingCode(securityOptions.pairingCodeLength);
    const requestId = crypto.randomUUID();
    const createdAt = iso(nowMs);
    const expiresAt = iso(nowMs + securityOptions.pairingCodeTtlMs);
    const request = {
      requestId,
      codeHash: hashToken(code),
      deviceName: deviceName || 'iPhone',
      userAgent: userAgent || null,
      remoteAddress: normalizedRemote,
      createdAt,
      expiresAt,
      failedAttempts: 0
    };
    pendingPairingRequests.set(requestId, request);
    const requestCooldownMs = Math.max(0, Number(securityOptions.pairingRequestCooldownMs) || 0);
    if (requestCooldownMs > 0) {
      pairingCooldownsByRemote.set(normalizedRemote, nowMs + requestCooldownMs);
    }
    logPairingCode({ ...request, code, codeLength: code.length });
    return {
      ok: true,
      requestId,
      code,
      codeLength: code.length,
      deviceName: request.deviceName,
      remoteAddress: request.remoteAddress,
      expiresAt,
      requestCooldownSeconds: requestCooldownMs > 0 ? Math.ceil(requestCooldownMs / 1000) : 0
    };
  }

  async function completePairingRequest({ requestId, code, remoteAddress, securityOptions = readSecurityOptions() }) {
    const normalizedRemote = normalizeRemoteAddress(remoteAddress);
    const request = pendingPairingRequests.get(String(requestId || ''));
    if (!request) {
      return { ok: false, statusCode: 404, error: 'Pairing request not found' };
    }
    if (request.remoteAddress !== normalizedRemote && !securityOptions.allowRemotePairing) {
      return { ok: false, statusCode: 403, error: 'Pairing is only allowed from the local network' };
    }

    const nowMs = now();
    if (Date.parse(request.expiresAt) <= nowMs) {
      pendingPairingRequests.delete(request.requestId);
      return { ok: false, statusCode: 410, error: 'Pairing code expired' };
    }

    const failureBucket = consumeBucket(pairingFailuresByRemote, normalizedRemote, {
      maxFailures: securityOptions.pairingMaxFailures,
      windowMs: securityOptions.pairingWindowMs,
      lockMs: securityOptions.pairingLockMs
    }, nowMs);
    if (!failureBucket.ok) {
      pendingPairingRequests.delete(request.requestId);
      return {
        ok: false,
        statusCode: 429,
        error: 'Too many pairing attempts',
        retryAfterSeconds: failureBucket.retryAfterSeconds
      };
    }

    if (!timingSafeHexEqual(hashToken(String(code || '').trim().toUpperCase()), request.codeHash)) {
      request.failedAttempts += 1;
      return { ok: false, statusCode: 403, error: 'Invalid pairing code' };
    }

    const token = createToken();
    const { device } = addDevice({
      token,
      deviceName: request.deviceName,
      userAgent: request.userAgent,
      remoteAddress: normalizedRemote,
      securityOptions
    });
    pendingPairingRequests.delete(request.requestId);
    pairingFailuresByRemote.delete(normalizedRemote);
    await writeState();
    return { ok: true, token, device: publicDevice(device) };
  }

  async function verifyToken(token, { remoteAddress, userAgent, securityOptions = readSecurityOptions(), rotate = true } = {}) {
    if (!token || !authState) {
      return { ok: false };
    }
    const tokenHash = hashToken(token);
    const nowMs = now();
    for (const device of authState.devices) {
      if (device.revokedAt) {
        continue;
      }
      const tokenRecord = deviceTokenRecords(device).find((record) => record.hash === tokenHash);
      if (!tokenRecord) {
        continue;
      }
      if (tokenRecord.expiresAt && Date.parse(tokenRecord.expiresAt) <= nowMs) {
        return { ok: false };
      }
      if (tokenRecord.supersededAt && nowMs - Date.parse(tokenRecord.supersededAt) > SUPERSEDED_TOKEN_GRACE_MS) {
        return { ok: false };
      }

      device.lastSeenAt = iso(nowMs);
      device.lastRemoteAddress = remoteAddress || device.lastRemoteAddress || null;
      device.lastUserAgent = userAgent || device.lastUserAgent || null;

      let replacementToken = null;
      let activeTokenHash = tokenHash;
      const createdMs = Date.parse(tokenRecord.createdAt || device.createdAt || iso(nowMs));
      const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : 0;
      if (tokenRecord.supersededAt) {
        const activeRecord = deviceTokenRecords(device)
          .filter((record) => {
            if (record.hash === tokenHash || record.supersededAt) {
              return false;
            }
            return !record.expiresAt || Date.parse(record.expiresAt) > nowMs;
          })
          .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''))[0];
        if (activeRecord) {
          activeTokenHash = activeRecord.hash;
        }
      }
      if (rotate && !tokenRecord.supersededAt && ageMs > securityOptions.tokenTtlMs / 2) {
        replacementToken = createToken();
        activeTokenHash = hashToken(replacementToken);
        tokenRecord.supersededAt = iso(nowMs);
        if (!Array.isArray(device.tokens)) {
          device.tokens = deviceTokenRecords(device);
        }
        device.tokens.push({
          hash: activeTokenHash,
          createdAt: iso(nowMs),
          expiresAt: iso(nowMs + securityOptions.tokenTtlMs),
          supersededAt: null
        });
        device.tokenHash = activeTokenHash;
        device.expiresAt = iso(nowMs + securityOptions.tokenTtlMs);
      }
      await writeState();
      return {
        ok: true,
        device: publicDevice(device, activeTokenHash),
        tokenHash: activeTokenHash,
        replacementToken
      };
    }
    return { ok: false };
  }

  async function revokeDevice(deviceId) {
    const device = authState.devices.find((entry) => entry.id === deviceId);
    if (!device) {
      return { ok: false };
    }
    device.revokedAt = iso(now());
    for (const record of deviceTokenRecords(device)) {
      closeSocketsForTokenHash(record.hash);
    }
    await writeState();
    return { ok: true, deviceId: device.id };
  }

  async function revokeToken(token) {
    const tokenHash = hashToken(token);
    for (const device of authState.devices) {
      if (deviceTokenRecords(device).some((record) => record.hash === tokenHash)) {
        device.revokedAt = iso(now());
        for (const record of deviceTokenRecords(device)) {
          closeSocketsForTokenHash(record.hash);
        }
        await writeState();
        return { ok: true, deviceId: device.id };
      }
    }
    return { ok: false };
  }

  function listDevices({ currentToken } = {}) {
    const currentTokenHash = currentToken ? hashToken(currentToken) : '';
    return authState.devices.map((device) => publicDevice(device, currentTokenHash));
  }

  function getTrustedDeviceCount() {
    return authState.devices.filter((device) => !device.revokedAt).length;
  }

  function getPendingPairingRequest(requestId) {
    const request = pendingPairingRequests.get(requestId);
    return request ? { ...request } : null;
  }

  return {
    initializeAuth,
    startPairingRequest,
    completePairingRequest,
    verifyToken,
    revokeDevice,
    revokeToken,
    registerSocket,
    unregisterSocket,
    listDevices,
    getTrustedDeviceCount,
    getPendingPairingRequest
  };
}

const defaultAuth = createAuthController();

export async function initializeAuth() {
  return defaultAuth.initializeAuth();
}

export function getTrustedDeviceCount() {
  return defaultAuth.getTrustedDeviceCount();
}

export async function verifyToken(token, metadata = {}) {
  return defaultAuth.verifyToken(token, metadata);
}

export async function startPairingRequest(params) {
  return defaultAuth.startPairingRequest(params);
}

export async function completePairingRequest(params) {
  return defaultAuth.completePairingRequest(params);
}

export async function revokeDevice(deviceId) {
  return defaultAuth.revokeDevice(deviceId);
}

export async function revokeToken(token) {
  return defaultAuth.revokeToken(token);
}

export function registerSocket(tokenHash, socket) {
  return defaultAuth.registerSocket(tokenHash, socket);
}

export function unregisterSocket(tokenHash, socket) {
  return defaultAuth.unregisterSocket(tokenHash, socket);
}

export function listDevices(options) {
  return defaultAuth.listDevices(options);
}
