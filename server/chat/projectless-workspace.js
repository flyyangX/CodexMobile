import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultProjectlessWorkspaceRoot } from '../codex-config.js';

function dateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function slugFromMessage(message, fallback = 'mobile-chat') {
  const ascii = String(message || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 48);
  return ascii || fallback;
}

export async function projectlessThreadWorkingDirectory(project, message) {
  const root = path.resolve(project?.path || defaultProjectlessWorkspaceRoot());
  const day = dateStamp();
  const slug = slugFromMessage(message);
  const unique = `${slug}-${Date.now().toString(36)}`;
  const cwd = path.join(root, day, unique);
  await fs.mkdir(cwd, { recursive: true });
  return cwd;
}
