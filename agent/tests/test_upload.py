"""Tests for POST /api/upload + character_media_ids handoff to gen_image."""
from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path

import pytest

from flowboard.services import media as media_service
from flowboard.services import flow_sdk as flow_sdk_module
from flowboard.worker.processor import _handle_gen_image


# ── helpers ───────────────────────────────────────────────────────────────


def _png_bytes(size: int = 64) -> bytes:
    """Return a tiny valid PNG of arbitrary byte length (padding via tEXt)."""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1x1 RGB
    ihdr_chunk = _png_chunk(b"IHDR", ihdr)
    idat = zlib.compress(b"\x00\xff\xff\xff")
    idat_chunk = _png_chunk(b"IDAT", idat)
    iend_chunk = _png_chunk(b"IEND", b"")
    out = sig + ihdr_chunk + idat_chunk + iend_chunk
    if len(out) < size:
        # Pad with a tEXt chunk so we hit the requested byte count for size tests.
        pad = b"X" * (size - len(out) - 12 - len(b"tEXt"))
        if pad:
            out = sig + ihdr_chunk + _png_chunk(b"tEXt", b"key\0" + pad[:max(0, len(pad) - 4)]) + idat_chunk + iend_chunk
    return out


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


# ── route tests ───────────────────────────────────────────────────────────


def test_upload_rejects_non_image_mime(client):
    r = client.post(
        "/api/upload",
        data={"project_id": "abcd1234"},
        files={"file": ("evil.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 415, r.text


def test_upload_rejects_oversize(client, monkeypatch):
    # Cap to a tiny value so we don't have to send 10 MB in CI.
    from flowboard.routes import upload as upload_route

    monkeypatch.setattr(upload_route, "MAX_UPLOAD_BYTES", 32)
    payload = b"x" * 64  # Larger than the patched cap.
    r = client.post(
        "/api/upload",
        data={"project_id": "abcd1234"},
        files={"file": ("big.png", payload, "image/png")},
    )
    assert r.status_code == 413, r.text


def test_upload_rejects_invalid_project_id(client):
    r = client.post(
        "/api/upload",
        data={"project_id": "../../etc/passwd"},
        files={"file": ("a.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 400, r.text


def test_upload_rejects_empty_file(client):
    r = client.post(
        "/api/upload",
        data={"project_id": "abcd1234"},
        files={"file": ("empty.png", b"", "image/png")},
    )
    assert r.status_code == 400, r.text


def test_upload_happy_path(client, monkeypatch):
    """Stub the SDK upload, verify we cache bytes + persist Asset."""
    media_uuid = "11111111-2222-3333-4444-555555555555"

    async def stub_upload(self, image_base64, mime_type, project_id, file_name):
        assert isinstance(image_base64, str) and image_base64
        assert mime_type == "image/png"
        assert project_id == "abcd1234"
        return {"raw": {"data": {"media": {"name": media_uuid}}}, "media_id": media_uuid}

    monkeypatch.setattr(flow_sdk_module.FlowSDK, "upload_image", stub_upload)
    # Bypass the singleton so the patched method is used.
    monkeypatch.setattr(flow_sdk_module, "_sdk", None)

    payload = _png_bytes()
    r = client.post(
        "/api/upload",
        data={"project_id": "abcd1234"},
        files={"file": ("char.png", payload, "image/png")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media_id"] == media_uuid
    assert body["mime"] == "image/png"
    assert body["size"] == len(payload)

    # Cache file should exist.
    cached = media_service.cached_path(media_uuid)
    assert cached is not None and cached.exists()
    assert Path(cached).read_bytes() == payload

    # Asset row should be present and self-consistent.
    status = media_service.status(media_uuid)
    assert status["available"] is True


def test_upload_propagates_sdk_error(client, monkeypatch):
    async def stub_upload(self, **kwargs):
        return {"raw": None, "error": "captcha_failed"}

    monkeypatch.setattr(flow_sdk_module.FlowSDK, "upload_image", stub_upload)
    monkeypatch.setattr(flow_sdk_module, "_sdk", None)

    r = client.post(
        "/api/upload",
        data={"project_id": "abcd1234"},
        files={"file": ("c.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 502, r.text


# ── worker passthrough ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_gen_image_passes_character_media_ids(monkeypatch):
    """_handle_gen_image must forward character_media_ids to the SDK."""
    captured: dict = {}

    class _Stub:
        async def gen_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {"ok": True}, "media_ids": ["m-1"], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())

    result, err = await _handle_gen_image(
        {
            "prompt": "a hero",
            "project_id": "abcd1234",
            "character_media_ids": ["char-1", "char-2", "", None, 7],
        }
    )
    assert err is None, result
    # Garbage non-string entries must be filtered out.
    assert captured["character_media_ids"] == ["char-1", "char-2"]


@pytest.mark.asyncio
async def test_handle_gen_image_no_character_refs(monkeypatch):
    """When no refs are provided, character_media_ids must be None (not [])."""
    captured: dict = {}

    class _Stub:
        async def gen_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {}, "media_ids": [], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())
    await _handle_gen_image({"prompt": "x", "project_id": "abcd1234"})
    assert captured.get("character_media_ids") is None
