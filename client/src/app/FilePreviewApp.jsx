import { ArrowLeft, Check, Code2, Copy, ExternalLink, FileText, Minus, Plus, RefreshCw, Save, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api.js';
import { MarkdownContent } from '../chat/MarkdownContent.jsx';
import { copyTextToClipboard } from '../utils/clipboard.js';
import { THEME_KEY } from './AppState.js';
import { PdfPreview } from './PdfPreview.jsx';
import { resolvePwaTheme } from './pwa-theme.js';
import { compactPath, localFileApiPath } from './session-utils.js';

function fileNameFromPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return normalized.split('/').filter(Boolean).pop() || '文件预览';
}

function previewKind(pathValue, contentType) {
  const lowerType = String(contentType || '').toLowerCase();
  const lowerPath = String(pathValue || '').toLowerCase();
  if (lowerType.includes('pdf') || /\.pdf(?:$|[:?#])/i.test(lowerPath)) {
    return 'pdf';
  }
  if (
    lowerType.includes('markdown') ||
    /\.(?:md|markdown)(?:$|[:?#])/i.test(lowerPath)
  ) {
    return 'markdown';
  }
  if (lowerType.startsWith('text/') || /\.(?:txt|csv|json|log|xml|html?|js|jsx|ts|tsx|css)(?:$|[:?#])/i.test(lowerPath)) {
    return 'text';
  }
  return 'download';
}

function stripFrontmatter(value) {
  const text = String(value || '');
  if (!text.startsWith('---')) {
    return text;
  }
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trimStart();
}

function cleanMimeType(value, fallback = 'application/octet-stream') {
  return String(value || fallback).split(';')[0].trim() || fallback;
}

export default function FilePreviewApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const filePath = params.get('path') || '';
  const rawFileUrl = localFileApiPath(filePath);
  const [mode, setMode] = useState('rendered');
  const [fontScale, setFontScale] = useState(1);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [state, setState] = useState({
    loading: true,
    error: '',
    text: '',
    objectUrl: '',
    pdfData: null,
    contentType: '',
    mtimeMs: 0,
    editable: false
  });

  useEffect(() => {
    const theme = resolvePwaTheme(localStorage.getItem(THEME_KEY), window);
    const previousTheme = document.documentElement.dataset.theme;
    const previousBody = {
      position: document.body.style.position,
      inset: document.body.style.inset,
      overflow: document.body.style.overflow,
      touchAction: document.body.style.touchAction
    };
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.position = 'static';
    document.body.style.inset = 'auto';
    document.body.style.overflow = 'hidden';
    document.body.style.touchAction = 'pan-y';
    return () => {
      if (previousTheme) {
        document.documentElement.dataset.theme = previousTheme;
      } else {
        delete document.documentElement.dataset.theme;
      }
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.position = previousBody.position;
      document.body.style.inset = previousBody.inset;
      document.body.style.overflow = previousBody.overflow;
      document.body.style.touchAction = previousBody.touchAction;
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let objectUrl = '';

    async function loadFile() {
      if (!filePath) {
        setState({ loading: false, error: '缺少文件路径', text: '', objectUrl: '', pdfData: null, contentType: '', mtimeMs: 0, editable: false });
        return;
      }
      setState({ loading: true, error: '', text: '', objectUrl: '', pdfData: null, contentType: '', mtimeMs: 0, editable: false });
      try {
        const response = await fetch(localFileApiPath(filePath), { credentials: 'same-origin' });
        if (!response.ok) {
          const text = await response.text();
          let message = `Request failed: ${response.status}`;
          try {
            message = JSON.parse(text).error || message;
          } catch {
            message = text || message;
          }
          throw new Error(message);
        }
        const blob = await response.blob();
        if (stopped) {
          return;
        }
        const kind = previewKind(filePath, blob.type);
        const mtimeMs = Number(response.headers.get('x-local-file-mtime-ms') || 0);
        const editable = response.headers.get('x-local-file-editable') === '1';
        if (kind === 'markdown' || kind === 'text') {
          const text = await blob.text();
          if (!stopped) {
            setDraft(text);
            setState({ loading: false, error: '', text, objectUrl: '', pdfData: null, contentType: blob.type, mtimeMs, editable });
          }
          return;
        }
        if (kind === 'pdf') {
          const pdfData = await blob.arrayBuffer();
          setState({ loading: false, error: '', text: '', objectUrl: '', pdfData, contentType: blob.type, mtimeMs, editable: false });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ loading: false, error: '', text: '', objectUrl, contentType: blob.type, mtimeMs, editable: false });
      } catch (error) {
        if (!stopped) {
          setState({
            loading: false,
            error: error?.message || '文件读取失败',
            text: '',
            objectUrl: '',
            pdfData: null,
            contentType: '',
            mtimeMs: 0,
            editable: false
          });
        }
      }
    }

    loadFile();
    return () => {
      stopped = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [filePath]);

  const kind = previewKind(filePath, state.contentType);
  const title = fileNameFromPath(filePath);
  const subtitle = compactPath(filePath);
  const canRenderMarkdown = kind === 'markdown';
  const canEdit = state.editable && (kind === 'markdown' || kind === 'text');
  const canAdjustFont = kind === 'markdown' || kind === 'text';
  const editing = mode === 'edit';
  const markdownText = canRenderMarkdown ? stripFrontmatter(state.text) : state.text;

  async function handleCopyPath() {
    const ok = await copyTextToClipboard(filePath);
    if (!ok) {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function fileBlobForShare() {
    const type = cleanMimeType(state.contentType);
    if (state.pdfData) {
      return new Blob([state.pdfData], { type });
    }
    if (kind === 'markdown' || kind === 'text') {
      return new Blob([state.text], { type });
    }
    if (state.objectUrl) {
      const response = await fetch(state.objectUrl);
      return response.blob();
    }
    const response = await fetch(rawFileUrl, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.blob();
  }

  async function handleShareFile() {
    if (!filePath || state.loading || state.error || sharing) {
      return;
    }
    const fileUrl = new URL(rawFileUrl, window.location.href).href;
    setSharing(true);
    setNotice('');
    try {
      if (!navigator.share) {
        const copiedUrl = await copyTextToClipboard(fileUrl);
        setNotice(copiedUrl ? '当前环境不支持系统分享，已复制文件链接' : '当前环境不支持系统分享');
        window.setTimeout(() => setNotice(''), 1600);
        return;
      }
      const blob = await fileBlobForShare();
      const file = new File([blob], title, {
        type: cleanMimeType(blob.type || state.contentType),
        lastModified: state.mtimeMs || Date.now()
      });
      const payload = { title, files: [file] };
      if (!navigator.canShare || navigator.canShare(payload)) {
        await navigator.share(payload);
        return;
      }
      await navigator.share({ title, url: fileUrl });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setNotice(error?.message || '分享失败');
        window.setTimeout(() => setNotice(''), 1800);
      }
    } finally {
      setSharing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setNotice('');
    try {
      const result = await apiFetch(rawFileUrl, {
        method: 'PUT',
        body: {
          content: draft,
          baseMtimeMs: state.mtimeMs
        }
      });
      setState((current) => ({
        ...current,
        text: draft,
        mtimeMs: result.mtimeMs || current.mtimeMs
      }));
      setMode(canRenderMarkdown ? 'rendered' : 'raw');
      setNotice('已保存');
      window.setTimeout(() => setNotice(''), 1400);
    } catch (error) {
      setNotice(error?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="file-preview-page" style={{ '--preview-font-scale': fontScale }}>
      <header className="file-preview-header">
        <button type="button" className="file-preview-icon-button" onClick={() => window.history.back()} aria-label="返回">
          <ArrowLeft size={18} />
        </button>
        <div className="file-preview-title">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="file-preview-header-actions">
          <button type="button" className="file-preview-icon-button" onClick={handleCopyPath} aria-label="复制路径">
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            type="button"
            className="file-preview-icon-button"
            onClick={handleShareFile}
            disabled={sharing || state.loading || !!state.error}
            aria-label="分享文件"
          >
            <Share2 size={16} />
          </button>
          <button type="button" className="file-preview-icon-button" onClick={() => window.location.reload()} aria-label="刷新">
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {kind !== 'pdf' ? (
        <div className="file-preview-toolbar" aria-label="预览工具">
          {canRenderMarkdown ? (
            <div className="file-preview-segmented">
              <button type="button" className={mode === 'rendered' ? 'is-active' : ''} onClick={() => setMode('rendered')}>
                <FileText size={15} />
                <span>渲染</span>
              </button>
              <button type="button" className={mode === 'raw' ? 'is-active' : ''} onClick={() => setMode('raw')}>
                <Code2 size={15} />
                <span>原文</span>
              </button>
              {canEdit ? (
                <button type="button" className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}>
                  <Save size={15} />
                  <span>编辑</span>
                </button>
              ) : null}
            </div>
          ) : (
            <div className="file-preview-segmented">
              <button type="button" className={mode !== 'edit' ? 'is-active' : ''} onClick={() => setMode('raw')}>
                <Code2 size={15} />
                <span>{kind.toUpperCase()}</span>
              </button>
              {canEdit ? (
                <button type="button" className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}>
                  <Save size={15} />
                  <span>编辑</span>
                </button>
              ) : null}
            </div>
          )}
          <div className="file-preview-tool-buttons">
            {editing ? (
              <>
                <button type="button" onClick={handleSave} disabled={saving || draft === state.text} aria-label="保存">
                  <Save size={15} />
                </button>
                <button type="button" onClick={() => { setDraft(state.text); setMode(canRenderMarkdown ? 'rendered' : 'raw'); }} aria-label="取消编辑">
                  <X size={15} />
                </button>
              </>
            ) : null}
            {canAdjustFont ? (
              <>
                <button type="button" onClick={() => setFontScale((value) => Math.max(0.88, value - 0.06))} aria-label="缩小字号">
                  <Minus size={15} />
                </button>
                <button type="button" onClick={() => setFontScale((value) => Math.min(1.28, value + 0.06))} aria-label="放大字号">
                  <Plus size={15} />
                </button>
              </>
            ) : null}
            <a href={rawFileUrl} target="_blank" rel="noreferrer noopener" aria-label="打开原文件">
              <ExternalLink size={15} />
            </a>
          </div>
        </div>
      ) : null}

      <section className="file-preview-body">
        {notice ? <div className={`file-preview-notice ${notice === '已保存' ? 'is-success' : 'is-error'}`}>{notice}</div> : null}
        {state.loading ? <div className="file-preview-status">正在读取文件...</div> : null}
        {!state.loading && state.error ? (
          <div className="file-preview-error">
            <strong>{state.error}</strong>
            <span>{filePath || '未提供路径'}</span>
          </div>
        ) : null}
        {!state.loading && !state.error && kind === 'markdown' && mode === 'rendered' ? (
          <MarkdownContent text={markdownText} className="file-preview-markdown message-content" />
        ) : null}
        {!state.loading && !state.error && !editing && (kind === 'text' || (kind === 'markdown' && mode === 'raw')) ? (
          <pre className="file-preview-text">{state.text}</pre>
        ) : null}
        {!state.loading && !state.error && editing ? (
          <textarea
            className="file-preview-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
        ) : null}
        {!state.loading && !state.error && kind === 'pdf' && state.pdfData ? (
          <PdfPreview data={state.pdfData} fileUrl={rawFileUrl} />
        ) : null}
        {!state.loading && !state.error && kind === 'download' && state.objectUrl ? (
          <a className="file-preview-open" href={state.objectUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={16} />
            <span>打开文件</span>
          </a>
        ) : null}
      </section>
    </main>
  );
}
