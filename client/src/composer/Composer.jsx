import { ArrowUp, Bot, Check, ChevronDown, FileText, Image, Loader2, MessageSquare, MessageSquarePlus, Paperclip, Plus, Search, Shield, Square, Terminal, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../api.js';
import { detectComposerToken, filteredSlashCommands, replaceComposerToken } from '../composer-shortcuts.js';
import { composerSendState } from '../send-state.js';
import { isDraftSession } from '../app/session-utils.js';
import { attachmentPreviewUrl, isImageAttachment } from './attachment-preview.js';
import { filesFromClipboardData } from './paste-files.js';
import { ContextStatusButton, ContextStatusDetails } from './ContextStatus.jsx';
import { DEFAULT_PERMISSION_MODE, MODEL_SPEED_OPTIONS, REASONING_OPTIONS, formatBytes, modelSpeedLabel, normalizeModelSpeed, permissionLabel, permissionOptionsForSecurity, reasoningLabel, selectedSkillSummary, shortModelName } from './composer-options.js';

export { DEFAULT_PERMISSION_MODE } from './composer-options.js';

export function Composer({
  composerRef,
  input,
  setInput,
  selectedProject,
  selectedSession,
  onSubmit,
  running,
  onAbort,
  models,
  selectedModel,
  onSelectModel,
  selectedModelSpeed,
  onSelectModelSpeed,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  skills,
  selectedSkillPaths,
  onToggleSkill,
  onSelectSkill,
  onClearSkills,
  permissionMode,
  onSelectPermission,
  attachments,
  onUploadFiles,
  onRemoveAttachment,
  fileMentions,
  onAddFileMention,
  onRemoveFileMention,
  uploading,
  contextStatus,
  runStatus,
  desktopBridge,
  security,
  queueDrafts,
  onRestoreQueueDraft,
  onRemoveQueueDraft,
  onSteerQueueDraft
}) {
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [skillFilter, setSkillFilter] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [fileSearch, setFileSearch] = useState({ query: '', loading: false, results: [] });
  const selectedFileMentions = Array.isArray(fileMentions) ? fileMentions : [];
  const hasInput = input.trim().length > 0 || attachments.length > 0 || selectedFileMentions.length > 0;
  const modelList = models?.length ? models : [{ value: selectedModel || 'gpt-5.5', label: selectedModel || 'gpt-5.5' }];
  const selectedModelLabel = modelList.find((model) => model.value === selectedModel)?.label || selectedModel || 'gpt-5.5';
  const normalizedModelSpeed = normalizeModelSpeed(selectedModelSpeed);
  const skillList = Array.isArray(skills) ? skills : [];
  const selectedSkillSet = new Set(Array.isArray(selectedSkillPaths) ? selectedSkillPaths : []);
  const selectedSkills = skillList.filter((skill) => selectedSkillSet.has(skill.path));
  const permissionOptions = permissionOptionsForSecurity(security);
  const composerToken = useMemo(
    () => detectComposerToken(input, cursorPosition || input.length),
    [input, cursorPosition]
  );
  const slashMatches = composerToken?.type === 'slash'
    ? filteredSlashCommands(composerToken.query)
    : [];
  const tokenSkillMatches = composerToken?.type === 'skill'
    ? skillList
      .filter((skill) => {
        const query = composerToken.query.trim().toLowerCase();
        if (!query) {
          return true;
        }
        return [skill.label, skill.name, skill.description, skill.path]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .slice(0, 12)
    : [];
  const sendState = composerSendState({
    running,
    hasInput,
    uploading,
    desktopBridge,
    steerable: runStatus?.steerable !== false,
    sessionIsDraft: isDraftSession(selectedSession)
  });
  const stopMode = sendState.mode === 'abort';
  const runningInputMode = running && hasInput;
  const sendLabel = sendState.label;
  const filteredSkills = skillList.filter((skill) => {
    const query = skillFilter.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return [skill.label, skill.name, skill.description, skill.path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  useEffect(() => {
    if (composerToken?.type !== 'file' || !selectedProject?.id) {
      setFileSearch({ query: '', loading: false, results: [] });
      return undefined;
    }

    const query = composerToken.query || '';
    let cancelled = false;
    setFileSearch((current) => ({ ...current, query, loading: true }));
    const timer = window.setTimeout(() => {
      apiFetch(`/api/files/search?projectId=${encodeURIComponent(selectedProject.id)}&q=${encodeURIComponent(query)}`)
        .then((result) => {
          if (!cancelled) {
            setFileSearch({ query, loading: false, results: Array.isArray(result.files) ? result.files : [] });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFileSearch({ query, loading: false, results: [] });
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composerToken?.type, composerToken?.query, selectedProject?.id]);

  function updateCursorFromTextarea() {
    const textarea = textareaRef.current;
    setCursorPosition(textarea?.selectionStart ?? input.length);
  }

  function replaceCurrentToken(replacement) {
    if (!composerToken) {
      return;
    }
    const next = replaceComposerToken(input, composerToken, replacement);
    setInput(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const position = Math.min(next.length, composerToken.start + String(replacement || '').length);
      textareaRef.current?.setSelectionRange(position, position);
      setCursorPosition(position);
    });
  }

  function runSlashCommand(command) {
    replaceCurrentToken(command.prompt ? `${command.prompt} ` : '');
    if (command.action === 'open-context') {
      setOpenMenu('context');
    } else {
      setOpenMenu(null);
    }
  }

  function selectTokenSkill(skill) {
    if (skill?.path) {
      onSelectSkill(skill.path);
    }
    replaceCurrentToken('');
    setOpenMenu(null);
  }

  function selectTokenFile(file) {
    if (!file?.path) {
      return;
    }
    onAddFileMention(file);
    replaceCurrentToken(`@${file.relativePath || file.name} `);
    setOpenMenu(null);
  }

  function submit(event) {
    event.preventDefault();
    if (stopMode) {
      onAbort();
      return;
    }
    if (runningInputMode) {
      setOpenMenu((current) => (current === 'send-mode' ? null : 'send-mode'));
      return;
    }
    if (hasInput) {
      onSubmit({ mode: 'start' });
      setOpenMenu(null);
    }
  }

  function toggleMenu(name) {
    setOpenMenu((current) => (current === name ? null : name));
    if (name !== 'skill') {
      setSkillFilter('');
    }
  }

  function handleFiles(event, kind) {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      onUploadFiles(files, kind);
    }
    event.target.value = '';
    setOpenMenu(null);
  }

  function handlePaste(event) {
    const files = filesFromClipboardData(event.clipboardData);
    if (!files.length) {
      return;
    }
    const text = event.clipboardData?.getData?.('text') || '';
    if (!text) {
      event.preventDefault();
    }
    onUploadFiles(files, 'paste');
    setOpenMenu(null);
  }

  const tokenPanelOpen = !openMenu && composerToken && (
    (composerToken.type === 'slash' && slashMatches.length > 0) ||
    (composerToken.type === 'skill') ||
    (composerToken.type === 'file')
  );

  return (
    <form className="composer-wrap" ref={composerRef} onSubmit={submit}>
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => handleFiles(event, 'image')}
      />
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => handleFiles(event, 'file')}
      />
      {openMenu === 'attach' ? (
        <div className="composer-menu attach-menu">
          <button type="button" onClick={() => imageInputRef.current?.click()}>
            <Image size={17} />
            相册
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            <FileText size={17} />
            文件
          </button>
        </div>
      ) : null}
      {openMenu === 'permission' ? (
        <div className="composer-menu permission-menu">
          {permissionOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${permissionMode === option.value ? 'is-selected' : ''} ${option.danger ? 'is-danger' : ''}`}
              onClick={() => {
                onSelectPermission(option.value);
                setOpenMenu(null);
              }}
            >
              {permissionMode === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'skill' ? (
        <div className="composer-menu skill-menu">
          <div className="skill-search-wrap">
            <Search size={14} />
            <input
              type="search"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              placeholder="搜索 skill"
              aria-label="搜索 skill"
            />
          </div>
          {selectedSkills.length ? (
            <button type="button" className="skill-clear-button" onClick={onClearSkills}>
              <span className="menu-spacer" />
              <span>不指定 skill</span>
            </button>
          ) : null}
          {filteredSkills.length ? (
            filteredSkills.map((skill) => {
              const selected = selectedSkillSet.has(skill.path);
              return (
                <button
                  key={skill.path}
                  type="button"
                  className={`skill-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => onToggleSkill(skill.path)}
                >
                  {selected ? <Check size={16} /> : <span className="menu-spacer" />}
                  <span>
                    <strong>{skill.label || skill.name}</strong>
                    {skill.description ? <small>{skill.description}</small> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="menu-empty">{skillList.length ? '没有匹配的 skill' : 'skill 列表还没加载'}</div>
          )}
        </div>
      ) : null}
      {openMenu === 'model' ? (
        <div className="composer-menu model-menu">
          <div className="menu-section-label">模型</div>
          {modelList.map((model) => (
            <button
              key={model.value}
              type="button"
              className={selectedModel === model.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectModel(model.value);
                setOpenMenu(null);
              }}
            >
              {selectedModel === model.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{model.label}</span>
            </button>
          ))}
          <div className="menu-divider" />
          <div className="menu-section-label">智能</div>
          {REASONING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={selectedReasoningEffort === option.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectReasoningEffort(option.value);
                setOpenMenu(null);
              }}
            >
              {selectedReasoningEffort === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{option.label}</span>
            </button>
          ))}
          <div className="menu-divider" />
          <div className="menu-section-label">速度</div>
          {MODEL_SPEED_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={normalizedModelSpeed === option.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectModelSpeed?.(option.value);
                setOpenMenu(null);
              }}
            >
              {normalizedModelSpeed === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              {option.value === 'fast' ? <Zap size={15} /> : null}
              <span className="menu-item-main">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'context' ? (
        <div className="context-popover" role="status">
          <ContextStatusDetails contextStatus={contextStatus} />
        </div>
      ) : null}
      {tokenPanelOpen ? (
        <div className="composer-menu shortcut-menu" role="listbox">
          {composerToken.type === 'slash' ? (
            slashMatches.map((command) => (
              <button key={command.id} type="button" onClick={() => runSlashCommand(command)}>
                <Terminal size={16} />
                <span>
                  <strong>{command.title}</strong>
                  <small>{command.aliases.join(' ')}</small>
                </span>
              </button>
            ))
          ) : null}
          {composerToken.type === 'skill' ? (
            tokenSkillMatches.length ? tokenSkillMatches.map((skill) => (
              <button key={skill.path} type="button" onClick={() => selectTokenSkill(skill)}>
                {selectedSkillSet.has(skill.path) ? <Check size={16} /> : <Bot size={16} />}
                <span>
                  <strong>{skill.label || skill.name}</strong>
                  {skill.description ? <small>{skill.description}</small> : null}
                </span>
              </button>
            )) : <div className="menu-empty">{skillList.length ? '没有匹配的 skill' : 'skill 列表还没加载'}</div>
          ) : null}
          {composerToken.type === 'file' ? (
            fileSearch.loading ? (
              <div className="menu-empty"><Loader2 className="spin" size={15} /> 正在搜索文件</div>
            ) : fileSearch.results.length ? fileSearch.results.map((file) => (
              <button key={file.path} type="button" onClick={() => selectTokenFile(file)}>
                <FileText size={16} />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.relativePath}</small>
                </span>
              </button>
            )) : <div className="menu-empty">没有匹配的文件</div>
          ) : null}
        </div>
      ) : null}
      {queueDrafts?.length ? (
        <div className="queued-drafts-panel" aria-label="排队消息">
          {queueDrafts.map((draft) => (
            <div key={draft.id} className="queued-draft-row">
              <MessageSquarePlus size={15} />
              <button type="button" className="queued-draft-text" onClick={() => onRestoreQueueDraft(draft.id)}>
                <strong>{draft.text || '请查看附件。'}</strong>
                <small>{draft.selectedSkills?.length ? `${draft.selectedSkills.length} skills` : '排队中'}</small>
              </button>
              <div className="queued-draft-actions">
                <button type="button" onClick={() => onSteerQueueDraft(draft.id)} aria-label="立即发送到当前任务">
                  <MessageSquare size={14} />
                </button>
                <button type="button" onClick={() => onRemoveQueueDraft(draft.id)} aria-label="删除排队消息">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {runStatus ? (
        <div className="composer-run-status is-running" role="status" aria-live="polite">
          <span className="composer-run-dot" />
          <span className="composer-run-main">
            <strong>Codex 正在处理</strong>
            <small>{runStatus.label}</small>
          </span>
          {runStatus.duration ? <span className="composer-run-time">{runStatus.duration}</span> : null}
        </div>
      ) : null}
      {!sendState.disabled || sendState.mode !== 'unavailable' ? null : (
        <div className="composer-run-status is-warning" role="status" aria-live="polite">
          <span className="composer-run-dot" />
          <span className="composer-run-main">
            <strong>桌面端 Codex 未连接</strong>
            <small>{desktopBridge?.reason || '打开桌面端 Codex，或配置同源 app-server control socket 后再发送'}</small>
          </span>
        </div>
      )}
      {openMenu === 'send-mode' ? (
        <div className="composer-menu send-mode-menu">
          <button
            type="button"
            disabled={!sendState.canSteer}
            onClick={() => {
              if (!sendState.canSteer) {
                return;
              }
              onSubmit({ mode: 'steer' });
              setOpenMenu(null);
            }}
          >
            <MessageSquare size={16} />
            <span>
              <strong>发送到当前任务</strong>
              <small>{sendState.canSteer ? '直接补充给桌面端正在执行的任务' : '当前任务暂时不能接收补充消息'}</small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              onSubmit({ mode: 'queue' });
              setOpenMenu(null);
            }}
          >
            <MessageSquarePlus size={16} />
            <span>
              <strong>加入队列</strong>
              <small>当前任务结束后自动发送</small>
            </span>
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              onSubmit({ mode: 'interrupt' });
              setOpenMenu(null);
            }}
          >
            <Square size={15} />
            <span>
              <strong>中止并发送</strong>
              <small>停下当前任务，用这条消息重新引导</small>
            </span>
          </button>
        </div>
      ) : null}
      <div className="composer">
        {attachments.length || selectedFileMentions.length ? (
          <div className="attachment-tray">
            {attachments.map((attachment) => {
              if (isImageAttachment(attachment)) {
                const previewUrl = attachmentPreviewUrl(attachment);
                return (
                  <span key={attachment.id} className="attachment-preview-card">
                    {previewUrl ? (
                      <img src={previewUrl} alt={attachment.name || '图片附件'} loading="lazy" />
                    ) : (
                      <span className="attachment-preview-empty"><Image size={18} /></span>
                    )}
                    <span className="attachment-preview-meta">
                      <span>{attachment.name || '图片'}</span>
                      <small>{formatBytes(attachment.size)}</small>
                    </span>
                    <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除图片">
                      <Trash2 size={13} />
                    </button>
                  </span>
                );
              }
              return (
                <span key={attachment.id} className="attachment-chip">
                  <Paperclip size={14} />
                  <span>{attachment.name}</span>
                  <small>{formatBytes(attachment.size)}</small>
                  <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除附件">
                    <Trash2 size={13} />
                  </button>
                </span>
              );
            })}
            {selectedFileMentions.map((file) => (
              <span key={file.path} className="attachment-chip file-mention-chip">
                <FileText size={14} />
                <span>{file.relativePath || file.name}</span>
                <button type="button" onClick={() => onRemoveFileMention(file.path)} aria-label="移除文件引用">
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setCursorPosition(event.target.selectionStart ?? event.target.value.length);
          }}
          onClick={updateCursorFromTextarea}
          onKeyUp={updateCursorFromTextarea}
          onFocus={() => setOpenMenu(null)}
          onPaste={handlePaste}
          placeholder="给 Codex 发送消息"
        />
        <div className="composer-controls">
          <button
            type="button"
            className="composer-attach"
            aria-label="添加附件"
            onClick={() => toggleMenu('attach')}
            disabled={uploading}
          >
            <Plus size={18} />
          </button>
          <div className="composer-tool-strip" role="toolbar" aria-label="发送选项">
            <button
              type="button"
              className={`composer-tool-icon ${permissionMode === 'bypassPermissions' ? 'is-permission-bypass' : ''}`}
              onClick={() => toggleMenu('permission')}
              title={permissionLabel(permissionMode)}
              aria-label={`权限：${permissionLabel(permissionMode)}`}
            >
              <Shield size={17} strokeWidth={1.85} />
            </button>
            <button
              type="button"
              className="composer-tool-icon composer-tool-skills"
              data-count={selectedSkills.length > 0 ? String(selectedSkills.length) : undefined}
              onClick={() => toggleMenu('skill')}
              title={selectedSkillSummary(selectedSkills)}
              aria-label={`技能：${selectedSkillSummary(selectedSkills)}`}
            >
              <Bot size={17} strokeWidth={1.85} />
            </button>
            <ContextStatusButton
              variant="compact"
              contextStatus={contextStatus}
              open={openMenu === 'context'}
              onToggle={() => toggleMenu('context')}
            />
            <button type="button" className="model-chip" onClick={() => toggleMenu('model')} title={`${selectedModelLabel} · ${reasoningLabel(selectedReasoningEffort)}`}>
              <span className="model-chip-text">
                <span className="model-chip-name">{shortModelName(selectedModelLabel)}</span>
                <span className="model-chip-dot" aria-hidden="true" />
                <span className="model-chip-reason">{reasoningLabel(selectedReasoningEffort)}</span>
                {normalizedModelSpeed === 'fast' ? (
                  <>
                    <span className="model-chip-dot" aria-hidden="true" />
                    <span className="model-chip-speed">{modelSpeedLabel(normalizedModelSpeed)}</span>
                  </>
                ) : null}
              </span>
              <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <button
            type="submit"
            className={`send-button ${stopMode ? 'is-running' : ''} ${runningInputMode ? 'is-queueing' : ''}`}
            disabled={sendState.disabled}
            aria-label={sendLabel}
            title={sendLabel}
          >
            {stopMode ? <Square size={15} /> : uploading ? <Loader2 className="spin" size={16} /> : <ArrowUp size={17} strokeWidth={2.25} />}
          </button>
        </div>
      </div>
    </form>
  );
}
