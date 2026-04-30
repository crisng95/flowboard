"""Tests for the vision describe service + /api/vision/describe route.

The service routes vision calls through `run_llm("vision", ...)` after
the multi-LLM provider migration. Tests patch `run_llm` at the import
boundary in `vision_service` so the registry / provider stack is fully
bypassed — registry routing is tested separately in `test_llm_registry.py`.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flowboard.services import vision as vision_service
from flowboard.services.llm.base import LLMError


# ── service tests ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_describe_media_passes_cached_path_through_run_llm(monkeypatch, tmp_path):
    """Service must locate the cached file, then forward the absolute path
    as an attachment to `run_llm("vision", ...)` with the brief system prompt."""
    media_id = "11111111-2222-3333-4444-555555555555"

    fake_cached = tmp_path / f"{media_id}.png"
    fake_cached.write_bytes(b"\x89PNG\r\n\x1a\n")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake_cached)

    captured: dict = {}

    async def stub_run_llm(feature, prompt, *, system_prompt=None, attachments=None, timeout=0):
        captured["feature"] = feature
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        captured["attachments"] = attachments
        return "white cotton crewneck t-shirt with small heart logo on chest"

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)

    out = await vision_service.describe_media(media_id)
    assert "white cotton crewneck" in out
    assert captured["feature"] == "vision"  # routed under the right feature key
    assert captured["attachments"] == [str(fake_cached.resolve())]
    assert captured["system_prompt"] is not None
    assert "annotator" in (captured["system_prompt"] or "").lower()


@pytest.mark.asyncio
async def test_describe_media_rejects_invalid_id():
    with pytest.raises(vision_service.VisionError):
        await vision_service.describe_media("not-a-uuid")


@pytest.mark.asyncio
async def test_describe_media_caps_long_responses(monkeypatch, tmp_path):
    media_id = "22222222-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    long_text = "a" * 800
    async def stub_run_llm(*a, **k):
        return long_text

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)
    out = await vision_service.describe_media(media_id)
    assert len(out) <= 401  # 400 + ellipsis
    assert out.endswith("…")


@pytest.mark.asyncio
async def test_describe_media_propagates_provider_failure(monkeypatch, tmp_path):
    """Provider failure surfaces as VisionError. Confirms the registry
    contract that `run_llm` only raises LLMError — vision wraps it
    further into VisionError so route handlers can return a clean 502."""
    media_id = "33333333-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    async def stub_run_llm(*a, **k):
        raise LLMError("auth failed")

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)
    with pytest.raises(vision_service.VisionError, match="vision provider failed"):
        await vision_service.describe_media(media_id)


# ── route tests ───────────────────────────────────────────────────────────


def test_describe_route_happy_path(client, monkeypatch):
    media_id = "44444444-2222-3333-4444-555555555555"

    async def stub_describe(mid):
        assert mid == media_id
        return "young Korean woman, neutral expression, dark hair tied back"

    monkeypatch.setattr(vision_service, "describe_media", stub_describe)
    r = client.post("/api/vision/describe", json={"media_id": media_id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media_id"] == media_id
    assert "Korean woman" in body["description"]


def test_describe_route_502_on_vision_error(client, monkeypatch):
    async def stub_describe(mid):
        raise vision_service.VisionError("media not cached and could not be fetched")

    monkeypatch.setattr(vision_service, "describe_media", stub_describe)
    r = client.post(
        "/api/vision/describe",
        json={"media_id": "55555555-2222-3333-4444-555555555555"},
    )
    assert r.status_code == 502
    assert "not cached" in r.json()["detail"]
