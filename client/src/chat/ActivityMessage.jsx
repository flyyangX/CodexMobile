import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration, formatDurationMs } from '../app/session-utils.js';
import { activityCardShouldOpen } from './activity-card-state.js';
import { isVisibleActivityStep, shouldRenderActivityMessageInChat } from './activity-model.js';
import { ActivityTimeline } from './ActivityTimeline.jsx';
import { projectActivityView } from './activity-timeline-projection.js';

function hasPendingPlanImplementation(activities = []) {
  return activities.some((activity) =>
    activity?.kind === 'plan_implementation' &&
    activity.planImplementation &&
    !activity.planImplementation.completed
  );
}

export function ActivityMessage({ message, now = Date.now(), onImplementPlan }) {
  if (!shouldRenderActivityMessageInChat(message)) {
    return null;
  }
  const activities = message.activities || [];
  const pendingPlanImplementation = hasPendingPlanImplementation(activities);
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const visibleSteps = activities.filter((activity) => isVisibleActivityStep(activity, message.status));
  const { timeRange, timeline, fileSummary } = projectActivityView(visibleSteps, { running });
  const hasProcess = timeline.length > 0 || Boolean(fileSummary);
  const failureDetail = failed ? String(message.detail || '').trim() : '';
  const [open, setOpen] = useState(() => pendingPlanImplementation || activityCardShouldOpen({ running, hasProcess }));
  const startedAt = message.startedAt || timeRange.startedAt || message.timestamp;
  const endedAt = running ? now : message.completedAt || timeRange.endedAt || message.timestamp || now;
  const duration = !running ? formatDurationMs(message.durationMs) || formatDuration(startedAt, endedAt) : formatDuration(startedAt, endedAt);
  const headline = failed ? '处理失败' : pendingPlanImplementation ? '等待确认' : running ? '处理中' : '已处理';

  useEffect(() => {
    setOpen(pendingPlanImplementation || activityCardShouldOpen({ running, hasProcess }));
  }, [message.id, running, hasProcess, pendingPlanImplementation]);

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''}`}>
        <button
          type="button"
          className="activity-summary"
          aria-expanded={hasProcess ? open : undefined}
          disabled={!hasProcess}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{duration ? `${headline} ${duration}` : headline}</span>
          {hasProcess ? <ChevronDown className={`activity-chevron ${open ? 'is-open' : ''}`} size={15} /> : null}
        </button>
        {open && hasProcess ? (
          <ActivityTimeline
            timeline={timeline}
            fileSummary={fileSummary}
            onImplementPlan={onImplementPlan}
          />
        ) : null}
        {failureDetail && !hasProcess ? (
          <div className="activity-failure-detail">{failureDetail}</div>
        ) : null}
      </div>
    </div>
  );
}
