import { useState } from "react";
import { ActivityDropdown } from "./ActivityDropdown";
import { ActivityDetailModal } from "./ActivityDetailModal";
import { BellIcon } from "./ActivityIcon";
import { useActivityFeed } from "./useActivityFeed";

/**
 * Toolbar entry point for the activity feed. Bell icon with a badge
 * showing unread count. Click → dropdown of the most recent N items.
 * Click an item → detail modal with full input/output/error.
 *
 * Sits in the toolbar action group, between the Settings cog and the
 * AI Provider badge — leftmost so a fresh failure isn't masked by the
 * other chips.
 */

export function ActivityBell() {
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const feed = useActivityFeed(open);

  function toggle() {
    if (!open) {
      // Stamp lastSeenId on open so badge clears the failed-unread
      // contribution. Running items still count regardless.
      feed.markRead();
    }
    setOpen((v) => !v);
  }

  // Display "9+" for >9 to keep the pill compact.
  const badgeLabel = feed.unreadCount > 9 ? "9+" : String(feed.unreadCount);
  const badgeClass = feed.hasFailed
    ? "activity-bell__badge activity-bell__badge--fail"
    : "activity-bell__badge";

  return (
    <>
      <div className="activity-bell-wrap">
        <button
          type="button"
          className={`activity-bell${
            feed.runningCount > 0 ? " activity-bell--pulse" : ""
          }${feed.unreadCount > 0 ? " activity-bell--alert" : ""}`}
          onClick={toggle}
          aria-label={`Activity (${feed.unreadCount} unread)`}
          title={
            feed.unreadCount === 0
              ? "Activity"
              : feed.hasFailed
                ? `${feed.unreadCount} unread (failed) — click to review`
                : `${feed.runningCount} running`
          }
        >
          <BellIcon size={18} />
          {feed.unreadCount > 0 && (
            <span className={badgeClass} aria-hidden="true">
              {badgeLabel}
            </span>
          )}
        </button>
        {open && (
          <ActivityDropdown
            items={feed.items}
            loading={feed.loading}
            nextBeforeId={feed.nextBeforeId}
            onLoadMore={feed.loadMore}
            onClose={() => setOpen(false)}
            onSelect={(id) => setDetailId(id)}
          />
        )}
      </div>
      <ActivityDetailModal
        activityId={detailId}
        onClose={() => setDetailId(null)}
      />
    </>
  );
}
