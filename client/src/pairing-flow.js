/**
 * 手机端配对流程：解析终端配对链接、提交验证码，并处理服务端 Cookie 登录。
 *
 * Keywords: pairing, cookie-auth, terminal-code, device-name
 *
 * Exports:
 * - defaultDeviceName — 从浏览器环境生成设备名。
 * - normalizePairingCode / pairingRequestFromSearch — 规范配对码与解析终端配对链接。
 * - startPairingRequest / completePairing — 调用配对接口的薄封装。
 *
 * Inward（本模块依赖/组装的关键符号）: apiFetch、navigator user agent。
 *
 * Outward（谁在用/调用场景）: app/PairingScreen.jsx 与 pairing-flow 测试。
 *
 * 不负责: 页面布局。
 */
import { apiFetch } from './api.js';

export function defaultDeviceName(navigatorLike = globalThis.navigator) {
  const platform = String(navigatorLike?.platform || '').trim();
  const userAgent = String(navigatorLike?.userAgent || '').trim();
  if (/iphone/i.test(platform) || /iphone/i.test(userAgent)) return 'iPhone';
  if (/ipad/i.test(platform) || /ipad/i.test(userAgent)) return 'iPad';
  if (/android/i.test(userAgent)) return 'Android';
  if (/mac/i.test(platform) || /macintosh|mac os x/i.test(userAgent)) return 'Mac';
  if (/win/i.test(platform) || /windows/i.test(userAgent)) return 'Windows PC';
  if (/linux/i.test(platform) || /linux/i.test(userAgent)) return 'Linux';
  return 'Browser';
}

export function normalizePairingCode(value, codeLength = 0) {
  const length = Math.max(0, Number(codeLength) || 0);
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase();
  return length ? normalized.slice(0, length) : normalized;
}

export function pairingRequestFromSearch(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const requestId = String(params.get('requestId') || '').trim();
  const codeLength = Math.max(1, Number(params.get('codeLength')) || 10);
  const code = normalizePairingCode(params.get('code'), codeLength);
  if (!requestId || code.length !== codeLength) {
    return null;
  }
  return {
    requestId,
    code,
    codeLength,
    autoSubmit: true
  };
}

export async function startPairingRequest({ deviceName = defaultDeviceName() } = {}) {
  return apiFetch('/api/pair/request', {
    method: 'POST',
    body: {
      deviceName
    }
  });
}

export async function completePairing({ requestId, code, deviceName = defaultDeviceName() }) {
  return apiFetch('/api/pair', {
    method: 'POST',
    body: {
      requestId,
      code: normalizePairingCode(code),
      deviceName
    }
  });
}
