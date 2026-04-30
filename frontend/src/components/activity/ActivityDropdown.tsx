import { useEffect, useRef } from "react";
import type { ActivityListItem } from "../../api/client";
import { ActivityRow } from "./ActivityRow";

interface ActivityDropdownProps {
  items: ActivityListItem[];
  loading: boolean;
  nextBeforeId: number | null;
  onLoadMore(): void;
  onClose(): void;
  onSelect(id: number): void;
}

export function ActivityDropdown({
  items,
  loading,
  nextBeforeId,
  onLoadMore,
  onClose,
  onSelect,
}: ActivityDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Use capture phase so the bell's own click isn't fired again as
    // the dropdown is closing.
    setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [onClose]);

  return (
    <div ref={panelRef} className="activity-dropdown" role="dialog" aria-label="Activity">
      <div className="activity-dropdown__header">
        <span className="activity-dropdown__title">Activity</span>
        <span className="activity-dropdown__count">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <button
          type="button"
          className="activity-dropdown__close"
          onClick={onClose}
          aria-label="Close activity"
        >
          ×
        </button>
      </div>

      <div className="activity-dropdown__list">
        {loading && items.length === 0 && (
          <div className="activity-dropdown__placeholder">Loading…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="activity-dropdown__placeholder">
            No activity yet. Run a generation or open Auto-Prompt to populate the feed.
          </div>
        )}
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} onClick={() => onSelect(item.id)} />
        ))}
      </div>

      {nextBeforeId !== null && (
        <button
          type="button"
          className="activity-dropdown__load-more"
          onClick={onLoadMore}
        >
          Load 50 more
        </button>
      )}
    </div>
  );
}
