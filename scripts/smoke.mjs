import path from 'node:path';
import { findSecretLikeMatches } from './bundle-secret-scan.mjs';

const url = process.env.CODEXMOBILE_URL || 'http://127.0.0.1:3321/api/status';
const distDir = path.resolve(import.meta.dirname, '..', 'client', 'dist');

async function fetchJson(targetUrl) {
  const response = await fetch(targetUrl);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.response = data;
    throw error;
  }
  return data;
}

try {
  const parsed = new URL(url);
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (process.env.CODEXMOBILE_PUBLIC_ACCESS === '1' && parsed.protocol === 'http:' && !localHost) {
    throw new Error('Public access mode requires HTTPS or a trusted HTTPS reverse proxy.');
  }

  const data = await fetchJson(url);
  console.log(`publicAccess=${Boolean(data.security?.publicAccess)}`);
  console.log(`dangerFullAccessEnabled=${Boolean(data.security?.dangerFullAccessEnabled)}`);
  console.log(`authenticated=${Boolean(data.auth?.authenticated)}`);
  console.log(`trustedDevices=${Number(data.auth?.trustedDevices || 0)}`);
  if (data.auth?.authenticated) {
    console.log(`Smoke ok: ${data.hostName} ${data.provider}/${data.model} synced=${data.syncedAt}`);
  } else {
    console.log(`Smoke ok: unauthenticated status version=${data.version || ''}`);
  }

  const posture = await fetchJson(new URL('/api/security/posture', url).toString());
  console.log(`httpsActive=${Boolean(posture.httpsActive)}`);
  console.log(`hstsEnabled=${Boolean(posture.hstsEnabled)}`);
  console.log(`httpListenHost=${posture.httpListenHost || ''}`);

  const secretMatches = await findSecretLikeMatches(distDir);
  if (secretMatches.length) {
    const first = secretMatches[0];
    throw new Error(`Built frontend contains secret-like text: ${first.file}:${first.line}`);
  }
  console.log('bundleSecretScan=clean');
} catch (error) {
  console.error(`Smoke failed: ${error.message}`);
  if (error.response) {
    console.error(error.response);
  }
  process.exit(1);
}
