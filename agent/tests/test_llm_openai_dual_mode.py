"""Tests for the OpenAI provider's dual-mode dispatch.

Covers the cross-product the UI Spec lays out — Codex CLI present /
absent, vision flag detected / not, API key configured / not, and the
mode-selection logic that picks between CLI and API per dispatch based
on whether attachments are present.

No real subprocess + no real network. Both transports are stubbed.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from flowboard.services.llm import secrets
from flowboard.services.llm.base import LLMError
from flowboard.services.llm.openai import OpenAIProvider


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


# ── subprocess helpers ────────────────────────────────────────────────


class _FakeProc:
    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0):
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode

    async def communicate(self):
        return self._stdout, self._stderr

    def kill(self):
        pass


def _spawn_sequence(*procs: _FakeProc):
    """Returns a side_effect that pops one fake proc per subprocess call."""
    iterator = iter(procs)

    async def _spawn(*_args, **_kwargs):
        try:
            return next(iterator)
        except StopIteration:
            raise AssertionError(f"unexpected extra subprocess call: {_args}")

    return _spawn


def _no_codex(*_a, **_kw):
    """side_effect that simulates `codex` not being on PATH."""
    raise FileNotFoundError("codex")


# ── httpx helpers ─────────────────────────────────────────────────────


class _MockResponse:
    def __init__(self, status_code: int, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _MockClient:
    def __init__(self, *args, response: _MockResponse, capture: dict, **kwargs):
        self._response = response
        self._capture = capture

    async def __aenter__(self): return self
    async def __aexit__(self, *args): return None

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


# ── CLI probe ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_probe_cli_unavailable_when_binary_missing(
    tmp_secrets_path, monkeypatch
):
    p = OpenAIProvider()
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    await p._probe_cli()
    assert p._cli_available is False
    assert p._cli_image_flag is None


@pytest.mark.asyncio
async def test_probe_cli_resolves_image_flag(tmp_secrets_path, monkeypatch):
    """Codex installed + --help advertises --image → _cli_image_flag set."""
    p = OpenAIProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_sequence(
            _FakeProc(stdout=b"codex 1.0\n", returncode=0),  # --version
            _FakeProc(stdout=b"  --image PATH\n", returncode=0),  # --help
        ),
    )
    await p._probe_cli()
    assert p._cli_available is True
    assert p._cli_image_flag == "--image"


@pytest.mark.asyncio
async def test_probe_cli_text_only_when_no_image_flag(tmp_secrets_path, monkeypatch):
    """Codex installed but --help doesn't advertise an image flag → text-only."""
    p = OpenAIProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_sequence(
            _FakeProc(stdout=b"codex 0.x\n", returncode=0),
            _FakeProc(stdout=b"  -p PROMPT\n  --json\n", returncode=0),
        ),
    )
    await p._probe_cli()
    assert p._cli_available is True
    assert p._cli_image_flag is None


@pytest.mark.asyncio
async def test_probe_cli_runs_at_most_once(tmp_secrets_path, monkeypatch):
    """The probe should be a one-shot — `_cli_probed` short-circuits
    re-runs even after timeouts / errors."""
    p = OpenAIProvider()
    spawn = AsyncMock(return_value=_FakeProc(returncode=0))
    monkeypatch.setattr("asyncio.create_subprocess_exec", spawn)
    await p._probe_cli()
    await p._probe_cli()
    await p._probe_cli()
    # First probe = --version + --help = 2 spawns; subsequent calls = 0.
    assert spawn.call_count == 2


# ── is_available ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_available_false_without_cli_or_key(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_true_with_cli_only(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_sequence(
            _FakeProc(stdout=b"codex 1.0\n", returncode=0),
            _FakeProc(stdout=b"  --image PATH\n", returncode=0),
        ),
    )
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_is_available_true_with_api_key_only(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    secrets.set_api_key("openai", "sk-1")
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    assert await p.is_available() is True


# ── mode property ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mode_returns_cli_when_codex_available(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_sequence(
            _FakeProc(stdout=b"codex 1.0\n", returncode=0),
            _FakeProc(stdout=b"  --image PATH\n", returncode=0),
        ),
    )
    await p.is_available()
    assert p.mode == "cli"


@pytest.mark.asyncio
async def test_mode_returns_api_when_only_key(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    secrets.set_api_key("openai", "sk-1")
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    await p.is_available()
    assert p.mode == "api"


@pytest.mark.asyncio
async def test_mode_returns_none_when_nothing_configured(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    await p.is_available()
    assert p.mode == "none"


# ── run — CLI dispatch ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_text_via_cli_when_codex_available(
    tmp_secrets_path, monkeypatch
):
    p = OpenAIProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        # First call = --version, second = --help, third = exec
        if "--version" in args:
            return _FakeProc(stdout=b"codex 1.0\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  --image PATH\n", returncode=0)
        # exec call — capture and return success envelope
        captured["args"] = args
        return _FakeProc(stdout=b'{"result": "hello text"}\n', returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    out = await p.run("hi", system_prompt="be terse")
    assert out == "hello text"
    args = captured["args"]
    assert "exec" in args
    assert "-p" in args
    assert "hi" in args
    assert "--system" in args


@pytest.mark.asyncio
async def test_run_vision_via_cli_when_image_flag_resolved(
    tmp_secrets_path, monkeypatch, tmp_path
):
    """Codex CLI with vision flag → vision dispatches stay on CLI, never
    fall through to API even if a key is also set."""
    secrets.set_api_key("openai", "sk-fallback-key")  # available but should not be used
    img = tmp_path / "x.jpg"
    img.write_bytes(b"fake")

    p = OpenAIProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        if "--version" in args:
            return _FakeProc(stdout=b"codex 1.0\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  --image PATH\n", returncode=0)
        captured["args"] = args
        return _FakeProc(stdout=b'{"result": "described"}\n', returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    # Stub httpx to assert it's never called.
    httpx_called = {"n": 0}

    class _ShouldNotBeUsed:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): httpx_called["n"] += 1; return self
        async def __aexit__(self, *a): return None

    monkeypatch.setattr(httpx, "AsyncClient", _ShouldNotBeUsed)
    out = await p.run("describe", attachments=[str(img)])
    assert out == "described"
    assert httpx_called["n"] == 0
    assert "--image" in captured["args"]


# ── run — vision fallback to API when Codex is text-only ─────────────


@pytest.mark.asyncio
async def test_run_vision_falls_back_to_api_when_codex_text_only(
    tmp_secrets_path, monkeypatch, tmp_path
):
    """The headline test — Codex is installed + auth but text-only, an
    OpenAI API key IS configured: vision dispatches must use API mode
    while text dispatches stay on CLI."""
    secrets.set_api_key("openai", "sk-vision-fallback")
    img = tmp_path / "x.jpg"
    img.write_bytes(b"\xff\xd8\xff fake")

    p = OpenAIProvider()

    async def _spawn(*args, **_kwargs):
        if "--version" in args:
            return _FakeProc(stdout=b"codex 0.x\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  -p PROMPT\n", returncode=0)  # no image flag
        # If we land here, the test failed — vision should have gone to API.
        raise AssertionError(f"vision dispatch hit CLI when it should hit API: {args}")

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    capture = _patch_httpx(
        monkeypatch,
        _MockResponse(200, {"choices": [{"message": {"content": "v-described"}}]}),
    )
    out = await p.run("describe", attachments=[str(img)])
    assert out == "v-described"
    assert capture["url"] == "https://api.openai.com/v1/chat/completions"
    assert capture["headers"]["authorization"] == "Bearer sk-vision-fallback"
    # Auto-bumped to vision-capable model.
    assert capture["json"]["model"] == "gpt-4o"


@pytest.mark.asyncio
async def test_run_vision_text_only_codex_no_key_raises_clear_error(
    tmp_secrets_path, monkeypatch, tmp_path
):
    """Worst case: Codex installed + auth + text-only, no API key. The
    error must point the user to Settings clearly."""
    img = tmp_path / "x.jpg"
    img.write_bytes(b"fake")

    p = OpenAIProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_sequence(
            _FakeProc(stdout=b"codex 0.x\n", returncode=0),
            _FakeProc(stdout=b"  -p PROMPT\n", returncode=0),
        ),
    )
    with pytest.raises(LLMError, match="does not support vision"):
        await p.run("describe", attachments=[str(img)])


@pytest.mark.asyncio
async def test_run_text_via_codex_text_only_works(
    tmp_secrets_path, monkeypatch
):
    """Text-only Codex still serves text dispatches just fine — only vision
    falls back. Sanity check that the mode-routing doesn't over-trigger."""
    p = OpenAIProvider()

    async def _spawn(*args, **_kwargs):
        if "--version" in args:
            return _FakeProc(stdout=b"codex 0.x\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  -p PROMPT\n", returncode=0)
        return _FakeProc(stdout=b'{"result": "text answer"}\n', returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    out = await p.run("hi")
    assert out == "text answer"


# ── run — API-only path ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_api_only_when_no_cli(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("openai", "sk-api-only")
    p = OpenAIProvider()
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    capture = _patch_httpx(
        monkeypatch,
        _MockResponse(200, {"choices": [{"message": {"content": "answer"}}]}),
    )
    out = await p.run("hi")
    assert out == "answer"
    assert capture["json"]["model"] == "gpt-5"  # text default
    assert capture["headers"]["authorization"] == "Bearer sk-api-only"


@pytest.mark.asyncio
async def test_run_raises_when_neither_cli_nor_key(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_codex)
    with pytest.raises(LLMError, match="not configured"):
        await p.run("hi")


# ── CLI envelope error handling ───────────────────────────────────────


@pytest.mark.asyncio
async def test_cli_envelope_error_field_raises(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()

    async def _spawn(*args, **_kwargs):
        if "--version" in args:
            return _FakeProc(stdout=b"codex 1.0\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  --image PATH\n", returncode=0)
        return _FakeProc(
            stdout=b'{"is_error": true, "error": "auth required"}\n',
            returncode=0,
        )

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    with pytest.raises(LLMError, match="codex CLI reported error"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_cli_envelope_accepts_alternate_field_names(
    tmp_secrets_path, monkeypatch
):
    """Codex CLI's output field name has shifted between versions — accept
    `result`, `output_text`, or `text`."""
    p = OpenAIProvider()

    async def _spawn(*args, **_kwargs):
        if "--version" in args:
            return _FakeProc(stdout=b"codex 1.0\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  --image PATH\n", returncode=0)
        return _FakeProc(stdout=b'{"output_text": "via output_text"}\n', returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    out = await p.run("hi")
    assert out == "via output_text"


@pytest.mark.asyncio
async def test_cli_nonzero_exit_raises(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()

    async def _spawn(*args, **_kwargs):
        if "--version" in args:
            return _FakeProc(stdout=b"codex 1.0\n", returncode=0)
        if "--help" in args:
            return _FakeProc(stdout=b"  --image PATH\n", returncode=0)
        return _FakeProc(stderr=b"login required", returncode=1)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    with pytest.raises(LLMError, match="codex CLI exited 1"):
        await p.run("hi")
