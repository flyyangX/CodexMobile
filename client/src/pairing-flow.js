export const PAIRING_REQUEST_COOLDOWN_MS = 30 * 1000;

export function normalizePairingCode(value, codeLength = 10) {
  const length = Math.max(1, Number(codeLength) || 10);
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, length);
}

export function pairingPromptText({ requesting = false, requestId = '', codeLength = 10, canPair = true } = {}) {
  if (requesting) {
    return '正在请求本机配对码...';
  }
  if (requestId) {
    return `输入电脑端控制台显示的 ${Number(codeLength) || 10} 位配对码。`;
  }
  if (!canPair) {
    return '当前网络不能发起配对，请回到电脑所在局域网后再请求配对码。';
  }
  return '需要绑定此设备时，先请求一次性配对码。';
}

export function pairingRequestCooldownSeconds(cooldownUntil = 0, nowMs = Date.now()) {
  const until = Number(cooldownUntil) || 0;
  const now = Number(nowMs) || Date.now();
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function pairingRequestDisabled({
  requesting = false,
  pairing = false,
  canPair = true,
  cooldownUntil = 0,
  nowMs = Date.now()
} = {}) {
  return Boolean(requesting) || Boolean(pairing) || !canPair || pairingRequestCooldownSeconds(cooldownUntil, nowMs) > 0;
}

export function pairingRequestLabel({
  requesting = false,
  requestId = '',
  cooldownUntil = 0,
  nowMs = Date.now()
} = {}) {
  if (requesting) {
    return '请求中';
  }
  const cooldownSeconds = pairingRequestCooldownSeconds(cooldownUntil, nowMs);
  if (cooldownSeconds > 0) {
    return `${cooldownSeconds}s 后可重新请求`;
  }
  return requestId ? '重新请求配对码' : '请求配对码';
}

export function pairingSubmitDisabled({
  requestId = '',
  code = '',
  codeLength = 10,
  pairing = false,
  requesting = false
} = {}) {
  return !requestId || String(code || '').length !== (Number(codeLength) || 10) || Boolean(pairing) || Boolean(requesting);
}
