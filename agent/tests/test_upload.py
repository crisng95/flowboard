"""Tests for POST /api/upload + character_media_ids handoff to gen_image."""
from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path

import pytest

from flowboard.services import flow_batch as fb
from flowboard.services import media as media_service
from flowboard.services import flow_sdk as flow_sdk_module
from flowboard.worker.processor import _handle_gen_image
from tests.batch_harness import (
    INPUT_TYPE as _INPUT_TYPE,
    IMG_ASPECT as _ASPECT,
    IMG_INPUTS as _IMAGE_INPUTS,
    IMG_SEED as _SEED,
    PRODUCTION_IMAGE_OFFSETS,
    decode_freq,
    image_recorder as _image_recorder,
)


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


def test_classify_aspect_buckets():
    """Tolerance band of 10% around 1:1 → square; otherwise nearest."""
    from flowboard.routes.upload import _classify_aspect
    assert _classify_aspect(1024, 1024) == "IMAGE_ASPECT_RATIO_SQUARE"
    # 1.05:1 is within the tolerance → still square
    assert _classify_aspect(1050, 1000) == "IMAGE_ASPECT_RATIO_SQUARE"
    assert _classify_aspect(1920, 1080) == "IMAGE_ASPECT_RATIO_LANDSCAPE"
    assert _classify_aspect(1080, 1920) == "IMAGE_ASPECT_RATIO_PORTRAIT"
    assert _classify_aspect(1600, 800) == "IMAGE_ASPECT_RATIO_LANDSCAPE"
    assert _classify_aspect(0, 0) == "IMAGE_ASPECT_RATIO_LANDSCAPE"


def test_sniff_png_dimensions():
    from flowboard.routes.upload import _sniff_image_dimensions
    # _png_bytes() returns a 1×1 PNG; dimensions in IHDR are ints
    dims = _sniff_image_dimensions(_png_bytes())
    assert dims == (1, 1)


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
    # Upload now classifies the image's aspect ratio so downstream nodes
    # can default-match. _png_bytes() produces a 1×1 → square.
    assert body["aspect_ratio"] == "IMAGE_ASPECT_RATIO_SQUARE"
    assert body["width"] == 1
    assert body["height"] == 1

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


# ── /api/upload-url tests ─────────────────────────────────────────────────


def test_upload_url_rejects_bad_scheme(client):
    r = client.post(
        "/api/upload-url",
        json={"url": "file:///etc/passwd", "project_id": "abcd1234"},
    )
    assert r.status_code == 400, r.text
    assert "http" in r.json()["detail"]


def test_upload_url_rejects_loopback(client):
    r = client.post(
        "/api/upload-url",
        json={"url": "http://127.0.0.1/foo.png", "project_id": "abcd1234"},
    )
    assert r.status_code == 400, r.text
    assert "public" in r.json()["detail"]


def test_upload_url_rejects_invalid_project(client):
    r = client.post(
        "/api/upload-url",
        json={"url": "https://example.com/a.png", "project_id": "../../etc"},
    )
    assert r.status_code == 400, r.text


def test_upload_url_happy_path(client, monkeypatch):
    """Stub httpx and the SDK; verify the URL fetch piece composes correctly."""
    media_uuid = "abcdef00-1111-2222-3333-444444444444"
    payload = _png_bytes()

    class _Resp:
        status_code = 200
        headers = {"content-type": "image/png"}
        content = payload

    class _Client:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url):
            assert url == "https://example.com/a.png"
            return _Resp()

    from flowboard.routes import upload as upload_route
    monkeypatch.setattr(upload_route.httpx, "AsyncClient", _Client)
    # Skip the SSRF DNS guard in tests.
    monkeypatch.setattr(upload_route, "_is_public_host", lambda h: True)

    async def stub_upload(self, image_base64, mime_type, project_id, file_name):
        assert mime_type == "image/png"
        return {"raw": {}, "media_id": media_uuid}

    monkeypatch.setattr(flow_sdk_module.FlowSDK, "upload_image", stub_upload)
    monkeypatch.setattr(flow_sdk_module, "_sdk", None)

    r = client.post(
        "/api/upload-url",
        json={"url": "https://example.com/a.png", "project_id": "abcd1234"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media_id"] == media_uuid
    assert body["mime"] == "image/png"
    assert body["size"] == len(payload)


def test_upload_url_rejects_non_image_response(client, monkeypatch):
    """Server lies about content-type and returns HTML — magic bytes catch it."""

    class _Resp:
        status_code = 200
        headers = {"content-type": "text/html"}
        content = b"<html>not an image</html>"

    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url): return _Resp()

    from flowboard.routes import upload as upload_route
    monkeypatch.setattr(upload_route.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(upload_route, "_is_public_host", lambda h: True)

    r = client.post(
        "/api/upload-url",
        json={"url": "https://example.com/notreal.png", "project_id": "abcd1234"},
    )
    assert r.status_code == 415, r.text


def test_upload_url_uses_magic_bytes_when_content_type_missing(client, monkeypatch):
    """Server omits Content-Type but body is a valid PNG — accept it."""
    media_uuid = "deadbeef-cafe-1234-5678-fedcba987654"
    payload = _png_bytes()

    class _Resp:
        status_code = 200
        headers = {}
        content = payload

    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url): return _Resp()

    from flowboard.routes import upload as upload_route
    monkeypatch.setattr(upload_route.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(upload_route, "_is_public_host", lambda h: True)

    captured = {}
    async def stub_upload(self, image_base64, mime_type, project_id, file_name):
        captured["mime"] = mime_type
        return {"raw": {}, "media_id": media_uuid}

    monkeypatch.setattr(flow_sdk_module.FlowSDK, "upload_image", stub_upload)
    monkeypatch.setattr(flow_sdk_module, "_sdk", None)

    r = client.post(
        "/api/upload-url",
        json={"url": "https://example.com/x", "project_id": "abcd1234"},
    )
    assert r.status_code == 200, r.text
    assert captured["mime"] == "image/png"


# ── worker passthrough ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_gen_image_passes_ref_media_ids(monkeypatch):
    """_handle_gen_image must forward ref_media_ids to the SDK."""
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
            "ref_media_ids": ["src-1", "src-2", "", None, 7],
        }
    )
    assert err is None, result
    # Garbage non-string entries must be filtered out.
    assert captured["ref_media_ids"] == ["src-1", "src-2"]


@pytest.mark.asyncio
async def test_handle_gen_image_legacy_character_media_ids_still_works(monkeypatch):
    """Backward-compat: older callers used character_media_ids."""
    captured: dict = {}

    class _Stub:
        async def gen_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {"ok": True}, "media_ids": ["m-1"], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())

    await _handle_gen_image(
        {
            "prompt": "x",
            "project_id": "abcd1234",
            "character_media_ids": ["legacy-1"],
        }
    )
    assert captured["ref_media_ids"] == ["legacy-1"]


@pytest.mark.asyncio
async def test_handle_gen_image_no_refs(monkeypatch):
    """When no refs are provided, ref_media_ids must be None (not [])."""
    captured: dict = {}

    class _Stub:
        async def gen_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {}, "media_ids": [], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())
    await _handle_gen_image({"prompt": "x", "project_id": "abcd1234"})
    assert captured.get("ref_media_ids") is None


# ── variant_count ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_gen_image_passes_variant_count(monkeypatch):
    captured: dict = {}

    class _Stub:
        async def gen_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {}, "media_ids": ["a", "b", "c", "d"], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())
    await _handle_gen_image(
        {"prompt": "x", "project_id": "abcd1234", "variant_count": 4}
    )
    assert captured["variant_count"] == 4


@pytest.mark.asyncio
async def test_handle_gen_image_defaults_variant_count_to_1(monkeypatch):
    captured: dict = {}

    class _Stub:
        async def gen_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {}, "media_ids": ["a"], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())
    await _handle_gen_image({"prompt": "x", "project_id": "abcd1234"})
    assert captured["variant_count"] == 1


@pytest.mark.asyncio
async def test_gen_image_variant_count_replicates_request_items():
    """Unit test against the SDK's request envelope — verify N RPCs go out."""
    from flowboard.services.flow_sdk import FlowSDK

    rec = _image_recorder(3)
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]

    await sdk.gen_image(
        prompt="p", project_id="abcd1234", variant_count=3,
        paygate_tier="PAYGATE_TIER_ONE",
    )

    # One RPC per variant: the batch image request has no "how many" field,
    # so variants come from repeating the call, not from a count slot.
    calls = rec.rpcs(fb.RPC_GEN_IMAGE)
    assert len(calls) == 3
    seeds = [decode_freq(c["freq"])[1][0][_SEED] for c in calls]
    assert len(set(seeds)) == 3, f"seeds must be distinct per variant, got {seeds}"


@pytest.mark.asyncio
async def test_gen_image_variant_count_clamps_to_4():
    from flowboard.services.flow_sdk import FlowSDK

    rec = _image_recorder(4)
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]

    await sdk.gen_image(
        prompt="p", project_id="abcd1234", variant_count=99,
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert len(rec.rpcs(fb.RPC_GEN_IMAGE)) == 4


@pytest.mark.asyncio
async def test_gen_image_aspect_lands_in_the_aspect_slot_not_the_count_slot():
    """Guards the single most expensive trap of the migration.

    Slot 4 of an image request item is the aspect ratio, and 1 there means
    square — so a request that meant "one variant" and put a 1 in that slot
    looked like it was working. Assert the encoding explicitly: landscape
    16:9 is 3, and it is NOT where the seed or the variant count lives.
    """
    from flowboard.services.flow_sdk import FlowSDK

    rec = _image_recorder(1)
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]

    await sdk.gen_image(
        prompt="p", project_id="abcd1234",
        aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    item = rec.payload(fb.RPC_GEN_IMAGE)[1][0]
    assert item[_ASPECT] == fb.ASPECT_LANDSCAPE == 3
    assert item[_ASPECT] != 1, "1 in this slot is SQUARE, not a variant count"


def test_image_submit_cadence_is_staggered():
    """The production cadence must not collapse to a burst.

    Asserts against the value captured at import time: the suite patches the
    module attribute to zeros (see the _no_image_submit_cadence fixture), so
    reading it live here would assert nothing at all.
    """
    from flowboard.services import flow_sdk

    offsets = PRODUCTION_IMAGE_OFFSETS
    assert len(offsets) >= flow_sdk.MAX_VARIANT_COUNT
    assert offsets[0] == 0.0, "the first variant should not be delayed"
    assert list(offsets) == sorted(offsets), "offsets must be non-decreasing"
    assert offsets[-1] > 0.0, "later variants must actually be staggered"


# ── edit_image (refine) ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_edit_image_happy_path(monkeypatch):
    from flowboard.worker.processor import _handle_edit_image

    captured: dict = {}

    class _Stub:
        async def edit_image(self, **kwargs):
            captured.update(kwargs)
            return {"raw": {}, "media_ids": ["new-1"], "media_entries": []}

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())
    result, err = await _handle_edit_image(
        {
            "prompt": "warmer light",
            "project_id": "abcd1234",
            "source_media_id": "src-1",
            "ref_media_ids": ["ref-1", "", None, "ref-2"],
        }
    )
    assert err is None, result
    assert captured["source_media_id"] == "src-1"
    assert captured["ref_media_ids"] == ["ref-1", "ref-2"]


@pytest.mark.asyncio
async def test_handle_edit_image_rejects_missing_source(monkeypatch):
    from flowboard.worker.processor import _handle_edit_image

    class _Stub:
        async def edit_image(self, **kwargs):
            raise AssertionError("must not call SDK without source")

    monkeypatch.setattr(flow_sdk_module, "_sdk", _Stub())
    _, err = await _handle_edit_image(
        {"prompt": "p", "project_id": "abcd1234"}
    )
    assert err == "missing_source_media_id"


@pytest.mark.asyncio
async def test_edit_image_uses_base_image_input_type():
    """The source must ride as BASE_IMAGE, not as another reference.

    A reference conditions a fresh generation on the image; BASE_IMAGE is what
    makes it an edit of that image. On the wire the difference is one integer
    four slots along — type 2 against a reference's 1 — and Flow accepts the
    wrong one without complaining and then ignores it.
    """
    from flowboard.services.flow_sdk import FlowSDK

    rec = _image_recorder(1)
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]

    await sdk.edit_image(
        prompt="p",
        project_id="abcd1234",
        source_media_id="base-1",
        ref_media_ids=["ref-1"],
        paygate_tier="PAYGATE_TIER_ONE",
    )

    inputs = rec.payload(fb.RPC_GEN_IMAGE)[1][0][_IMAGE_INPUTS]
    assert inputs[0][0] == "base-1"
    assert inputs[0][_INPUT_TYPE] == fb.BASE_TYPE_IMAGE == 2
    assert inputs[1][0] == "ref-1"
    assert inputs[1][_INPUT_TYPE] == fb.REF_TYPE_IMAGE == 1


@pytest.mark.asyncio
async def test_edit_image_never_duplicates_the_source_into_the_references():
    from flowboard.services.flow_sdk import FlowSDK

    rec = _image_recorder(1)
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]

    await sdk.edit_image(
        prompt="p", project_id="abcd1234", source_media_id="base-1",
        ref_media_ids=["base-1", "ref-1"],
        paygate_tier="PAYGATE_TIER_ONE",
    )
    inputs = rec.payload(fb.RPC_GEN_IMAGE)[1][0][_IMAGE_INPUTS]
    assert [i[0] for i in inputs] == ["base-1", "ref-1"]


# ── visual_asset node type ────────────────────────────────────────────────


def test_create_visual_asset_node(client):
    b = client.post("/api/boards", json={"name": "vt"}).json()
    r = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "visual_asset", "data": {"title": "Hero"}},
    )
    assert r.status_code == 200, r.text
    n = r.json()
    assert n["type"] == "visual_asset"
