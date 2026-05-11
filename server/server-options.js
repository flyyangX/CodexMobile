const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3321;
const DEFAULT_HTTPS_PORT = 3443;

const ARG_ALIASES = new Map([
  ['-p', 'port'],
  ['--port', 'port'],
  ['--http-port', 'port'],
  ['--host', 'host'],
  ['--https-port', 'httpsPort']
]);

function parseArgValue(arg, nextArg) {
  const eqIndex = arg.indexOf('=');
  if (eqIndex >= 0) {
    return {
      rawFlag: arg.slice(0, eqIndex),
      value: arg.slice(eqIndex + 1),
      consumedNext: false
    };
  }
  return {
    rawFlag: arg,
    value: nextArg,
    consumedNext: true
  };
}

export function parseServerCliArgs(argv = process.argv.slice(2)) {
  const options = {};
  const unknown = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      unknown.push(arg);
      continue;
    }

    const { rawFlag, value, consumedNext } = parseArgValue(arg, argv[index + 1]);
    const key = ARG_ALIASES.get(rawFlag);
    if (!key) {
      unknown.push(arg);
      continue;
    }
    if (!value || String(value).startsWith('-')) {
      throw new Error(`${rawFlag} requires a value`);
    }
    options[key] = String(value).trim();
    if (consumedNext) {
      index += 1;
    }
  }

  return { options, unknown };
}

function parsePort(value, fallback, label) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

export function readServerOptions({
  argv = process.argv.slice(2),
  env = process.env,
  allowUnknown = false
} = {}) {
  const { options, unknown } = parseServerCliArgs(argv);
  if (!allowUnknown && unknown.length) {
    throw new Error(`Unknown server option: ${unknown[0]}`);
  }

  return {
    host: options.host || env.HOST || DEFAULT_HOST,
    port: parsePort(options.port || env.CODEXMOBILE_PORT || env.PORT, DEFAULT_PORT, 'HTTP port'),
    httpsPort: parsePort(
      options.httpsPort || env.CODEXMOBILE_HTTPS_PORT || env.HTTPS_PORT,
      DEFAULT_HTTPS_PORT,
      'HTTPS port'
    ),
    help: Boolean(options.help)
  };
}

export function resolveHttpListenHost({ publicAccess = false, httpsStarted = false, host = DEFAULT_HOST } = {}) {
  return publicAccess && httpsStarted ? '127.0.0.1' : host;
}

export function serverOptionsHelp(command = 'npm start --') {
  return [
    'Usage:',
    `  ${command} [--port <port>] [--https-port <port>] [--host <address>]`,
    '',
    'Examples:',
    `  ${command} --port 33321`,
    `  ${command} --host 127.0.0.1 --port 33321 --https-port 33443`
  ].join('\n');
}
