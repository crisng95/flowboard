"""User identity surfaced from the extension.

The Chrome extension proactively fetches Google's
``/oauth2/v2/userinfo`` once it captures a Bearer token, then pushes
the resolved profile to the agent over WebSocket. This route just
exposes the cached object for the frontend's AccountPanel.
"""
from __future__ import annotations

from fastapi import APIRouter

from flowboard.services.flow_client import flow_client

router = APIRouter(prefix="/api/auth", tags=["auth"])


# Test hook kept for backward compatibility with existing test imports.
# The DB-tier-fallback cache it used to reset is gone — see the
# `_last_observed_paygate_tier_from_db` removal below.
def _reset_db_tier_cache_for_tests() -> None:
    """No-op — preserved so existing tests' `from .auth import
    _reset_db_tier_cache_for_tests` doesn't break. Will be removed in
    v1.2 along with the test imports."""
    return


@router.get("/me")
def get_me() -> dict:
    """Return the cached Google profile + paygate tier from the live
    extension signal only.

    The previous version had a "fall back to last observed tier in DB"
    branch that read `request.params.paygate_tier` from the most recent
    gen request. That branch was a footgun: the worker used to default
    to `PAYGATE_TIER_ONE` when no live tier was present, and that wrong
    value got stamped into request.params, polluting the DB. The next
    /api/auth/me call would then read the polluted row and report Pro
    forever — even for Ultra users — until a fresh known-good gen
    happened to overwrite the fallback row.

    Now: the worker fails loud when tier is unknown (see
    `worker/processor.py:_handle_gen_image` etc), so no bogus tier
    gets into the DB. /api/auth/me returns `paygate_tier: null` until
    the extension pushes a real signal, and the AccountPanel renders a
    "Tier unknown — open Flow tab" banner instead of lying.
    """
    info = flow_client.user_info or {}
    return {
        "email": info.get("email"),
        "name": info.get("name"),
        "picture": info.get("picture"),
        "verified_email": info.get("verified_email"),
        "paygate_tier": flow_client.paygate_tier,
    }
