"""Wire-format for datetimes leaving the API.

Lives at the top level, next to ``short_id``, because two route modules
need it and neither owns it. It started inside ``routes/activity.py``,
which meant ``routes/boards.py`` reached across for a private
``_utc_iso`` — a name that says "don't import me" being imported.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional


def utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """Serialize a UTC datetime as ISO with explicit ``Z`` suffix.

    SQLite's ``DateTime`` column stores the value as an ISO string but
    strips tz info on read-back, so models that wrote ``datetime.now(tz=utc)``
    come back as **naive** datetimes here. Without an explicit suffix
    the frontend's ``new Date(string)`` parses naive ISO as **local**
    time — Vietnam (UTC+7) clients then read every timestamp as 7h in
    the past, and "X minutes ago" computations show 7h+ offsets. We
    annotate the value as UTC (naive → tag, aware → convert) before
    serializing so the wire format unambiguously says "UTC."
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    # Replace the `+00:00` offset with `Z` — both are valid ISO-8601 UTC
    # markers, but `Z` is shorter and matches what most JS code expects.
    return dt.isoformat().replace("+00:00", "Z")
