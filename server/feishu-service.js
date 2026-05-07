import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { htmlEscape, sendHtml } from './http-utils.js';

export function createFeishuService({
  appId,
  appSecret,
  redirectUri,
  publicUrl,
  docsHomeUrl,
  statePath,
  maxStateAgeMs,
  port,
  getLarkDocsStatus,
  logoutLarkCli,
  startLarkCliAuth
}) {
  let authState = { token: null, pendingStates: {} };

  async function loadAuthState() {
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      authState = {
        token: parsed?.token && typeof parsed.token === 'object' ? parsed.token : null,
        pendingStates: parsed?.pendingStates && typeof parsed.pendingStates === 'object' ? parsed.pendingStates : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[feishu] Failed to read auth state:', error.message);
      }
      authState = { token: null, pendingStates: {} };
    }
  }

  async function saveAuthState() {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(authState, null, 2), 'utf8');
  }

  function cleanupPendingStates() {
    const now = Date.now();
    const nextStates = {};
    for (const [state, payload] of Object.entries(authState.pendingStates || {})) {
      const createdAt = Number(payload?.createdAt || 0);
      if (createdAt && now - createdAt <= maxStateAgeMs) {
        nextStates[state] = payload;
      }
    }
    authState.pendingStates = nextStates;
  }

  function requestOrigin(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`;
    return `${proto}://${String(host).split(',')[0].trim()}`;
  }

  function authRedirectUri(req) {
    if (redirectUri) {
      return redirectUri;
    }
    const base = publicUrl || requestOrigin(req);
    return new URL('/api/feishu/auth/callback', base.endsWith('/') ? base : `${base}/`).toString();
  }

  function configured() {
    return Boolean(appId && appSecret);
  }

  function tokenValid() {
    const expiresAt = Number(authState.token?.expiresAt || 0);
    return Boolean(authState.token?.accessToken && expiresAt && expiresAt > Date.now() + 60_000);
  }

  function userSummary() {
    const user = authState.token?.user || {};
    const name = user.name || user.enName || user.email || user.enterpriseEmail || user.openId || '';
    return name ? {
      name,
      email: user.email || user.enterpriseEmail || '',
      openId: user.openId || ''
    } : null;
  }

  async function publicDocsStatus(authenticated) {
    try {
      return await getLarkDocsStatus({ authenticated });
    } catch (error) {
      return {
        provider: 'feishu',
        integration: 'lark-cli',
        label: '飞书文档',
        configured: configured(),
        connected: authenticated ? tokenValid() : false,
        user: authenticated ? userSummary() : null,
        homeUrl: docsHomeUrl,
        cliInstalled: false,
        skillsInstalled: false,
        capabilities: [],
        codexEnabled: false,
        error: error.message || 'lark-cli status failed'
      };
    }
  }

  async function feishuJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 1000) };
    }
    if (!response.ok || Number(data.code || 0) !== 0) {
      const error = new Error(data.msg || data.message || `Feishu API request failed: ${response.status}`);
      error.statusCode = response.status;
      error.response = data;
      throw error;
    }
    return data;
  }

  async function getAppAccessToken() {
    if (!configured()) {
      const error = new Error('Feishu app credentials are not configured');
      error.statusCode = 400;
      throw error;
    }
    const data = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });
    return data.app_access_token;
  }

  async function exchangeCode(code) {
    const appAccessToken = await getAppAccessToken();
    const data = await feishuJson('https://open.feishu.cn/open-apis/authen/v1/access_token', {
      method: 'POST',
      headers: { authorization: `Bearer ${appAccessToken}` },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code
      })
    });
    const token = data.data || data;
    const now = Date.now();
    authState.token = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      expiresAt: now + Math.max(0, Number(token.expires_in || 0)) * 1000,
      refreshExpiresAt: token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : 0,
      user: {
        name: token.name || '',
        enName: token.en_name || '',
        email: token.email || '',
        enterpriseEmail: token.enterprise_email || '',
        openId: token.open_id || '',
        unionId: token.union_id || '',
        userId: token.user_id || '',
        tenantKey: token.tenant_key || ''
      },
      updatedAt: new Date().toISOString()
    };
    await saveAuthState();
    return authState.token;
  }

  async function handleCallback(req, res, url, { remoteAddress, warn } = {}) {
    const code = String(url.searchParams.get('code') || '').trim();
    const state = String(url.searchParams.get('state') || '').trim();
    const error = String(url.searchParams.get('error') || '').trim();
    cleanupPendingStates();
    const pending = state ? authState.pendingStates[state] : null;
    if (!pending) {
      sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权已过期，请回到 CodexMobile 重新连接。</p>');
      return;
    }
    delete authState.pendingStates[state];
    await saveAuthState();
    if (error) {
      sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(error)}</p>`);
      return;
    }
    if (!code) {
      sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权失败：没有收到授权码。</p>');
      return;
    }
    try {
      await exchangeCode(code);
      const backUrl = new URL('/', pending.redirectUri).toString();
      res.writeHead(302, { location: `${backUrl}?feishu=connected` });
      res.end();
    } catch (callbackError) {
      warn?.(`[feishu] OAuth callback failed remote=${remoteAddress?.(req) || ''} message=${callbackError.message}`);
      sendHtml(res, 502, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(callbackError.message)}</p>`);
    }
  }

  async function startCliAuth() {
    return startLarkCliAuth();
  }

  async function logoutCli() {
    return logoutLarkCli();
  }

  async function startOAuth(req) {
    if (!configured()) {
      const error = new Error('Feishu app credentials are not configured');
      error.statusCode = 400;
      throw error;
    }
    cleanupPendingStates();
    const state = crypto.randomBytes(24).toString('base64url');
    const nextRedirectUri = authRedirectUri(req);
    authState.pendingStates[state] = {
      createdAt: Date.now(),
      redirectUri: nextRedirectUri
    };
    await saveAuthState();
    const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/index');
    authUrl.searchParams.set('app_id', appId);
    authUrl.searchParams.set('redirect_uri', nextRedirectUri);
    authUrl.searchParams.set('state', state);
    return {
      url: authUrl.toString(),
      redirectUri: nextRedirectUri
    };
  }

  async function logoutOAuth() {
    authState.token = null;
    await saveAuthState();
  }

  return {
    handleCallback,
    loadAuthState,
    logoutCli,
    logoutOAuth,
    publicDocsStatus,
    startCliAuth,
    startOAuth
  };
}
