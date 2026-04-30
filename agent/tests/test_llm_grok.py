"""Tests for the Grok provider — REST API client.

No real network. ``httpx.AsyncClient`` is monkeypatched per test to
return whatever response shape we want. API key storage flows through
the real ``services.llm.secrets`` module against a tmp file path.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Optional

import httpx
import pytest

from flowboard.services.llm import secrets
from flowboard.services.llm.base import LLMError
from flowboard.services.llm.grok import GrokProvider


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


# ── httpx mocking ──────────────────────────────────────────────────────

class _MockResponse:
    def __init__(self, status_code: int, body: dict | str | None = None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        if isinstance(self._body, str):
            raise ValueError("body is str")
        return self._body


class _MockClient:
    """Stand-in for ``httpx.AsyncClient``. Captures every request for assertion."""

    def __init__(self, *args, response: _MockResponse, capture: dict, **kwargs):
        self._response = response
        self._capture = capture

    async def __aenter__(self): return self
    async def __aexit__(self, *args): return None

    async def get(self, url, **kwargs):
        self._capture["method"] = "GET"
        self._capture["url"] = url
        self._capture["headers"] = kwargs.get("headers")
        return self._response

    async def post(self, url, **kwargs):
        self._capture["method"] = "POST"
        self._capture["url"] = url
        self._capture["headers"] = kwargs.get("headers")
        self._capture["json"] = kwargs.get("json")
        return self._response


def _patch_httpx(monkeypatch, response: _MockResponse) -> dict:
    capture: dict = {}

    def _factory(*args, **kwargs):
        return _MockClient(*args, response=response, capture=capture, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    return capture


# ── is_available ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_is_available_false_when_no_key(tmp_secrets_path):
    """No API key configured → unavailable. Should NOT hit the network."""
    p = GrokProvider()
    # If the network actually got hit, httpx would raise (no mock applied).
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_true_when_models_endpoint_returns_200(
    tmp_secrets_path, monkeypatch
):
    secrets.set_api_key("grok", "xai-good")
    p = GrokProvider()
    capture = _patch_httpx(monkeypatch, _MockResponse(200, {"data": []}))
    assert await p.is_available() is True
    assert capture["method"] == "GET"
    assert capture["url"] == "https://api.x.ai/v1/models"
    assert capture["headers"]["authorization"] == "Bearer xai-good"


@pytest.mark.asyncio
async def test_is_available_false_on_401(tmp_secrets_path, monkeypatch):
    """Key configured but rejected by xAI — treat as unavailable."""
    secrets.set_api_key("grok", "xai-bad")
    p = GrokProvider()
    _patch_httpx(monkeypatch, _MockResponse(401, {"error": {"message": "unauth"}}))
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_caches_for_60s(tmp_secrets_path, monkeypatch):
    """Don't re-ping `/v1/models` on every dispatch — Settings panel polls
    /api/llm/providers at 30s, and dispatch paths could call this even more
    often. 60s TTL is the documented contract."""
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    call_count = {"n": 0}

    class _CountingClient(_MockClient):
        async def get(self, url, **kwargs):
            call_count["n"] += 1
            return await super().get(url, **kwargs)

    def _factory(*args, **kwargs):
        return _CountingClient(
            *args, response=_MockResponse(200, {}), capture={}, **kwargs
        )

    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    await p.is_available()
    await p.is_available()
    await p.is_available()
    assert call_count["n"] == 1


# ── run — text dispatch ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_text_default_model(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    response_body = {
        "choices": [{"message": {"content": "answer"}}]
    }
    capture = _patch_httpx(monkeypatch, _MockResponse(200, response_body))
    out = await p.run("question", system_prompt="be terse")
    assert out == "answer"
    payload = capture["json"]
    assert payload["model"] == "grok-4"  # text default
    assert payload["messages"] == [
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "question"},
    ]
    assert capture["headers"]["authorization"] == "Bearer xai-1"


@pytest.mark.asyncio
async def test_run_no_system_prompt_omits_system_message(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    capture = _patch_httpx(
        monkeypatch,
        _MockResponse(200, {"choices": [{"message": {"content": "x"}}]}),
    )
    await p.run("hello")
    assert capture["json"]["messages"] == [{"role": "user", "content": "hello"}]


# ── run — vision dispatch ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_vision_auto_bumps_to_vision_model(
    tmp_secrets_path, monkeypatch, tmp_path
):
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    img = tmp_path / "test.jpg"
    img.write_bytes(b"\xff\xd8\xff fakejpg")  # tiny valid-ish jpg-prefix bytes
    capture = _patch_httpx(
        monkeypatch,
        _MockResponse(200, {"choices": [{"message": {"content": "described"}}]}),
    )
    out = await p.run("describe this", attachments=[str(img)])
    assert out == "described"
    payload = capture["json"]
    assert payload["model"] == "grok-2-vision-1212"  # auto-bumped
    msgs = payload["messages"]
    assert len(msgs) == 1
    user_msg = msgs[0]
    assert user_msg["role"] == "user"
    assert isinstance(user_msg["content"], list)
    text_parts = [c for c in user_msg["content"] if c["type"] == "text"]
    img_parts = [c for c in user_msg["content"] if c["type"] == "image_url"]
    assert text_parts == [{"type": "text", "text": "describe this"}]
    assert len(img_parts) == 1
    # Verify the data URL embeds the file's actual bytes.
    expected_b64 = base64.b64encode(b"\xff\xd8\xff fakejpg").decode()
    assert expected_b64 in img_parts[0]["image_url"]["url"]
    assert img_parts[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")


@pytest.mark.asyncio
async def test_run_rejects_oversized_attachment(
    tmp_secrets_path, monkeypatch, tmp_path
):
    """Defense — provider drops >5MB attachments before hitting xAI to
    avoid eating a long upload + their rejection round-trip."""
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    big = tmp_path / "big.jpg"
    big.write_bytes(b"x" * (5 * 1024 * 1024 + 1))
    # No httpx mock — if the provider tries to send, it'll hit a real network
    # error. The test asserts we raise BEFORE that.
    with pytest.raises(LLMError, match="too large"):
        await p.run("describe", attachments=[str(big)])


# ── run — error paths ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_raises_when_no_api_key(tmp_secrets_path):
    p = GrokProvider()
    with pytest.raises(LLMError, match="API key not configured"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_http_4xx(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("grok", "xai-bad")
    p = GrokProvider()
    _patch_httpx(
        monkeypatch,
        _MockResponse(401, {"error": {"message": "Invalid API key"}}),
    )
    with pytest.raises(LLMError, match="HTTP 401"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_http_5xx(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    _patch_httpx(monkeypatch, _MockResponse(503, "service unavailable"))
    with pytest.raises(LLMError, match="HTTP 503"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_malformed_response(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    _patch_httpx(monkeypatch, _MockResponse(200, {"unexpected": "shape"}))
    with pytest.raises(LLMError, match="missing content"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_handles_transport_errors(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()

    class _ExplodingClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def post(self, *args, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", _ExplodingClient)
    with pytest.raises(LLMError, match="transport error"):
        await p.run("hi")


# ── error-message extraction ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_error_body_truncated_to_200_chars(tmp_secrets_path, monkeypatch):
    """Error messages from the provider must not balloon log output —
    truncate to 200 chars."""
    secrets.set_api_key("grok", "xai-1")
    p = GrokProvider()
    long_msg = "x" * 500
    _patch_httpx(
        monkeypatch, _MockResponse(400, {"error": {"message": long_msg}})
    )
    with pytest.raises(LLMError) as exc:
        await p.run("hi")
    # The error message we raise should be capped — the long_msg shouldn't
    # appear in full.
    assert long_msg not in str(exc.value)
