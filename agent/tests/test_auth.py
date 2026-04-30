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
        "sku": None,
        "credits": None,
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


@pytest.mark.asyncio
async def test_fetch_paygate_tier_resolves_authoritatively(monkeypatch):
    """Happy path — Bearer token cached, /v1/credits returns 200 with
    a known tier. flow_client caches tier + sku + credits and the next
    /api/auth/me sees them."""
    import httpx
    flow_client._flow_key = "ya29.fake-bearer-token"
    flow_client._paygate_tier = None
    flow_client._sku = None
    flow_client._credits = None

    captured: dict = {}

    class _MockResponse:
        status_code = 200

        def json(self):
            return {
                "credits": 24340,
                "userPaygateTier": "PAYGATE_TIER_TWO",
                "sku": "WS_ULTRA",
                "serviceTier": "SERVICE_TIER_ADVANCED",
                "subscriptionCredits": 24340,
            }

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, url, **kwargs):
            captured["url"] = url
            captured["params"] = kwargs.get("params")
            captured["headers"] = kwargs.get("headers")
            return _MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _MockClient)

    ok = await flow_client.fetch_paygate_tier()
    assert ok is True
    assert flow_client.paygate_tier == "PAYGATE_TIER_TWO"
    assert flow_client.sku == "WS_ULTRA"
    assert flow_client.credits == 24340

    # Verify the request shape — Flow's /v1/credits expects the public
    # API key as a query param + Bearer auth + labs.google origin.
    assert captured["url"] == "https://aisandbox-pa.googleapis.com/v1/credits"
    assert captured["params"]["key"].startswith("AIza")  # public Flow key
    assert captured["headers"]["authorization"] == "Bearer ya29.fake-bearer-token"
    assert captured["headers"]["origin"] == "https://labs.google"


@pytest.mark.asyncio
async def test_fetch_paygate_tier_returns_false_without_token():
    """No Bearer token cached → fetch is a no-op, returns False so
    callers know the cache wasn't updated. Avoids hitting the network
    with an empty Authorization header."""
    flow_client._flow_key = None
    flow_client._paygate_tier = None
    ok = await flow_client.fetch_paygate_tier()
    assert ok is False
    assert flow_client.paygate_tier is None


@pytest.mark.asyncio
async def test_fetch_paygate_tier_handles_expired_token(monkeypatch):
    """HTTP 401 from /v1/credits = token expired/revoked. fetch
    returns False, doesn't poison the cache, callers should treat as
    'extension needs to re-capture token'."""
    import httpx
    flow_client._flow_key = "ya29.expired"
    flow_client._paygate_tier = None

    class _MockResponse:
        status_code = 401
        def json(self):
            return {"error": "unauthenticated"}

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, *args, **kwargs):
            return _MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _MockClient)

    ok = await flow_client.fetch_paygate_tier()
    assert ok is False
    assert flow_client.paygate_tier is None


@pytest.mark.asyncio
async def test_fetch_paygate_tier_rejects_unknown_tier_value(monkeypatch):
    """Defensive — Flow API contract change that returns an unknown
    tier value (e.g. PAYGATE_TIER_THREE in the future) must NOT
    silently set the cache to that string. Returns False, leaves
    cache untouched."""
    import httpx
    flow_client._flow_key = "ya29.fake"
    flow_client._paygate_tier = None

    class _MockResponse:
        status_code = 200
        def json(self):
            return {"userPaygateTier": "PAYGATE_TIER_FUTURE", "credits": 100}

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, *args, **kwargs):
            return _MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _MockClient)
    ok = await flow_client.fetch_paygate_tier()
    assert ok is False
    assert flow_client.paygate_tier is None


def test_logout_clears_cached_identity_and_tier(client):
    """POST /api/auth/logout drops the cached profile + tier so the
    next /me reflects the logged-out state immediately. extension_notified
    is False here because no real WS is attached in the test harness —
    that's the expected return when the user never connected."""
    flow_client._user_info = {
        "email": "u@example.com", "name": "U",
        "picture": "https://x/p.png", "verified_email": True,
    }
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    r = client.post("/api/auth/logout")
    assert r.status_code == 200
    body = r.json()
    assert body == {"ok": True, "extension_notified": False}

    me = client.get("/api/auth/me").json()
    assert me["email"] is None
    assert me["paygate_tier"] is None


def test_logout_notifies_extension_when_ws_connected(client):
    """When the WebSocket is open, /logout pushes a `logout` message
    so the extension drops its in-memory token + cachedUserInfo."""
    sent: list[dict] = []

    class _FakeWs:
        async def send(self, payload):
            import json
            sent.append(json.loads(payload))

    flow_client.set_extension(_FakeWs())
    flow_client._user_info = {"email": "u@example.com"}

    r = client.post("/api/auth/logout")
    assert r.status_code == 200
    assert r.json()["extension_notified"] is True
    assert sent == [{"type": "logout"}]
    # Cleared agent-side too.
    assert flow_client.user_info is None


def test_scan_reports_disconnected_state_when_no_extension(client):
    """No WS connection → scan reports it cleanly so the frontend can
    surface a "extension not found" hint to the user."""
    flow_client.clear_extension()

    r = client.post("/api/auth/scan")
    assert r.status_code == 200
    assert r.json() == {
        "extension_connected": False,
        "has_user_info": False,
        "has_paygate_tier": False,
        "userinfo_nudged": False,
        "tier_fetched": False,
    }


def test_scan_nudges_extension_when_connected_but_userinfo_empty(client):
    """WS open + agent has no cached profile → scan asks the extension
    to re-fetch userinfo. This is the "user clicked Scan after agent
    restart" path — the WS is fine but the cache is cold."""
    sent: list[dict] = []

    class _FakeWs:
        async def send(self, payload):
            import json
            sent.append(json.loads(payload))

    flow_client.set_extension(_FakeWs())
    flow_client._user_info = None
    flow_client._paygate_tier = None

    r = client.post("/api/auth/scan")
    assert r.status_code == 200
    body = r.json()
    assert body["extension_connected"] is True
    assert body["has_user_info"] is False
    assert body["userinfo_nudged"] is True
    assert sent == [{"type": "please_resend_userinfo"}]


def test_scan_does_not_nudge_when_userinfo_already_cached(client):
    """Cache already populated → no nudge needed; scan just reports
    state. Avoids spamming the extension on every Scan click."""
    sent: list[dict] = []

    class _FakeWs:
        async def send(self, payload):
            import json
            sent.append(json.loads(payload))

    flow_client.set_extension(_FakeWs())
    flow_client._user_info = {"email": "u@example.com"}
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    r = client.post("/api/auth/scan")
    assert r.json()["userinfo_nudged"] is False
    assert sent == []


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
