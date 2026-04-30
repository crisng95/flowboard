import { useCallback, useEffect, useRef, useState } from "react";
import { getActivityList, type ActivityListItem } from "../../api/client";

const POLL_OPEN_MS = 5_000;
const POLL_CLOSED_MS = 30_000;
const PAGE_SIZE = 50;
const LAST_SEEN_KEY = "flowboard:activity:lastSeenId";

/**
 * Lightweight feed manager for the activity bell. Owns:
 *   - The visible list of items (paginated)
 *   - Polling cadence (5s while panel open, 30s closed,
 *     paused on tab visibility hidden)
 *   - Unread badge math (running count + failed-since-lastSeen)
 *   - lastSeenId persistence in sessionStorage
 *
 * Returns immutable arrays so React reconciles cheaply on diffs.
 */
export function useActivityFeed(panelOpen: boolean) {
  const [items, setItems] = useState<ActivityListItem[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSeenId, setLastSeenIdState] = useState<number>(() => {
    try {
      const raw = sessionStorage.getItem(LAST_SEEN_KEY);
      return raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
      return 0;
    }
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await getActivityList({ limit: PAGE_SIZE });
      if (!aliveRef.current) return;
      setItems(res.items);
      setNextBeforeId(res.next_before_id);
      setLoading(false);
    } catch {
      // Network blip — keep stale list, try next tick.
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(
      () => {
        if (document.visibilityState === "visible") void refresh();
      },
      panelOpen ? POLL_OPEN_MS : POLL_CLOSED_MS,
    );
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [panelOpen, refresh]);

  const loadMore = useCallback(async () => {
    if (nextBeforeId == null) return;
    try {
      const res = await getActivityList({
        limit: PAGE_SIZE,
        beforeId: nextBeforeId,
      });
      if (!aliveRef.current) return;
      setItems((prev) => [...prev, ...res.items]);
      setNextBeforeId(res.next_before_id);
    } catch {
      // ignore
    }
  }, [nextBeforeId]);

  const markRead = useCallback(() => {
    if (items.length === 0) return;
    const top = items[0]!.id;
    setLastSeenIdState(top);
    try {
      sessionStorage.setItem(LAST_SEEN_KEY, String(top));
    } catch {
      // ignore (private mode etc)
    }
  }, [items]);

  // Unread = running OR (failed AND id > lastSeenId).
  // Running is always "live" so it counts regardless of lastSeenId.
  let runningCount = 0;
  let unreadFailed = 0;
  for (const it of items) {
    if (it.status === "running" || it.status === "queued") runningCount += 1;
    else if (it.status === "failed" && it.id > lastSeenId) unreadFailed += 1;
  }
  const unreadCount = runningCount + unreadFailed;
  const hasFailed = unreadFailed > 0;

  return {
    items,
    nextBeforeId,
    loading,
    unreadCount,
    runningCount,
    hasFailed,
    refresh,
    loadMore,
    markRead,
  };
}
