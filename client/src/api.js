const LEGACY_TOKEN_KEY = 'codexmobile.deviceToken';

export function getToken() {
  return '';
}

export function setToken(token) {
  if (token) {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
}

export function clearToken() {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

export async function apiFetch(path, options = {}) {
  const { timeoutMs: rawTimeoutMs, ...fetchOptions } = options;
  const timeoutMs = Number(rawTimeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? globalThis.setTimeout(() => controller.abort(), timeoutMs) : null;
  const headers = {
    ...(fetchOptions.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...(fetchOptions.headers || {})
  };

  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      credentials: 'same-origin',
      headers,
      signal: fetchOptions.signal || controller?.signal,
      body:
        fetchOptions.body && !(fetchOptions.body instanceof FormData) && typeof fetchOptions.body !== 'string'
          ? JSON.stringify(fetchOptions.body)
          : fetchOptions.body
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('请求超时，请在桌面端确认 Git 操作状态');
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) {
      globalThis.clearTimeout(timeout);
    }
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.code = data.code || null;
    error.retryAfterSeconds = data.retryAfterSeconds || null;
    throw error;
  }
  return data;
}

export async function apiBlobFetch(path, options = {}) {
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
    body:
      options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed: ${response.status}`;
    let code = null;
    try {
      const data = text ? JSON.parse(text) : {};
      message = data.error || message;
      code = data.code || null;
    } catch {
      message = text || message;
    }
    const error = new Error(message);
    error.status = response.status;
    error.code = code;
    throw error;
  }

  return response.blob();
}

export function websocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
