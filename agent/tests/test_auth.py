"""Tests for the /api/auth/me identity surface and the WS user_info
inbound message handler in flow_client."""
from __future__ import annotations

import pytest

from flowboard.routes.auth import _reset_db_tier_cache_for_tests
from flowboard.services.flow_client import flow_client


@pytest.fixture(autouse=True)
def _reset_state():
    """Each test gets a clean cached identity — flow_client is a module
    singleton that bleeds state across tests otherwise. Also flush the
    DB-tier TTL cache so tier-fallback tests don't see stale answers."""
    flow_client._user_info = None
    flow_client._paygate_tier = None
    _reset_db_tier_cache_for_tests()
    yield
    flow_client._user_info = None
    flow_client._paygate_tier = None
    _reset_db_tier_cache_for_tests()


def test_me_returns_null_fields_when_no_data_yet(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "email": None,
        "name": None,
        "picture": None,
        "verified_email": None,
        "paygate_tier": None,
    }


def test_me_returns_cached_profile_after_user_info_message(client):
    """Simulate the extension pushing a user_info WS message — the
    route must surface the profile straight from flow_client's cache."""
    profile = {
        "email": "tuan@example.com",
        "name": "Tuan Nguyen",
        "picture": "https://example.com/avatar.png",
        "verified_email": True,
        "id": "1234567890",
        "locale": "vi",
    }
    flow_client._user_info = profile
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    r = client.get("/api/auth/me")
    assert r.status_code == 200
    body = r.json()
    # Whitelisted fields surface; other fields stay server-side.
    assert body["email"] == "tuan@example.com"
    assert body["name"] == "Tuan Nguyen"
    assert body["picture"] == "https://example.com/avatar.png"
    assert body["verified_email"] is True
    assert body["paygate_tier"] == "PAYGATE_TIER_TWO"
    # Internal-only fields must not leak.
    assert "id" not in body
    assert "locale" not in body


@pytest.mark.asyncio
async def test_handle_message_caches_paygate_tier():
    """The paygate_tier WS frame from the extension populates
    flow_client._paygate_tier and is then visible via the public
    property + /api/auth/me."""
    await flow_client.handle_message({
        "type": "paygate_tier",
        "paygateTier": "PAYGATE_TIER_TWO",
    })
    assert flow_client.paygate_tier == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_handle_message_rejects_garbage_tier():
    """Defensive — a malformed tier value must not crash or set a
    nonsense string the rest of the system would treat as a tier."""
    flow_client._paygate_tier = "PAYGATE_TIER_ONE"
    await flow_client.handle_message({
        "type": "paygate_tier",
        "paygateTier": "FREE_TRIAL",
    })
    assert flow_client.paygate_tier == "PAYGATE_TIER_ONE"


@pytest.mark.asyncio
async def test_handle_message_caches_user_info():
    """The user_info WS frame from the extension populates
    flow_client._user_info and is then visible via the public property."""
    await flow_client.handle_message({
        "type": "user_info",
        "userInfo": {
            "email": "x@example.com",
            "name": "X User",
            "picture": "https://example.com/p.png",
        },
    })
    assert flow_client.user_info == {
        "email": "x@example.com",
        "name": "X User",
        "picture": "https://example.com/p.png",
    }


@pytest.mark.asyncio
async def test_handle_message_strips_extra_userinfo_fields():
    """Defense-in-depth — even if Google's userinfo response carries
    extra fields (id, locale, hd, given_name…), only the four
    whitelisted keys are cached so future surfaces that read
    flow_client.user_info directly can't leak PII."""
    await flow_client.handle_message({
        "type": "user_info",
        "userInfo": {
            "email": "u@example.com",
            "name": "U",
            "picture": "https://x/p.png",
            "verified_email": True,
            # Fields that MUST get dropped:
            "id": "1234567890",
            "locale": "vi",
            "hd": "example.com",
            "given_name": "U",
            "family_name": "Surname",
            # Hypothetical malicious / unexpected key:
            "__proto__": "bad",
        },
    })
    info = flow_client.user_info
    assert info is not None
    assert set(info.keys()) == {"email", "name", "picture", "verified_email"}


@pytest.mark.asyncio
async def test_handle_message_ignores_non_dict_userinfo():
    """Defensive — a malformed frame must not crash the handler or
    stomp on the cached identity."""
    flow_client._user_info = {"email": "kept@example.com"}
    await flow_client.handle_message({"type": "user_info", "userInfo": "garbage"})
    assert flow_client.user_info == {"email": "kept@example.com"}


@pytest.mark.asyncio
async def test_clear_extension_drops_cached_userinfo_and_tier():
    """When the extension disconnects we drop the cached profile + tier
    so a stale identity never leaks if the user signs out + back in."""
    flow_client._user_info = {"email": "stale@example.com"}
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"
    flow_client.clear_extension()
    assert flow_client.user_info is None
    assert flow_client.paygate_tier is None


def test_me_returns_null_tier_when_extension_has_not_pushed(client):
    """Regression guard for the silent-Pro-downgrade bug.

    Old behaviour: when `flow_client.paygate_tier` was None, /api/auth/me
    fell back to scanning request.params for the most recently observed
    tier. Combined with the worker's old default of PAYGATE_TIER_ONE,
    that meant any gen dispatched before extension sniffed would stamp
    Pro into the DB, and subsequent /me calls would report Pro forever
    even for Ultra users.

    Now the route returns `paygate_tier: null` in this state. The
    AccountPanel surfaces a "Tier unknown — open Flow tab" banner so
    the user sees the gap explicitly instead of being silently lied to.
    """
    flow_client._paygate_tier = None

    # Even with a polluted DB row stamped at PAYGATE_TIER_ONE — the kind
    # the old code used to "recover" the tier from — the route MUST
    # return null. We don't trust DB-stamped tiers anymore because the
    # path that wrote them was the bug.
    from flowboard.db import get_session
    from flowboard.db.models import Request
    with get_session() as s:
        s.add(Request(
            type="gen_image",
            status="done",
            params={"paygate_tier": "PAYGATE_TIER_ONE", "prompt": "x"},
            result={"media_ids": ["m"]},
        ))
        s.commit()

    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["paygate_tier"] is None
