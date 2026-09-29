"""Worker presence — which external workers are currently listening.

The Muse provider has no CLI to probe and no API key to check, so
``is_available()`` (and the Settings UI's green tick) is driven by this:
every ``wait-next`` / ``claim`` call touches the worker's id, and presence
is "seen within the TTL".

In-memory and per-process, deliberately: it is advisory UI state, not
queue state. A restart clears it and the next worker poll repopulates it.
Thread-safe via a lock (the wait-next long-poll runs in async workers,
presence writes are tiny).
"""
from __future__ import annotations

import threading
import time

_lock = threading.Lock()
# (provider, worker_id) -> last-seen monotonic seconds
_seen: dict[tuple[str, str], float] = {}


def touch(provider: str, worker_id: str) -> None:
    """Record that a worker polled. Called on wait-next / claim."""
    if not worker_id:
        return
    with _lock:
        _seen[(provider.strip().lower(), worker_id.strip())] = time.monotonic()


def recent_workers(provider: str, within_s: float = 300) -> list[dict]:
    """Workers seen within the window, newest first."""
    now = time.monotonic()
    with _lock:
        items = [
            (wid, now - ts)
            for (prov, wid), ts in _seen.items()
            if prov == provider.strip().lower() and now - ts <= within_s
        ]
    items.sort(key=lambda t: t[1])
    return [{"worker_id": wid, "last_seen_s_ago": round(age, 1)} for wid, age in items]


def any_recent(provider: str, within_s: float = 300) -> bool:
    now = time.monotonic()
    with _lock:
        return any(
            prov == provider.strip().lower() and now - ts <= within_s
            for (prov, _), ts in _seen.items()
        )
