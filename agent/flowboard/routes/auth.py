"""User identity surfaced from the extension.

The Chrome extension proactively fetches Google's
``/oauth2/v2/userinfo`` once it captures a Bearer token, then pushes
the resolved profile to the agent over WebSocket. This route just
exposes the cached object for the frontend's AccountPanel.
"""
from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services.flow_client import flow_client

router = APIRouter(prefix="/api/auth", tags=["auth"])


# Module-level TTL cache for the DB tier fallback. The AccountPanel
# polls /api/auth/me every 5s until both email + tier resolve, and
# this fallback runs whenever the in-memory tier is None (legacy
# boards, cold-start). Without a cache we'd re-scan up to 20 request
# rows per poll — wasteful on slow SQLite.
_DB_TIER_CACHE_TTL_S = 30.0
_db_tier_cache: tuple[float, Optional[str]] = (0.0, None)


def _last_observed_paygate_tier_from_db() -> Optional[str]:
    """Fallback: read the tier from the most recent successful gen
    request the user dispatched. Useful right after agent restart when
    the extension hasn't pushed a fresh `paygate_tier` yet — any past
    `gen_image` / `gen_video` request that completed against Flow
    proves the tier the user is on, since Flow would have rejected it
    otherwise. Returns None when no usable row is present.

    Result is cached for ~30s — the only signal that would invalidate
    the cache is a fresh successful gen, and the AccountPanel polls at
    most every 5s, so we'd hit the same answer 5+ times in a row
    without caching.
    """
    global _db_tier_cache
    now = time.monotonic()
    cached_at, cached_tier = _db_tier_cache
    if now - cached_at < _DB_TIER_CACHE_TTL_S:
        return cached_tier

    with get_session() as s:
        rows = s.exec(
            select(Request)
            .where(Request.status == "done")
            .where(Request.type.in_(("gen_image", "gen_video")))  # type: ignore[attr-defined]
            .order_by(Request.id.desc())
            .limit(20)
        ).all()
    tier: Optional[str] = None
    for r in rows:
        params = r.params if isinstance(r.params, dict) else {}
        candidate = params.get("paygate_tier")
        if candidate in ("PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"):
            tier = candidate
            break
    _db_tier_cache = (now, tier)
    return tier


def _reset_db_tier_cache_for_tests() -> None:
    """Test hook — flush the TTL cache so tests don't bleed state."""
    global _db_tier_cache
    _db_tier_cache = (0.0, None)


@router.get("/me")
def get_me() -> dict:
    """Return the cached Google profile + paygate tier, or null fields
    when neither has arrived yet.

    Tier resolution order:
      1. Live signal pushed by the extension's request-body sniffer
         (authoritative — what Flow web sends on the user's behalf).
      2. Last observed tier on a successful gen request in DB
         (fallback so refreshes after agent restart aren't blank).

    Never throws — the AccountPanel polls this and renders sensible
    placeholders while we wait for one of the signals to land.
    """
    info = flow_client.user_info or {}
    tier = flow_client.paygate_tier or _last_observed_paygate_tier_from_db()
    return {
        "email": info.get("email"),
        "name": info.get("name"),
        "picture": info.get("picture"),
        "verified_email": info.get("verified_email"),
        "paygate_tier": tier,
    }
