import { readBody, sendJson } from './http-utils.js';

function compilePath(pathname) {
  const names = [];
  const pattern = pathname
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      names.push(part.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { names, regex: new RegExp(`^${pattern}$`) };
}

export function createRouter() {
  const routes = [];

  function add(method, pathname, handler, options = {}) {
    routes.push({
      method: method.toUpperCase(),
      pathname,
      ...compilePath(pathname),
      handler,
      rawBody: Boolean(options.rawBody)
    });
  }

  async function handle(req, res, url, services = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    for (const route of routes) {
      if (route.method !== method) {
        continue;
      }
      const match = route.regex.exec(url.pathname);
      if (!match) {
        continue;
      }
      const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] || '')]));
      let body = {};
      if (!route.rawBody && !['GET', 'HEAD'].includes(method)) {
        try {
          body = await readBody(req);
        } catch (error) {
          sendJson(res, 400, { error: error.message || 'Invalid request body' });
          return true;
        }
      }
      await route.handler({ req, res, url, params, body, services });
      return true;
    }
    return false;
  }

  return {
    get: (pathname, handler, options) => add('GET', pathname, handler, options),
    post: (pathname, handler, options) => add('POST', pathname, handler, options),
    patch: (pathname, handler, options) => add('PATCH', pathname, handler, options),
    delete: (pathname, handler, options) => add('DELETE', pathname, handler, options),
    handle
  };
}
