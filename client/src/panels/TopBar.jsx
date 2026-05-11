import { Bell, Check, Copy, FileText, GitBranch, GitCommitHorizontal, Menu, MoreHorizontal, RefreshCw, Shield, UploadCloud, Wifi } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../utils/clipboard.js';
import { isDraftSession } from '../app/session-utils.js';
import { FeishuLogoIcon } from './DocsPanel.jsx';
import { bridgeConnectionLabel } from './topbar-status.js';

export { bridgeConnectionLabel } from './topbar-status.js';

export function TopBar({
  selectedProject,
  selectedSession,
  connectionState,
  desktopBridge,
  selectedRuntime,
  onMenu,
  onOpenDocs,
  onOpenSecurity,
  onGitAction,
  notificationSupported,
  notificationEnabled,
  onEnableNotifications,
  gitDisabled = false
}) {
  const status = bridgeConnectionLabel(connectionState, desktopBridge, { selectedSession, selectedRuntime });
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedThreadId, setCopiedThreadId] = useState(false);
  const menuRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const canCopyThreadId = Boolean(selectedSession?.id && !isDraftSession(selectedSession));
  const projectId = selectedProject?.id || '';
  const title = selectedSession?.title || selectedProject?.name || 'CodexMobile';

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    function closeMenu(event) {
      if (!menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [menuOpen]);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  function handleGitAction(action) {
    setMenuOpen(false);
    onGitAction?.(action);
  }

  async function handleCopyThreadId() {
    if (!canCopyThreadId) {
      return;
    }
    const copied = await copyTextToClipboard(selectedSession.id);
    if (!copied) {
      window.alert('复制失败');
      return;
    }
    setCopiedThreadId(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopiedThreadId(false), 1400);
  }

  function handleOpenDocs() {
    setMenuOpen(false);
    onOpenDocs?.();
  }

  function handleOpenSecurity() {
    setMenuOpen(false);
    onOpenSecurity?.();
  }

  function handleEnableNotifications() {
    setMenuOpen(false);
    onEnableNotifications?.();
  }

  return (
    <header className="top-bar">
      <button className="icon-button" onClick={onMenu} aria-label="打开菜单">
        <Menu size={22} />
      </button>
      <div className="top-title">
        <strong>{title}</strong>
        <span className={`connection-status ${status.className}`} title={status.description} aria-label={status.description || status.label}>
          <Wifi size={13} />
          {status.label}
        </span>
      </div>
      <div className="top-actions">
        <div className="top-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="更多操作"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={22} />
          </button>
          {menuOpen ? (
            <div className="top-menu-popover" role="menu" aria-label="更多操作">
              <div className="top-menu-title">
                <MoreHorizontal size={16} />
                <span>更多</span>
              </div>
              <button type="button" role="menuitem" onClick={handleCopyThreadId} disabled={!canCopyThreadId}>
                {copiedThreadId ? <Check size={16} /> : <Copy size={16} />}
                <span>{copiedThreadId ? '已复制对话 ID' : '复制对话 ID'}</span>
              </button>
              <button type="button" role="menuitem" onClick={handleOpenDocs}>
                <FeishuLogoIcon size={18} className="top-docs-logo" />
                <span>飞书文档</span>
              </button>
              <button type="button" role="menuitem" onClick={handleEnableNotifications}>
                <Bell size={16} />
                <span>{notificationEnabled ? '完成通知已开启' : '开启完成通知'}</span>
              </button>
              <button type="button" role="menuitem" onClick={handleOpenSecurity}>
                <Shield size={16} />
                <span>安全设备</span>
              </button>
              <div className="top-menu-divider" />
              <div className="top-menu-title">
                <GitBranch size={16} />
                <span>Git</span>
              </div>
              <button type="button" role="menuitem" onClick={() => handleGitAction('status')} disabled={gitDisabled}>
                <FileText size={16} />
                <span>查看状态</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('diff')} disabled={gitDisabled}>
                <FileText size={16} />
                <span>查看 diff</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('pull')} disabled={gitDisabled}>
                <RefreshCw size={16} />
                <span>拉取</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('sync')} disabled={gitDisabled}>
                <RefreshCw size={16} />
                <span>同步</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('commit')} disabled={gitDisabled}>
                <GitCommitHorizontal size={16} />
                <span>提交</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('push')} disabled={gitDisabled}>
                <UploadCloud size={16} />
                <span>推送</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('commit-push')} disabled={gitDisabled}>
                <UploadCloud size={16} />
                <span>提交并推送</span>
              </button>
              <button type="button" role="menuitem" onClick={() => handleGitAction('branches')} disabled={gitDisabled || !projectId}>
                <GitBranch size={16} />
                <span>分支管理</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
