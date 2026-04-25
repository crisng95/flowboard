"""Tests for the media service + /media routes."""
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services import media as media_service


# ── pure helpers ─────────────────────────────────────────────────────────────


def test_is_valid_media_id_accepts_uuidish():
    assert media_service.is_valid_media_id("a1b2c3d4-5678-90ab-cdef-1234567890ab")
    assert media_service.is_valid_media_id("abc123")


def test_is_valid_media_id_rejects_bad_shapes():
    assert not media_service.is_valid_media_id("")
    assert not media_service.is_valid_media_id("../../admin")
    assert not media_service.is_valid_media_id("a b c")
    assert not media_service.is_valid_media_id("x" * 65)


def test_normalize_strips_media_prefix():
    assert media_service.normalize_media_id("media/abc-123") == "abc-123"
    assert media_service.normalize_media_id("abc-123") == "abc-123"


# ── ingest_urls ──────────────────────────────────────────────────────────────


def test_ingest_urls_upserts(client):
    # Seed a client to ensure DB is ready.
    client.get("/api/health")

    touched = media_service.ingest_urls(
        [
            {
                "media_id": "abc1dead",
                "mediaType": "image",
                "url": "https://flow-content.google/image/abc-111?sig=xxx",
            }
        ]
    )
    assert touched == 1

    # Second ingest updates url on same media_id — not a duplicate row.
    touched2 = media_service.ingest_urls(
        [
            {
                "media_id": "abc1dead",
                "mediaType": "image",
                "url": "https://flow-content.google/image/abc-111?sig=yyy",
            }
        ]
    )
    assert touched2 == 1


def test_ingest_urls_rejects_non_allowed_urls(client):
    client.get("/api/health")
    # evil.example.com
    touched = media_service.ingest_urls(
        [
            {
                "media_id": "deadbeef",
                "mediaType": "image",
                "url": "https://evil.example.com/pwn",
            }
        ]
    )
    assert touched == 0
    # Legacy GCS bucket is also no longer accepted
    touched = media_service.ingest_urls(
        [
            {
                "media_id": "deadbeef",
                "mediaType": "image",
                "url": "https://storage.googleapis.com/ai-sandbox-videofx/image/x?sig=y",
            }
        ]
    )
    assert touched == 0


def test_ingest_urls_ignores_malformed_entries(client):
    client.get("/api/health")
    touched = media_service.ingest_urls(
        [
            "not-a-dict",
            {"url": "https://flow-content.google/image/x"},
            {"media_id": "../../a", "url": "https://flow-content.google/image/x"},
        ]
    )
    assert touched == 0


# ── /api/media/:id/status ───────────────────────────────────────────────────


def test_status_unknown_media_returns_no_url_yet(client):
    r = client.get("/api/media/abcdef/status")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["has_url"] is False


def test_status_reports_has_url_when_ingested(client):
    media_service.ingest_urls(
        [
            {
                "media_id": "aaa11100",
                "mediaType": "image",
                "url": "https://flow-content.google/image/aaa11100?sig=z",
            }
        ]
    )
    r = client.get("/api/media/aaa11100/status")
    assert r.status_code == 200
    body = r.json()
    assert body["has_url"] is True
    assert body["available"] is False  # not fetched yet


def test_status_rejects_invalid_media_id(client):
    r = client.get("/api/media/..\\\\evil/status")
    # Path may not even route; accept 400 or 404 from URL path sanitization.
    assert r.status_code in (400, 404)


# ── /media/:id ──────────────────────────────────────────────────────────────


def test_media_bytes_returns_404_when_no_url(client):
    r = client.get("/media/deadbeef")
    assert r.status_code == 404
    body = r.json()
    assert body["available"] is False


def test_media_bytes_rejects_path_traversal(client):
    r = client.get("/media/..%2Fetc%2Fpasswd")
    # Either FastAPI decodes + the validator rejects, or it 404s on route.
    assert r.status_code in (400, 404)


def test_media_bytes_fetches_and_caches_on_miss(client, tmp_path, monkeypatch):
    # Ingest a URL.
    mid = "cac1abad"
    media_service.ingest_urls(
        [
            {
                "media_id": mid,
                "mediaType": "image",
                "url": f"https://flow-content.google/image/{mid}?sig=q",
            }
        ]
    )

    # Redirect the cache dir to a tmp path and clear anything.
    monkeypatch.setattr(media_service, "MEDIA_CACHE_DIR", tmp_path)

    # Mock httpx AsyncClient.get to return png bytes.
    class _Resp:
        status_code = 200
        content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
        headers = {"content-type": "image/png"}

    class _Client:
        def __init__(self, **_): ...
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            return False
        async def get(self, _url):
            return _Resp()

    monkeypatch.setattr(media_service.httpx, "AsyncClient", _Client)

    r = client.get(f"/media/{mid}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    assert r.content == _Resp.content

    cached_file = tmp_path / f"{mid}.png"
    assert cached_file.exists()
    assert cached_file.read_bytes() == _Resp.content

    # Second request is a cache hit (we'll flip the mock to assert no fetch).
    called = {"count": 0}

    class _ClientFail:
        def __init__(self, **_): ...
        async def __aenter__(self):
            called["count"] += 1
            raise AssertionError("should not fetch on cache hit")
        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(media_service.httpx, "AsyncClient", _ClientFail)
    r2 = client.get(f"/media/{mid}")
    assert r2.status_code == 200
    assert r2.content == _Resp.content
    assert called["count"] == 0


def test_media_bytes_accepts_media_prefix(client, tmp_path, monkeypatch):
    mid = "deadbeef"
    media_service.ingest_urls(
        [
            {
                "media_id": mid,
                "mediaType": "image",
                "url": f"https://flow-content.google/image/{mid}?sig=q",
            }
        ]
    )
    monkeypatch.setattr(media_service, "MEDIA_CACHE_DIR", tmp_path)

    class _Resp:
        status_code = 200
        content = b"data"
        headers = {"content-type": "image/jpeg"}

    class _Client:
        def __init__(self, **_): ...
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_):
            return False
        async def get(self, _url):
            return _Resp()

    monkeypatch.setattr(media_service.httpx, "AsyncClient", _Client)

    r = client.get(f"/media/media/{mid}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/jpeg")
