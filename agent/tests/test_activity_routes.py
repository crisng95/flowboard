"""Tests for the /api/activity routes — focused on the timestamp
serialization contract.

Background: SQLite's ``DateTime`` column stores naive ISO strings, so a
TZ-aware ``datetime.now(tz=utc)`` round-trips back as **naive** on read.
Without an explicit UTC marker on the wire, the frontend's
``new Date(string)`` interprets naive ISO as **local** time — Vietnam
clients then read every server timestamp as 7h in the past, and "X
minutes ago" widgets show 7h+ offsets. The route's ``_utc_iso`` helper
guarantees every emitted timestamp ends with ``Z``.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from flowboard.routes.activity import _utc_iso


def test_utc_iso_tags_naive_datetime_as_utc():
    """Naive datetime (the SQLite read-back path) gets the UTC marker
    appended verbatim — we know we wrote UTC, so re-tagging is safe."""
    naive = datetime(2026, 5, 1, 7, 13, 43, 704974)
    out = _utc_iso(naive)
    assert out is not None
    assert out.endswith("Z"), f"missing Z suffix: {out!r}"
    assert "+00:00" not in out
    assert out.startswith("2026-05-01T07:13:43")


def test_utc_iso_converts_aware_non_utc_to_utc():
    """If a tz-aware datetime in another zone slips through (e.g. a
    code path that uses local time), normalize to UTC so the wire format
    is always UTC + Z."""
    plus7 = timezone(timedelta(hours=7))
    aware = datetime(2026, 5, 1, 14, 13, 43, tzinfo=plus7)
    out = _utc_iso(aware)
    assert out is not None
    assert out.endswith("Z")
    # 14:13:43 +07:00 → 07:13:43 UTC
    assert out.startswith("2026-05-01T07:13:43")


def test_utc_iso_passes_through_aware_utc():
    """Already-UTC-aware datetimes serialize cleanly without a double
    conversion."""
    aware_utc = datetime(2026, 5, 1, 7, 13, 43, tzinfo=timezone.utc)
    out = _utc_iso(aware_utc)
    assert out == "2026-05-01T07:13:43Z"


def test_utc_iso_returns_none_for_none():
    """``finished_at`` is None while a request is in flight — the
    helper must propagate that, not raise."""
    assert _utc_iso(None) is None
