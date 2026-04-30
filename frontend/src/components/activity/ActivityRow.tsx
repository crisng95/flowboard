import type { ActivityListItem } from "../../api/client";
import { formatDuration, metaFor, relativeTime, statusMeta } from "./activity-meta";

interface ActivityRowProps {
  item: ActivityListItem;
  onClick(): void;
}

export function ActivityRow({ item, onClick }: ActivityRowProps) {
  const meta = metaFor(item.type);
  const status = statusMeta(item.status);
  const node = item.node_short_id ? `· #${item.node_short_id}` : "";
  const dur = item.duration_ms !== null ? formatDuration(item.duration_ms) : "";

  return (
    <button
      type="button"
      className={`activity-row activity-row--${status.tone}`}
      onClick={onClick}
      title={`Started ${item.created_at}`}
    >
      <span className="activity-row__icon" aria-hidden="true">
        {meta.icon}
      </span>
      <div className="activity-row__body">
        <div className="activity-row__title">
          {meta.label} <span className="activity-row__node">{node}</span>
        </div>
        <div className="activity-row__meta">
          {relativeTime(item.created_at)}
          {dur && (item.status === "done" || item.status === "failed") && (
            <span className="activity-row__dur"> · {dur}</span>
          )}
          {item.status === "failed" && (
            <span className="activity-row__hint"> · click for error</span>
          )}
        </div>
      </div>
      <span className={`activity-row__status activity-row__status--${status.tone}`}>
        <span className="activity-row__status-icon" aria-hidden="true">
          {status.icon}
        </span>
        {status.label}
      </span>
    </button>
  );
}
