import { Check, ChevronLeft, FileText, GitBranch, GitCommitHorizontal, Loader2, RefreshCw, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

function gitActionTitle(action) {
  if (action === 'status') {
    return 'Git 面板';
  }
  if (action === 'diff') {
    return 'Git Diff';
  }
  if (action === 'sync') {
    return 'Git 同步';
  }
  if (action === 'commit-push') {
    return '提交并推送';
  }
  if (action === 'commit') {
    return 'Git 提交';
  }
  if (action === 'push') {
    return 'Git 推送';
  }
  if (action === 'branch') {
    return '创建分支';
  }
  return 'Git';
}

function gitBranchDraft(project) {
  const name = String(project?.name || 'changes')
    .trim()
    .toLowerCase()
    .replace(/^codex\//, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return `codex/${name || 'changes'}`;
}

function gitViewFromAction(action) {
  if (action === 'commit' || action === 'commit-push') {
    return 'commit';
  }
  if (action === 'branch') {
    return 'branch';
  }
  if (action === 'push' || action === 'sync') {
    return 'sync';
  }
  if (action === 'diff') {
    return 'diff';
  }
  return 'status';
}

function gitSafetyWarnings(status = {}) {
  const warnings = [];
  const files = Array.isArray(status.files) ? status.files : [];
  if (files.length) {
    warnings.push(`工作区有 ${files.length} 个改动文件`);
  }
  if (status.behind > 0) {
    warnings.push(`落后远端 ${status.behind} 个提交，pull/sync 会先尝试快进`);
  }
  if (status.branch && !String(status.branch).startsWith('codex/')) {
    warnings.push('当前不是 codex/ 分支，操作前请确认分支用途');
  }
  if (status.branch && !status.upstream) {
    warnings.push('当前分支没有 upstream，push 会设置 origin upstream');
  }
  if (!status.clean && status.behind > 0) {
    warnings.push('本地有改动且落后远端，pull 可能失败并保留 Git 原始输出');
  }
  return warnings;
}

export function GitPanel({ open, action, project, onClose, onToast }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [diff, setDiff] = useState(null);
  const [activeView, setActiveView] = useState(() => gitViewFromAction(action));
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');

  const projectId = project?.id || '';
  const title = gitActionTitle(activeView === 'status' ? 'status' : activeView);
  const files = Array.isArray(status?.files) ? status.files : [];
  const canCommit = Boolean(status?.canCommit);
  const canPush = Boolean(status?.branch);
  const safetyWarnings = gitSafetyWarnings(status || {});

  const loadGitStatus = useCallback(async () => {
    if (!open || !projectId) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
      const nextStatus = data.status || null;
      setStatus(nextStatus);
      setCommitMessage((current) => current || nextStatus?.defaultCommitMessage || '');
      setBranchName((current) => current || gitBranchDraft(project));
    } catch (loadError) {
      setError(loadError.message || '读取 Git 状态失败');
    } finally {
      setBusy(false);
    }
  }, [open, projectId, project]);

  const loadGitDiff = useCallback(async () => {
    if (!open || !projectId) {
      return;
    }
    setBusy(true);
    setBusyAction('diff');
    setError('');
    try {
      const data = await apiFetch(`/api/git/diff?projectId=${encodeURIComponent(projectId)}`);
      setDiff(data.diff || null);
      if (data.diff?.status) {
        setStatus(data.diff.status);
      }
    } catch (loadError) {
      setError(loadError.message || '读取 Git diff 失败');
    } finally {
      setBusy(false);
      setBusyAction('');
    }
  }, [open, projectId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setResult(null);
    setDiff(null);
    setActiveView(gitViewFromAction(action));
    setCommitMessage('');
    setBranchName('');
    loadGitStatus();
  }, [open, action, projectId, loadGitStatus]);

  useEffect(() => {
    if (open && activeView === 'diff' && !diff && !busy) {
      loadGitDiff();
    }
  }, [open, activeView, diff, busy, loadGitDiff]);

  if (!open) {
    return null;
  }

  async function runGitAction(nextAction = action) {
    if (!projectId || busy) {
      return;
    }
    setBusy(true);
    setBusyAction(nextAction);
    setError('');
    setResult(null);
    onToast?.({ level: 'info', title: gitActionTitle(nextAction), body: '正在执行 Git 操作...' });
    try {
      let data = null;
      if (nextAction === 'commit') {
        data = await apiFetch('/api/git/commit', {
          method: 'POST',
          body: { projectId, message: commitMessage }
        });
      } else if (nextAction === 'commit-push') {
        data = await apiFetch('/api/git/commit-push', {
          method: 'POST',
          body: { projectId, message: commitMessage }
        });
      } else if (nextAction === 'push') {
        data = await apiFetch('/api/git/push', {
          method: 'POST',
          body: { projectId }
        });
      } else if (nextAction === 'pull') {
        data = await apiFetch('/api/git/pull', {
          method: 'POST',
          body: { projectId }
        });
      } else if (nextAction === 'sync') {
        data = await apiFetch('/api/git/sync', {
          method: 'POST',
          body: { projectId }
        });
      } else if (nextAction === 'branch') {
        data = await apiFetch('/api/git/branch', {
          method: 'POST',
          body: { projectId, branchName }
        });
      }
      setResult(data || {});
      setStatus(data?.status || status);
      if (data?.status?.defaultCommitMessage) {
        setCommitMessage(data.status.defaultCommitMessage);
      }
      onToast?.({ level: 'success', title: gitActionTitle(nextAction), body: 'Git 操作已完成' });
    } catch (runError) {
      setError(runError.message || 'Git 操作失败');
      onToast?.({ level: 'error', title: gitActionTitle(nextAction), body: runError.message || 'Git 操作失败' });
    } finally {
      setBusy(false);
      setBusyAction('');
    }
  }

  const commitDisabled = busy || !projectId || !canCommit || !commitMessage.trim();
  const pushDisabled = busy || !projectId || !canPush;
  const branchDisabled = busy || !projectId || !branchName.trim();

  return (
    <section className="docs-panel git-panel" role="dialog" aria-modal="true" aria-label={title}>
      <header className="docs-panel-header">
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭 Git">
          <ChevronLeft size={22} />
        </button>
        <div className="docs-panel-title">
          <strong>{title}</strong>
          <span>{status?.branch || project?.name || 'Git'}</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭 Git">
          <X size={20} />
        </button>
      </header>
      <div className="docs-panel-body git-panel-body">
        <div className="git-tabs" role="tablist" aria-label="Git 操作">
          {[
            ['status', '状态'],
            ['diff', 'Diff'],
            ['sync', '同步'],
            ['commit', '提交'],
            ['branch', '分支']
          ].map(([view, label]) => (
            <button
              key={view}
              type="button"
              className={activeView === view ? 'is-active' : ''}
              onClick={() => setActiveView(view)}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="git-status-card">
          <div className="git-status-head">
            <div>
              <strong>{status?.clean ? '工作区干净' : '当前改动'}</strong>
              <span>
                {status?.branch || '未读取'}
                {status?.upstream ? ` -> ${status.upstream}` : ''}
              </span>
            </div>
            <button type="button" className="icon-button" onClick={loadGitStatus} disabled={busy} aria-label="刷新 Git 状态">
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="git-status-metrics">
            <span>{files.length} 个文件</span>
            <span>ahead {status?.ahead || 0}</span>
            <span>behind {status?.behind || 0}</span>
          </div>
          {files.length ? (
            <div className="git-file-list">
              {files.slice(0, 18).map((file) => (
                <div key={`${file.status}:${file.path}`}>
                  <code>{file.status}</code>
                  <span>{file.path}</span>
                </div>
              ))}
              {files.length > 18 ? <small>还有 {files.length - 18} 个文件</small> : null}
            </div>
          ) : null}
          {safetyWarnings.length ? (
            <div className="git-safety-list">
              {safetyWarnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          ) : null}
        </section>

        {activeView === 'diff' ? (
          <section className="git-diff-card">
            <div className="git-section-head">
              <strong>Diff 预览</strong>
              <button type="button" onClick={loadGitDiff} disabled={busy}>
                {busyAction === 'diff' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                刷新
              </button>
            </div>
            {diff?.summary ? <pre className="git-diff-summary">{diff.summary}</pre> : null}
            <pre className="git-diff-pre">{diff?.patch || (busyAction === 'diff' ? '正在读取 diff...' : '暂无 diff')}</pre>
            {diff?.truncated ? <small className="git-diff-note">diff 太长，已截断显示。</small> : null}
          </section>
        ) : null}

        {activeView === 'sync' ? (
          <section className="git-action-card">
            <div className="git-section-head">
              <strong>同步操作</strong>
              <span>pull 使用 --ff-only，sync 会 pull 后按需 push</span>
            </div>
            <div className="git-action-grid">
              <button type="button" onClick={() => runGitAction('pull')} disabled={busy || !projectId}>
                {busyAction === 'pull' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                Pull
              </button>
              <button type="button" onClick={() => runGitAction('sync')} disabled={busy || !projectId}>
                {busyAction === 'sync' ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                Sync
              </button>
              <button type="button" onClick={() => runGitAction('push')} disabled={pushDisabled}>
                {busyAction === 'push' ? <Loader2 className="spin" size={15} /> : <UploadCloud size={15} />}
                Push
              </button>
            </div>
          </section>
        ) : null}

        {activeView === 'commit' ? (
          <label className="git-field">
            <span>提交信息</span>
            <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
          </label>
        ) : null}

        {activeView === 'commit' ? (
          <div className="git-action-grid">
            <button type="button" onClick={() => runGitAction('commit')} disabled={commitDisabled}>
              {busyAction === 'commit' ? <Loader2 className="spin" size={15} /> : <GitCommitHorizontal size={15} />}
              提交
            </button>
            <button type="button" onClick={() => runGitAction('commit-push')} disabled={commitDisabled}>
              {busyAction === 'commit-push' ? <Loader2 className="spin" size={15} /> : <UploadCloud size={15} />}
              提交并推送
            </button>
          </div>
        ) : null}

        {activeView === 'branch' ? (
          <label className="git-field">
            <span>分支名</span>
            <input value={branchName} onChange={(event) => setBranchName(event.target.value)} />
          </label>
        ) : null}

        {activeView === 'branch' ? (
          <div className="git-action-grid">
            <button type="button" onClick={() => runGitAction('branch')} disabled={branchDisabled}>
              {busyAction === 'branch' ? <Loader2 className="spin" size={15} /> : <GitBranch size={15} />}
              创建分支
            </button>
          </div>
        ) : null}

        {error ? <div className="docs-panel-error">{error}</div> : null}
        {result ? (
          <div className="git-result">
            <Check size={17} />
            <span>
              {action === 'commit' && result.hash ? `已提交 ${result.hash}` : null}
              {result.hash && action !== 'commit' ? `已提交 ${result.hash}` : null}
              {result.branch || result.pushed?.branch ? `已更新 ${result.branch || result.pushed?.branch}` : null}
              {!result.hash && !result.branch && !result.pushed?.branch ? 'Git 操作已完成' : null}
            </span>
          </div>
        ) : null}
        {result?.output ? <pre className="git-output">{result.output}</pre> : null}

        <div className="docs-panel-actions git-panel-actions">
          <button type="button" onClick={loadGitStatus} disabled={busy}>
            <RefreshCw size={16} />
            刷新状态
          </button>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </section>
  );
}
