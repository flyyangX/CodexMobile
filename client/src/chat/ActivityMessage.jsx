import { Bot, ChevronDown, FileText, Pencil, Search, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration, formatDurationMs } from '../app/session-utils.js';
import { conciseActivityDetail, isVisibleActivityStep } from './activity-model.js';
import { MarkdownContent } from './MarkdownContent.jsx';
import { ActivityFileSummary } from './ActivityFileSummary.jsx';
import { activityDetailText, activityTimeRange, buildActivityFileSummary, buildActivityTimeline } from './activity-timeline-model.js';

export function ActivityMessage({ message, now = Date.now() }) {
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const [open, setOpen] = useState(() => running);
  const activities = message.activities || [];
  const visibleSteps = activities.filter((activity) => isVisibleActivityStep(activity, message.status));
  const details = activityTimeRange(visibleSteps);
  const timeline = buildActivityTimeline(visibleSteps, running);
  const fileSummary = buildActivityFileSummary(visibleSteps);
  const startedAt = message.startedAt || details.startedAt || message.timestamp;
  const endedAt = running ? now : message.completedAt || details.endedAt || message.timestamp || now;
  const duration = !running ? formatDurationMs(message.durationMs) || formatDuration(startedAt, endedAt) : formatDuration(startedAt, endedAt);
  const headline = failed ? '处理失败' : running ? '处理中' : '已处理';

  useEffect(() => {
    setOpen(running);
  }, [message.id, running]);

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''}`}>
        <button
          type="button"
          className="activity-summary"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{duration ? `${headline} ${duration}` : headline}</span>
          <ChevronDown className={`activity-chevron ${open ? 'is-open' : ''}`} size={15} />
        </button>
        {open && (timeline.length || fileSummary) ? (
          <div className="activity-timeline" aria-label="任务进度">
            {timeline.map((item) =>
              item.type === 'text' ? (
                <MarkdownContent
                  key={item.id}
                  className="message-content activity-markdown activity-text"
                  text={item.text}
                />
              ) : item.type === 'live' ? (
                <div key={item.id} className={`activity-live is-${item.liveType || 'step'} ${item.status === 'running' ? 'is-running' : ''}`}>
                  <span className="activity-live-dot" />
                  <span>{item.text}</span>
                </div>
              ) : item.type === 'divider' ? (
                <div key={item.id} className="activity-divider">
                  <span>{item.text}</span>
                </div>
              ) : item.metaType === 'subagent' ? (
                <SubagentActivityBlock key={item.id} item={item} />
              ) : item.items.some((step) => activityDetailText(step)) ? (
                <details key={item.id} className={`activity-meta ${item.items.some((step) => step.status === 'running' || step.status === 'queued') ? 'is-running' : ''}`}>
                  <summary className="activity-meta-summary">
                    {activityMetaIcon(item)}
                    <span>{item.title}</span>
                  </summary>
                  <div className="activity-meta-body">
                    {item.items.filter((step) => activityDetailText(step)).map((step) => (
                      <ActivityStepDetail key={step.id} step={step} />
                    ))}
                  </div>
                </details>
              ) : (
                <div key={item.id} className={`activity-meta ${item.items.some((step) => step.status === 'running' || step.status === 'queued') ? 'is-running' : ''}`}>
                  <div className="activity-meta-summary">
                    {activityMetaIcon(item)}
                    <span>{item.title}</span>
                  </div>
                </div>
              )
            )}
            {fileSummary ? <ActivityFileSummary summary={fileSummary} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActivityStepDetail({ step }) {
  const detail = activityDetailText(step);
  const isCommand = step.type === 'command' || Boolean(step.command);
  if (isCommand) {
    const command = step.command || detail;
    const output = step.output || step.error || '';
    const failed = step.status === 'failed';
    const running = step.status === 'running';
    const title = `${failed ? '本地任务失败' : running ? '正在处理本地任务' : '本地任务已处理'} ${conciseActivityDetail(command, 110)}`;
    const shellText = [`$ ${command}`, output].filter(Boolean).join('\n\n');
    const statusText = failed && step.exitCode !== undefined && step.exitCode !== null
      ? `退出码 ${step.exitCode}`
      : failed
        ? '失败'
        : running
          ? '运行中'
          : '成功';
    return (
      <details className={`activity-command-detail ${failed ? 'is-failed' : ''}`} open={failed}>
        <summary>
          <span>{title}</span>
        </summary>
        <div className="activity-shell">
          <div className="activity-shell-head">Shell</div>
          <pre><code>{shellText}</code></pre>
          <div className="activity-shell-status">{statusText}</div>
        </div>
      </details>
    );
  }

  return (
    <div className="activity-meta-line">
      <MarkdownContent
        className="message-content activity-markdown activity-meta-label"
        text={step.label}
      />
      <MarkdownContent
        className="message-content activity-markdown activity-meta-detail"
        text={detail}
      />
    </div>
  );
}

function SubagentActivityBlock({ item }) {
  const agents = item.items.flatMap((step) => (Array.isArray(step.subAgents) ? step.subAgents : []));
  const title = item.items[0]?.label || item.title || `${agents.length || 1} 个后台智能体（使用 @ 标记智能体）`;
  return (
    <details className="activity-meta activity-subagents">
      <summary className="activity-meta-summary">
        <Bot size={13} />
        <span>{title}</span>
      </summary>
      <div className="activity-subagent-list">
        {agents.length ? agents.map((agent) => (
          <div key={agent.threadId || `${agent.nickname}-${agent.role}`} className="activity-subagent-row">
            <span>
              <strong>{agent.nickname || agent.threadId || '子代理'}</strong>
              {agent.role ? <small>({agent.role})</small> : null}
              <em>{agent.statusText || '打开'}</em>
            </span>
          </div>
        )) : (
          <div className="activity-subagent-row">
            <span><strong>{item.title}</strong></span>
          </div>
        )}
      </div>
    </details>
  );
}

function activityMetaIcon(item) {
  if (item.metaType === 'command') {
    return <Terminal size={13} />;
  }
  if (item.metaType === 'edit') {
    return <Pencil size={13} />;
  }
  if (item.metaType === 'search' || item.metaType === 'web_search') {
    return <Search size={13} />;
  }
  if (item.metaType === 'subagent') {
    return <Bot size={13} />;
  }
  return <FileText size={13} />;
}
