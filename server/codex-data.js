/**
 * Codex 侧项目/会话数据聚合缓存：同步索引、消息读取、隐藏与桌面 thread 联动。
 *
 * Keywords: codex-data, session-cache, sqlite, desktop-sync
 *
 * Exports:
 * - 再导出 desktop/session 解析符号。
 * - refreshCodexCache / getCacheSnapshot — 缓存生命周期。
 * - listProjects / getProject / listProjectSessions / getSession / rememberLiveSession。
 * - projectlessMobileSessionRegistrations — 找出需补登记到 Codex 全局 state 的移动端普通对话。
 * - renameSession / deleteSession / unarchiveSession / hideSessionMessage / readSessionMessages / getHostName。
 *
 * Inward（本模块依赖/组装的关键符号）: session-index-builder、session-message-reader、mobile-session-index、codex-app-server、session-local-state。
 *
 * Outward（谁在用/调用场景）: server/index、各 API handler 注入。
 *
 * 不负责: HTTP 细节。
 */
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { archiveDesktopThread, listDesktopThreads, readDesktopThread, unarchiveDesktopThread } from './codex-app-server.js';
import {
  CODEX_SESSION_INDEX,
  CODEX_SESSIONS_DIR,
  CODEX_STATE_DB,
  defaultProjectlessWorkspaceRoot,
  readCodexConfig,
  readCodexWorkspaceState,
  registerProjectlessThreads
} from './codex-config.js';
import { broadcastDesktopThreadTitleUpdated } from './desktop-ipc-client.js';
import {
  readMobileSessionIndex,
  renameMobileSession
} from './mobile-session-index.js';
import {
  createSessionMessageReader,
  readRolloutContextState
} from './session-message-reader.js';
import {
  buildSessionIndex,
  PROJECTLESS_PROJECT_ID,
  projectIdFor
} from './session-index-builder.js';
import {
  hideSessionInMobile,
  hideSessionMessageInLocalState,
  readHiddenSessionIds,
  unhideSessionInMobile
} from './session-local-state.js';

export { rawSessionActivitiesFromJsonl } from './desktop-activity-parser.js';
export { messagesFromDesktopThread } from './desktop-thread-projector.js';
export { normalizeComparablePath } from './session-index-builder.js';

const INCLUDE_MISSING_SUBAGENT_THREADS = process.env.CODEXMOBILE_INCLUDE_MISSING_SUBAGENT_THREADS === '1';
const USE_LOCAL_THREAD_SCAN = /^(1|true|yes|on)$/i.test(String(process.env.CODEXMOBILE_USE_LOCAL_THREAD_SCAN || '').trim());
const execFileAsync = promisify(execFile);
const LOCAL_THREAD_SCAN_LIMIT = 1000;
const LOCAL_THREAD_HEAD_BYTES = 512 * 1024;
const THREAD_LIST_FALLBACK_MS = Math.max(1000, Number(process.env.CODEXMOBILE_THREAD_LIST_FALLBACK_MS) || 2500);
const SESSION_CACHE_PATH = path.join(process.cwd(), '.codexmobile', 'state', 'session-cache.json');

let cache = {
  syncedAt: null,
  config: null,
  projects: [],
  projectById: new Map(),
  sessionsByProject: new Map(),
  sessionById: new Map()
};

function hydrateCacheFromDisk() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(SESSION_CACHE_PATH, 'utf8'));
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const sessionsByProject = new Map();
    const sessionById = new Map();
    for (const session of sessions) {
      if (!session?.id || !session.projectId) {
        continue;
      }
      if (!sessionsByProject.has(session.projectId)) {
        sessionsByProject.set(session.projectId, []);
      }
      sessionsByProject.get(session.projectId).push(session);
      sessionById.set(session.id, session);
    }
    cache = {
      syncedAt: parsed.syncedAt || null,
      config: parsed.config || null,
      projects,
      projectById,
      sessionsByProject,
      sessionById
    };
  } catch {
    // Empty cache is acceptable on first run.
  }
}

async function persistCacheToDisk(snapshot) {
  const sessions = [...snapshot.sessionById.values()];
  const payload = {
    version: 1,
    syncedAt: snapshot.syncedAt,
    config: snapshot.config,
    projects: snapshot.projects,
    sessions
  };
  await fs.mkdir(path.dirname(SESSION_CACHE_PATH), { recursive: true });
  const tmpPath = `${SESSION_CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
  await fs.rename(tmpPath, SESSION_CACHE_PATH);
}

hydrateCacheFromDisk();

async function resolveSessionThread(sessionId) {
  const cached = cache.sessionById.get(sessionId);
  if (cached) {
    return cached;
  }
  const mobileIndex = await readMobileSessionIndex().catch(() => new Map());
  const mobileSession = mobileIndex.get(sessionId);
  if (!mobileSession) {
    return null;
  }
  return {
    id: sessionId,
    cwd: mobileSession.projectPath || '',
    projectless: Boolean(mobileSession.projectless),
    filePath: mobileSession.filePath || null
  };
}

const sessionMessageReader = createSessionMessageReader({
  resolveSessionThread,
  getConfigContext: () => cache.config?.context || {}
});

function toPublicProject(entry) {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    pathLabel: entry.pathLabel || null,
    projectless: Boolean(entry.projectless),
    trusted: entry.trusted,
    updatedAt: entry.updatedAt,
    sessionCount: entry.sessionCount || 0
  };
}

async function readThreadSpawnEdges() {
  try {
    await fs.access(CODEX_STATE_DB);
    const query = `
      select
        parent_thread_id as parentSessionId,
        child_thread_id as childSessionId,
        status
      from thread_spawn_edges
    `;
    const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], {
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((edge) => edge?.parentSessionId && edge?.childSessionId)
      : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read subagent thread edges:', error.message);
    }
    return [];
  }
}

async function collectJsonlFiles(dir, files = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to scan local sessions:', error.message);
    }
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

function eventUserPreviewFromPayload(payload = {}) {
  if (payload.type === 'event_msg' && payload.payload?.type === 'user_message') {
    return String(payload.payload.message || '').trim();
  }
  return '';
}

function fallbackUserPreviewFromPayload(payload = {}) {
  if (payload.type === 'response_item' && payload.payload?.role === 'user') {
    const content = Array.isArray(payload.payload.content) ? payload.payload.content : [];
    return content
      .map((item) => item?.text || item?.input_text?.text || '')
      .join('\n')
      .trim();
  }
  return '';
}

function localThreadFromJsonl(raw, filePath, stat, threadNameIndex = new Map(), threadSqliteIndex = new Map()) {
  let meta = null;
  let preview = '';
  let fallbackPreview = '';
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let item = null;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (!meta && item.type === 'session_meta') {
      meta = item.payload || {};
    }
    if (!preview) {
      preview = eventUserPreviewFromPayload(item);
    }
    if (!fallbackPreview) {
      fallbackPreview = fallbackUserPreviewFromPayload(item);
    }
    if (meta && preview) {
      break;
    }
  }
  const id = meta?.id || path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] || '';
  if (!id) {
    return null;
  }
  const sqliteThread = threadSqliteIndex.get(id) || {};
  const updatedAtMs = Number(stat?.mtimeMs || Date.now());
  const sqliteSource = sqliteThread.agentNickname || sqliteThread.agentRole
    ? {
      subAgent: {
        thread_spawn: {
          agent_nickname: sqliteThread.agentNickname || null,
          agent_role: sqliteThread.agentRole || null
        }
      }
    }
    : (sqliteThread.threadSource || sqliteThread.source || meta?.source || 'vscode');
  return {
    id,
    cwd: sqliteThread.cwd || meta?.cwd || '',
    path: filePath,
    preview: sqliteThread.firstUserMessage || preview || fallbackPreview,
    name: threadNameIndex.get(id) || sqliteThread.title || meta?.title || null,
    source: sqliteSource,
    model: sqliteThread.model || meta?.model || null,
    reasoningEffort: sqliteThread.reasoningEffort || meta?.reasoning_effort || meta?.model_reasoning_effort || null,
    modelProvider: sqliteThread.modelProvider || meta?.model_provider || null,
    updatedAt: sqliteThread.updatedAt || Math.floor(updatedAtMs / 1000),
    archived: Boolean(sqliteThread.archived),
    archivedAt: sqliteThread.archivedAt || null,
    agentNickname: sqliteThread.agentNickname || null,
    agentRole: sqliteThread.agentRole || null,
    status: 'completed',
    skipContextState: true
  };
}

async function readThreadSqliteIndex() {
  try {
    await fs.access(CODEX_STATE_DB);
    const query = `
      select
        id,
        title,
        cwd,
        source,
        thread_source as threadSource,
        model,
        reasoning_effort as reasoningEffort,
        model_provider as modelProvider,
        updated_at as updatedAt,
        archived,
        archived_at as archivedAt,
        first_user_message as firstUserMessage,
        agent_nickname as agentNickname,
        agent_role as agentRole
      from threads
    `;
    const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], {
      maxBuffer: 16 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout || '[]');
    return new Map(
      (Array.isArray(parsed) ? parsed : [])
        .filter((thread) => thread?.id)
        .map((thread) => [thread.id, thread])
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read sqlite thread index:', error.message);
    }
    return new Map();
  }
}

async function readThreadNameIndex() {
  const names = new Map();
  let raw = '';
  try {
    raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read session title index:', error.message);
    }
    return names;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      const id = String(item.id || '').trim();
      const title = String(item.thread_name || '').trim();
      if (id && title) {
        names.set(id, title);
      }
    } catch {
      // Ignore corrupt index rows; the rollout file still gives us a fallback title.
    }
  }
  return names;
}

function sqlString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

async function updateThreadTitleInSqlite(sessionId, title) {
  try {
    await fs.access(CODEX_STATE_DB);
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    await execFileAsync('sqlite3', [
      CODEX_STATE_DB,
      `update threads set title=${sqlString(title)}, updated_at=${nowSeconds}, updated_at_ms=${nowMs} where id=${sqlString(sessionId)}`
    ]);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to update sqlite thread title:', error.message);
    }
  }
}

async function updateThreadNameIndex(sessionId, title) {
  const id = String(sessionId || '').trim();
  const threadName = String(title || '').trim();
  if (!id || !threadName) {
    return false;
  }
  let raw = '';
  try {
    raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const updatedAt = new Date().toISOString();
  let found = false;
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      if (String(item.id || '') === id) {
        found = true;
        lines.push(JSON.stringify({ ...item, thread_name: threadName, updated_at: updatedAt }));
      } else {
        lines.push(line);
      }
    } catch {
      lines.push(line);
    }
  }
  if (!found) {
    lines.push(JSON.stringify({ id, thread_name: threadName, updated_at: updatedAt }));
  }
  await fs.mkdir(path.dirname(CODEX_SESSION_INDEX), { recursive: true });
  const tmpPath = `${CODEX_SESSION_INDEX}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf8');
  await fs.rename(tmpPath, CODEX_SESSION_INDEX);
  return true;
}

async function readLocalThreadHead(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(LOCAL_THREAD_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listLocalDesktopThreadsFromJsonl({ limit = LOCAL_THREAD_SCAN_LIMIT } = {}) {
  const threadNameIndex = await readThreadNameIndex();
  const threadSqliteIndex = await readThreadSqliteIndex();
  const files = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  const withStats = await Promise.all(files.map(async (filePath) => {
    try {
      return { filePath, stat: await fs.stat(filePath) };
    } catch {
      return null;
    }
  }));
  const sorted = withStats
    .filter(Boolean)
    .sort((a, b) => Number(b.stat.mtimeMs || 0) - Number(a.stat.mtimeMs || 0))
    .slice(0, limit);
  const threads = [];
  for (const item of sorted) {
    try {
      const raw = await readLocalThreadHead(item.filePath);
      const thread = localThreadFromJsonl(raw, item.filePath, item.stat, threadNameIndex, threadSqliteIndex);
      if (thread) {
        threads.push(thread);
      }
    } catch (error) {
      console.warn(`[sessions] Failed to read local session ${item.filePath}:`, error.message);
    }
  }
  return threads;
}

async function listDesktopThreadsForCache() {
  if (USE_LOCAL_THREAD_SCAN) {
    return listLocalDesktopThreadsFromJsonl({ limit: LOCAL_THREAD_SCAN_LIMIT });
  }
  const remote = listDesktopThreads({ limit: 1000 })
    .then((threads) => ({ source: 'desktop', threads }))
    .catch((error) => ({ source: 'error', error }));
  const fallback = new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ source: 'fallback-timeout' });
    }, THREAD_LIST_FALLBACK_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  const result = await Promise.race([remote, fallback]);
  if (result.source === 'desktop') {
    return result.threads;
  }
  if (result.source === 'error') {
    console.warn('[sessions] Desktop thread/list failed, using local session files:', result.error.message);
  } else {
    console.warn(`[sessions] Desktop thread/list did not respond within ${THREAD_LIST_FALLBACK_MS}ms, using local session files.`);
    remote.then((late) => {
      if (late.source === 'error') {
        console.warn('[sessions] Late desktop thread/list failed:', late.error.message);
      }
    });
  }
  return listLocalDesktopThreadsFromJsonl({ limit: LOCAL_THREAD_SCAN_LIMIT });
}

function isoFromThreadTime(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return isoFromThreadTime(numeric);
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isArchivedLocalThread(thread = null) {
  if (!thread || typeof thread !== 'object') {
    return false;
  }
  const status = String(thread.status || '').toLowerCase();
  return Boolean(thread.archived) || Boolean(thread.isArchived) || status === 'archived' || Boolean(thread.archivedAt || thread.archived_at);
}

function shortModelLabel(model = '') {
  const value = String(model || '').trim();
  if (!value) {
    return '';
  }
  return `${value.replace(/^gpt-/i, '').replace(/-codex.*$/i, '').replace(/-mini$/i, ' mini')} 中`;
}

function archivedSessionFromThread(thread = {}) {
  const id = String(thread.id || '').trim();
  if (!id) {
    return null;
  }
  const model = String(thread.model || thread.modelName || '').trim();
  const updatedAt = isoFromThreadTime(thread.updatedAt || thread.updated_at || thread.modifiedAt || thread.mtime);
  const archivedAt = isoFromThreadTime(thread.archivedAt || thread.archived_at || thread.deletedAt || thread.deleted_at || thread.archiveAt) || updatedAt;
  return {
    id,
    title: String(thread.name || thread.title || '').trim() || '对话',
    summary: String(thread.preview || thread.summary || thread.firstUserMessage || '').trim(),
    projectPath: String(thread.cwd || thread.projectPath || '').trim(),
    updatedAt,
    archivedAt,
    model,
    modelShort: String(thread.modelShort || '').trim() || shortModelLabel(model)
  };
}

async function listLocalArchivedSessions({ limit = 200 } = {}) {
  const threads = await listLocalDesktopThreadsFromJsonl({ limit: LOCAL_THREAD_SCAN_LIMIT });
  return threads
    .filter((thread) => isArchivedLocalThread(thread))
    .map((thread) => archivedSessionFromThread(thread))
    .filter(Boolean)
    .sort((a, b) => {
      const left = new Date(a.archivedAt || a.updatedAt || 0).getTime();
      const right = new Date(b.archivedAt || b.updatedAt || 0).getTime();
      return right - left;
    })
    .slice(0, limit);
}

export async function listArchivedSessions({ limit = 200 } = {}) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  try {
    const threads = await listDesktopThreads({ limit: cappedLimit, archived: true });
    return {
      sessions: threads.map((thread) => archivedSessionFromThread(thread)).filter(Boolean),
      syncedAt: new Date().toISOString(),
      source: 'desktop'
    };
  } catch (error) {
    console.warn('[sessions] Desktop archived thread/list failed, using local archived sessions:', error.message);
    return {
      sessions: await listLocalArchivedSessions({ limit: cappedLimit }),
      syncedAt: new Date().toISOString(),
      source: 'local',
      staleReason: error.message || 'desktop archived thread/list failed'
    };
  }
}

function inferredProjectlessWorkspaceRoot(projectPath, defaultWorkspaceRoot = defaultProjectlessWorkspaceRoot) {
  const fallback = path.resolve(defaultWorkspaceRoot());
  const resolved = String(projectPath || '').trim() ? path.resolve(projectPath) : fallback;
  const parent = path.dirname(resolved);
  if (/^\d{4}-\d{2}-\d{2}$/.test(path.basename(parent))) {
    return path.dirname(parent);
  }
  return resolved || fallback;
}

export function projectlessMobileSessionRegistrations(mobileSessionIndex = new Map(), workspaceState = {}) {
  const mobileIndex = mobileSessionIndex instanceof Map
    ? mobileSessionIndex
    : new Map(Object.entries(mobileSessionIndex || {}));
  const registered = new Set(
    Array.isArray(workspaceState.projectlessThreadIds)
      ? workspaceState.projectlessThreadIds
      : []
  );
  const registrations = [];

  for (const [key, session] of mobileIndex.entries()) {
    const id = String(session?.id || key || '').trim();
    if (!id || id.startsWith('draft-') || id.startsWith('codex-')) {
      continue;
    }
    if (!session?.projectless || registered.has(id)) {
      continue;
    }
    registrations.push({
      id,
      workspaceRoot: inferredProjectlessWorkspaceRoot(session.projectPath)
    });
  }

  return registrations;
}

export async function refreshCodexCache() {
  const config = await readCodexConfig();
  let workspaceState = await readCodexWorkspaceState();
  const mobileSessionIndex = await readMobileSessionIndex();
  const missingProjectlessRegistrations = projectlessMobileSessionRegistrations(mobileSessionIndex, workspaceState);
  if (missingProjectlessRegistrations.length) {
    try {
      await registerProjectlessThreads(missingProjectlessRegistrations);
      workspaceState = await readCodexWorkspaceState();
    } catch (error) {
      console.warn('[sessions] Failed to backfill mobile projectless registrations:', error.message);
    }
  }
  const hiddenSessionIds = await readHiddenSessionIds();
  const spawnEdges = await readThreadSpawnEdges();
  const desktopThreads = await listDesktopThreadsForCache();
  const sessionIndex = await buildSessionIndex({
    config,
    workspaceState,
    mobileSessionIndex,
    hiddenSessionIds,
    desktopThreads,
    spawnEdges,
    includeMissingSubagentThreads: INCLUDE_MISSING_SUBAGENT_THREADS,
    readDesktopThread,
    readRolloutContextState
  });

  cache = {
    syncedAt: new Date().toISOString(),
    config,
    ...sessionIndex
  };
  persistCacheToDisk(cache).catch((error) => {
    console.warn('[sessions] Failed to persist session cache:', error.message);
  });

  return getCacheSnapshot();
}

export function getCacheSnapshot() {
  return {
    syncedAt: cache.syncedAt,
    config: cache.config,
    projects: cache.projects.map(toPublicProject)
  };
}

export function listProjects() {
  return cache.projects.map(toPublicProject);
}

export function getProject(projectId) {
  return cache.projectById.get(projectId) || null;
}

export function listProjectSessions(projectId) {
  return (cache.sessionsByProject.get(projectId) || []).map((session) => ({
    id: session.id,
    projectId: session.projectId,
    cwd: session.cwd,
    title: session.title,
    titleLocked: Boolean(session.titleLocked),
    titleAutoGenerated: session.titleAutoGenerated || null,
    summary: session.summary,
    model: session.model,
    provider: session.provider,
    source: session.source,
    parentSessionId: session.parentSessionId || null,
    isSubAgent: Boolean(session.isSubAgent),
    subAgent: session.subAgent || null,
    childCount: session.childCount || 0,
    openChildCount: session.openChildCount || 0,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    runtime: session.runtime || null,
    context: session.context || null
  }));
}

export function getSession(sessionId) {
  return cache.sessionById.get(sessionId) || null;
}

export function rememberLiveSession(session = {}) {
  const id = String(session.id || session.sessionId || '').trim();
  if (!id || id.startsWith('draft-') || id.startsWith('codex-')) {
    return null;
  }
  const existing = cache.sessionById.get(id) || {};
  const projectPath = session.projectPath || session.cwd || existing.cwd || '';
  const projectless = Boolean(session.projectless || session.projectId === PROJECTLESS_PROJECT_ID || existing.projectless);
  const projectId = session.projectId || existing.projectId || (projectless ? PROJECTLESS_PROJECT_ID : (projectPath ? projectIdFor(projectPath) : null));
  const resolvedCwd = projectPath ? path.resolve(projectPath) : existing.cwd || '';
  const updatedAt = session.updatedAt || existing.updatedAt || new Date().toISOString();
  const title = String(session.title || existing.title || session.summary || '新对话').trim();
  const summary = String(session.summary || existing.summary || title || 'CodexMobile 对话').trim();
  const next = {
    ...existing,
    id,
    cwd: resolvedCwd,
    projectId,
    title,
    titleLocked: Boolean(existing.titleLocked || session.titleLocked),
    titleAutoGenerated: existing.titleAutoGenerated || session.titleAutoGenerated || (session.titleLocked ? null : 'provisional'),
    summary,
    messageCount: Array.isArray(session.messages) ? session.messages.length : existing.messageCount || 0,
    updatedAt,
    source: session.source || existing.source || 'codexmobile',
    projectless,
    mobileSessionKnown: true,
    filePath: session.filePath || existing.filePath || null,
    context: existing.context || null
  };
  cache.sessionById.set(id, next);

  if (projectId && cache.projectById.has(projectId)) {
    const current = cache.sessionsByProject.get(projectId) || [];
    const filtered = current.filter((item) => item.id !== id);
    cache.sessionsByProject.set(projectId, [next, ...filtered]);
  }
  return next;
}

export async function applySessionTitleUpdate(sessionId, title, { projectId = null, auto = false } = {}) {
  const id = String(sessionId || '').trim();
  const nextTitle = String(title || '').trim().slice(0, 52);
  if (!id || !nextTitle) {
    return null;
  }

  await updateThreadNameIndex(id, nextTitle);
  updateThreadTitleInSqlite(id, nextTitle).catch(() => {});

  const existing = cache.sessionById.get(id) || null;
  const updatedAt = new Date().toISOString();
  const next = existing
    ? {
      ...existing,
      title: nextTitle,
      titleLocked: !auto,
      titleAutoGenerated: auto ? 'model' : null,
      updatedAt
    }
    : {
      id,
      projectId,
      title: nextTitle,
      titleLocked: !auto,
      titleAutoGenerated: auto ? 'model' : null,
      updatedAt
    };

  if (existing) {
    cache.sessionById.set(id, next);
    const targetProjectId = existing.projectId || projectId;
    if (targetProjectId && cache.sessionsByProject.has(targetProjectId)) {
      cache.sessionsByProject.set(
        targetProjectId,
        (cache.sessionsByProject.get(targetProjectId) || []).map((session) =>
          session.id === id ? next : session
        )
      );
    }
    await renameMobileSession({
      id,
      projectPath: existing.cwd,
      projectless: existing.projectless,
      title: nextTitle,
      titleLocked: !auto,
      titleAutoGenerated: auto ? 'model' : null,
      updatedAt
    }).catch((error) => {
      console.warn('[sessions] Failed to update mobile title index:', error.message);
    });
  }

  persistCacheToDisk(cache).catch((error) => {
    console.warn('[sessions] Failed to persist renamed session cache:', error.message);
  });
  return next;
}

export async function renameSession(sessionId, projectId, title, { auto = false } = {}) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const nextTitle = String(title || '').trim().slice(0, 52);
  if (!nextTitle) {
    const error = new Error('Title is required');
    error.statusCode = 400;
    throw error;
  }

  const renamed = await applySessionTitleUpdate(session.id, nextTitle, { projectId: session.projectId, auto });
  if (!session.mobileOnly) {
    broadcastDesktopThreadTitleUpdated(session.id, nextTitle).catch((error) => {
      console.warn(`[desktop-ipc] title broadcast failed thread=${session.id}: ${error.message}`);
    });
  }

  return renamed || { ...session, title: nextTitle, titleLocked: !auto, titleAutoGenerated: auto ? 'model' : null };
}

export async function deleteSession(sessionId, projectId) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  let archivedDesktopThread = false;
  if (!session.mobileOnly) {
    await archiveDesktopThread(session.id);
    archivedDesktopThread = true;
  }

  const hidden = await hideSessionInMobile(session);

  return {
    deletedSessionId: sessionId,
    projectId: session.projectId,
    hiddenOnly: !archivedDesktopThread,
    archivedDesktopThread,
    hiddenAt: hidden.hiddenAt,
    deletedFile: false,
    deletedIndexRows: false,
    deletedMobileRecord: false
  };
}

export async function unarchiveSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) {
    const error = new Error('Session id is required');
    error.statusCode = 400;
    throw error;
  }

  await unarchiveDesktopThread(id);
  const local = await unhideSessionInMobile(id);

  return {
    sessionId: id,
    unarchivedDesktopThread: true,
    unhidden: local.unhidden
  };
}

export async function hideSessionMessage(sessionId, messageId) {
  return hideSessionMessageInLocalState(sessionId, messageId);
}

export async function readSessionMessages(sessionId, options = {}) {
  return sessionMessageReader.readSessionMessages(sessionId, options);
}

export function getHostName() {
  return os.hostname();
}
