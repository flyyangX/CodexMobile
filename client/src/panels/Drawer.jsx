import { Archive, ChevronDown, ChevronLeft, ChevronRight, Folder, Loader2, MessageSquare, Pencil, Plus, Search, Settings, X } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '../api.js';
import { compactPath, formatTime, hasRunningKey, sessionRunKeys, subAgentSubtitle } from '../app/session-utils.js';

function quotaPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

function quotaRemainingPercent(quotaWindow) {
  if (!quotaWindow || typeof quotaWindow !== 'object') {
    return null;
  }
  const display = quotaPercent(quotaWindow.displayPercent ?? quotaWindow.display_percent);
  if (display !== null) {
    return display;
  }
  const explicit = quotaPercent(quotaWindow.remainingPercent ?? quotaWindow.remaining_percent);
  if (explicit !== null) {
    return explicit;
  }
  const used = quotaPercent(quotaWindow.usedPercent ?? quotaWindow.used_percent);
  return used === null ? null : Math.max(0, Math.min(100, 100 - used));
}

function formatQuotaPercent(quotaWindow) {
  const percent = quotaRemainingPercent(quotaWindow);
  return percent === null ? '--' : `${Math.round(percent)}%`;
}

function quotaToneClass(percent) {
  if (percent === null) {
    return 'is-low';
  }
  if (percent >= 80) {
    return 'is-healthy';
  }
  if (percent >= 60) {
    return 'is-medium';
  }
  if (percent >= 40) {
    return 'is-warning';
  }
  return 'is-low';
}

export function Drawer({
  open,
  onClose,
  projects,
  selectedProject,
  selectedSession,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  runningById,
  threadRuntimeById,
  completedSessionIds,
  onToggleProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onNewConversation,
  onSync,
  syncing,
  theme,
  setTheme,
  canCreateThread = true,
  createThreadUnavailableReason = ''
}) {
  const [drawerView, setDrawerView] = useState('main');
  const [subagentExpandedById, setSubagentExpandedById] = useState({});
  const [quotaExpanded, setQuotaExpanded] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaNotice, setQuotaNotice] = useState('');
  const [quotaAccounts, setQuotaAccounts] = useState([]);
  const [drawerQuery, setDrawerQuery] = useState('');
  const normalizedDrawerQuery = drawerQuery.trim().toLowerCase();
  const runningCount = Object.values(runningById || {}).filter(Boolean).length;

  async function refreshCodexQuota(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (quotaLoading) {
      return;
    }
    setQuotaExpanded(true);
    setQuotaLoading(true);
    setQuotaError('');
    setQuotaNotice('');
    try {
      const result = await apiFetch('/api/quotas/codex');
      setQuotaAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setQuotaNotice(result.stale ? (result.staleReason || '实时查询失败，显示最近一次成功结果') : '');
      setQuotaLoaded(true);
    } catch (error) {
      setQuotaError(`${error.message || '查询失败'}，点击刷新重试`);
      setQuotaLoaded(true);
    } finally {
      setQuotaLoading(false);
    }
  }

  if (drawerView === 'settings') {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
        <aside className={`drawer ${open ? 'is-open' : ''}`}>
          <div className="drawer-subheader">
            <button className="icon-button" onClick={() => setDrawerView('main')} aria-label="返回">
              <ChevronLeft size={22} />
            </button>
            <strong>设置</strong>
            <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
              <X size={20} />
            </button>
          </div>
          <div className="settings-view">
            <section className="settings-group">
              <div className="drawer-heading">外观</div>
              <div className="theme-setting">
                <div className="theme-setting-title">
                  <span>主题选择</span>
                </div>
                <div className="theme-segment" role="group" aria-label="主题选择">
                  <button
                    type="button"
                    className={theme === 'light' ? 'is-selected' : ''}
                    onClick={() => setTheme('light')}
                  >
                    白色
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'is-selected' : ''}
                    onClick={() => setTheme('dark')}
                  >
                    黑色
                  </button>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`}>
        <div className="drawer-header">
          <div>
            <strong>CodexMobile</strong>
            <small>{runningCount ? `已连接 · ${runningCount} 个任务运行中` : '已连接'}</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
            <X size={20} />
          </button>
        </div>

        <div className="drawer-command">
          <label className="drawer-search">
            <Search size={17} />
            <input
              type="search"
              value={drawerQuery}
              onChange={(event) => setDrawerQuery(event.target.value)}
              placeholder="搜索对话..."
              aria-label="搜索对话"
            />
          </label>
          <button
            className="drawer-new-button"
            onClick={onNewConversation}
            disabled={!canCreateThread}
            title={!canCreateThread ? (createThreadUnavailableReason || '请先在桌面端新建对话') : '新对话'}
          >
            <Plus size={17} />
            新对话
          </button>
        </div>

        <section className="drawer-section project-section">
          <div className="drawer-heading">对话分类</div>
          <div className="project-list">
            {projects.map((project) => {
              const isSelected = selectedProject?.id === project.id;
              const isExpanded = Boolean(expandedProjectIds[project.id]);
              const projectSessions = sessionsByProject[project.id] || [];
              const projectMatches = normalizedDrawerQuery
                ? [project.name, project.pathLabel, project.path].some((value) => String(value || '').toLowerCase().includes(normalizedDrawerQuery))
                : true;
              const visibleProjectSessions = normalizedDrawerQuery
                ? projectSessions.filter((session) => String(session.title || '对话').toLowerCase().includes(normalizedDrawerQuery))
                : projectSessions;
              if (normalizedDrawerQuery && !projectMatches && !visibleProjectSessions.length) {
                return null;
              }
              const projectSessionIds = new Set(visibleProjectSessions.map((session) => session.id));
              const childSessionsByParent = visibleProjectSessions.reduce((acc, session) => {
                if (session.parentSessionId && projectSessionIds.has(session.parentSessionId)) {
                  if (!acc.has(session.parentSessionId)) {
                    acc.set(session.parentSessionId, []);
                  }
                  acc.get(session.parentSessionId).push(session);
                }
                return acc;
              }, new Map());
              const rootSessions = visibleProjectSessions.filter(
                (session) => !session.parentSessionId || !projectSessionIds.has(session.parentSessionId)
              );
              const sessionsOpen = isExpanded || Boolean(normalizedDrawerQuery);
              const renderThreadRow = (session, { isSubAgent = false } = {}) => {
                const runtime = threadRuntimeById?.[session.id] || null;
                const sessionRunning = runtime?.status === 'running' || hasRunningKey(runningById, sessionRunKeys(session));
                const sessionCompleted = runtime?.status === 'completed' || Boolean(completedSessionIds?.[session.id]);
                const childCount = Number(session.childCount) || 0;
                const openChildCount = Number(session.openChildCount) || 0;
                const subagentsOpen = Boolean(subagentExpandedById[session.id]);
                const rowSelected = selectedSession?.id === session.id;
                return (
                  <div
                    key={session.id}
                    className={`thread-row ${rowSelected ? 'is-selected has-actions' : 'is-compact'} ${session.draft ? 'is-draft' : ''} ${sessionRunning ? 'is-running' : ''} ${sessionCompleted ? 'has-complete-notice' : ''} ${isSubAgent || session.isSubAgent ? 'is-subagent' : ''}`}
                  >
                    <button
                      type="button"
                      className="thread-main"
                      onClick={() => onSelectSession(session)}
                    >
                      <span className="thread-title-line">
                        <span>{session.title || '对话'}</span>
                        {!isSubAgent && childCount ? (
                          <span
                            role="button"
                            tabIndex={0}
                            className="thread-subagent-toggle"
                            aria-label={subagentsOpen ? '折叠子代理线程' : '展开子代理线程'}
                            aria-expanded={subagentsOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSubagentExpandedById((current) => ({ ...current, [session.id]: !current[session.id] }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                setSubagentExpandedById((current) => ({ ...current, [session.id]: !current[session.id] }));
                              }
                            }}
                          >
                            {openChildCount ? `${openChildCount}/${childCount}` : childCount} 子代理
                            <ChevronDown size={12} />
                          </span>
                        ) : null}
                        {sessionRunning ? (
                          <Loader2 className="thread-status-spin spin" size={12} aria-label="运行中" />
                        ) : sessionCompleted ? (
                          <span className="thread-complete-dot" aria-label="有新完成结果" />
                        ) : null}
                      </span>
                      <small>
                        {sessionRunning
                          ? '正在处理'
                          : session.draft
                            ? '待发送'
                            : isSubAgent || session.isSubAgent
                              ? subAgentSubtitle(session)
                              : formatTime(session.updatedAt)}
                      </small>
                    </button>
                    {rowSelected ? (
                      <>
                        <button
                          type="button"
                          className="thread-rename"
                          onClick={() => onRenameSession(project, session)}
                          aria-label="重命名线程"
                          title="重命名线程"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="thread-delete"
                          onClick={() => onDeleteSession(project, session)}
                          aria-label="归档线程"
                          title="归档线程"
                        >
                          <Archive size={14} />
                        </button>
                      </>
                    ) : (
                      <ChevronDown size={14} className="thread-row-more" />
                    )}
                  </div>
                );
              };
              return (
                <div key={project.id} className="project-group">
                  <button
                    className={`project-row ${isSelected ? 'is-selected' : ''} ${sessionsOpen ? 'is-expanded' : ''}`}
                    onClick={() => onToggleProject(project)}
                  >
                    {project.projectless ? <MessageSquare size={18} /> : <Folder size={18} />}
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.pathLabel || compactPath(project.path)}</small>
                    </span>
                    <small className="project-count">{project.sessionCount || projectSessions.length || 0}</small>
                    <ChevronDown size={15} className="project-chevron" />
                  </button>
                  {sessionsOpen ? (
                    <div className="thread-list">
                      {loadingProjectId === project.id ? (
                        <div className="thread-empty">
                          <Loader2 className="spin" size={14} />
                          加载中
                        </div>
                      ) : visibleProjectSessions.length ? (
                        rootSessions.map((session) => {
                          const childSessions = childSessionsByParent.get(session.id) || [];
                          const childSessionsOpen = Boolean(subagentExpandedById[session.id]);
                          return (
                            <div key={session.id} className="thread-stack">
                              {renderThreadRow(session)}
                              {childSessions.length && childSessionsOpen ? (
                                <div className="thread-list is-subagents">
                                  {childSessions.map((childSession) => renderThreadRow(childSession, { isSubAgent: true }))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <div className="thread-empty">暂无线程</div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="drawer-section drawer-controls">
          <div className="control-row sync-row">
            <span>
              对话同步
            </span>
            <button className="sync-button" onClick={onSync} disabled={syncing}>
              {syncing ? <Loader2 className="spin" size={16} /> : null}
              同步
            </button>
            <span className="sync-spacer" aria-hidden="true" />
          </div>
          <div className={`quota-widget ${quotaExpanded ? 'is-expanded' : ''}`}>
            <div className="quota-row">
              <button
                type="button"
                className="quota-main"
                onClick={() => setQuotaExpanded((current) => !current)}
              >
                <span className="quota-title">额度查询</span>
                <span className="quota-kind">Codex</span>
              </button>
              <button
                type="button"
                className="quota-refresh"
                onClick={refreshCodexQuota}
                disabled={quotaLoading}
              >
                {quotaLoading ? '刷新中...' : '刷新'}
              </button>
              <button
                type="button"
                className="quota-toggle"
                onClick={() => setQuotaExpanded((current) => !current)}
                aria-label={quotaExpanded ? '收起额度查询' : '展开额度查询'}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            {quotaExpanded ? (
              <div className="quota-panel">
                {quotaError ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaError}
                  </button>
                ) : null}
                {!quotaError && quotaNotice ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaNotice}，点击刷新
                  </button>
                ) : null}
                {!quotaError && quotaAccounts.length ? (
                  quotaAccounts.map((account) => {
                    const windows = Array.isArray(account.windows) ? account.windows : [];
                    const accountStatus = account.status || 'ok';
                    const plan = account.plan || 'Codex';
                    return (
                      <div key={account.id} className={`quota-account is-${accountStatus}`}>
                        <div className="quota-account-head">
                          <span>{account.label || 'Codex'}</span>
                          <small>{plan}</small>
                        </div>
                        {accountStatus === 'ok' && windows.length ? (
                          <div className="quota-window-list">
                            {windows.map((quotaWindow) => {
                              const percent = quotaRemainingPercent(quotaWindow);
                              return (
                                <div
                                  key={quotaWindow.id}
                                  className={`quota-window ${quotaToneClass(percent)}`}
                                  style={{ '--quota-percent': `${percent ?? 0}%` }}
                                >
                                  <div className="quota-window-meta">
                                    <span>{quotaWindow.label}</span>
                                    <strong>{formatQuotaPercent(quotaWindow)}</strong>
                                  </div>
                                  <div className="quota-bar">
                                    <span />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="quota-account-message"
                            onClick={accountStatus === 'failed' ? refreshCodexQuota : undefined}
                          >
                            {accountStatus === 'disabled' ? '已停用' : `${account.error || '查询失败'}，点击刷新重试`}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : null}
                {!quotaLoading && !quotaError && quotaLoaded && !quotaAccounts.length ? (
                  <div className="quota-empty">暂无 Codex 凭证</div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="settings-entry" onClick={() => setDrawerView('settings')}>
            <span>
              <Settings size={18} />
              设置
            </span>
            <ChevronRight size={17} />
          </button>
        </section>
      </aside>
    </>
  );
}

