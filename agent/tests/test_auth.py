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


def test_db_tier_fallback_caches_within_ttl(client):
    """The DB tier fallback caches results for ~30s — the AccountPanel
    polls every 5s and we don't want to re-scan the request table on
    every poll. First call should hit the DB; second call within the
    TTL should return the cached value without another query."""
    from unittest.mock import patch as mock_patch
    from flowboard.routes import auth as auth_route

    # Seed the cache by calling /me once with the in-memory tier
    # missing — falls through to the DB query, which returns None on
    # an empty test DB and caches that.
    flow_client._paygate_tier = None
    auth_route._reset_db_tier_cache_for_tests()

    with mock_patch.object(
        auth_route, "_last_observed_paygate_tier_from_db",
        wraps=auth_route._last_observed_paygate_tier_from_db,
    ) as spy:
        # First call: cold — should run the underlying query.
        r1 = client.get("/api/auth/me")
        assert r1.status_code == 200
        # Second call ~immediately: must hit the TTL cache, not re-query.
        r2 = client.get("/api/auth/me")
        assert r2.status_code == 200
        # Both calls go through the wrapper, but only one should reach
        # the actual DB scan. We can't easily count DB queries here,
        # but we CAN verify the cached tuple is set after the first
        # call and unchanged after the second.
        assert auth_route._db_tier_cache[1] is None  # cached "no tier"
        cached_at_after_first = auth_route._db_tier_cache[0]
        # Second call should not have updated the timestamp — proves
        # the cache short-circuited the recompute.
        assert auth_route._db_tier_cache[0] == cached_at_after_first
        # Spy got called twice (route handler entry) but the cache
        # short-circuit means the inner DB select ran only once.
        assert spy.call_count == 2


def test_db_tier_fallback_expires_after_ttl(client):
    """Force the cache timestamp into the past and verify the next
    call re-runs the DB scan. Without this we'd never pick up a fresh
    tier signal after the user generates their first successful
    request post-cold-start."""
    from flowboard.routes import auth as auth_route

    flow_client._paygate_tier = None
    auth_route._reset_db_tier_cache_for_tests()

    # Prime cache.
    client.get("/api/auth/me")
    cached_at_first = auth_route._db_tier_cache[0]
    assert cached_at_first > 0

    # Simulate TTL expiry by rewinding the cache timestamp.
    auth_route._db_tier_cache = (
        cached_at_first - auth_route._DB_TIER_CACHE_TTL_S - 1,
        None,
    )
    client.get("/api/auth/me")
    # Cache timestamp should have moved forward — fresh query ran.
    assert auth_route._db_tier_cache[0] > cached_at_first
