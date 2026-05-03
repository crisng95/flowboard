"""Tests for the OpenAI provider's dual-mode dispatch.

Covers the cross-product the UI Spec lays out — Codex CLI present /
absent, vision flag detected / not, API key configured / not, and the
mode-selection logic that picks between CLI and API per dispatch based
on whether attachments are present.

No real subprocess + no real network. Both transports are stubbed.

The provider invokes ``codex`` synchronously via ``subprocess.run`` (a
deliberate Windows-compat choice — asyncio subprocess on Windows requires
``ProactorEventLoop`` which FastAPI doesn't use). Tests stub
``subprocess.run`` at the module boundary. Stdin-based prompt delivery
(see test_run_text_via_cli) sidesteps the cmd.exe argv re-parser that
mangles long prompts on ``.cmd``-shimmed npm installs.
"""
from __future__ import annotations

import subprocess as _subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

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


@dataclass
class _FakeResult:
    returncode: int = 0
    stdout: bytes = b""
    stderr: bytes = b""


def _stub_resolve(monkeypatch, path: str = "/fake/bin/codex"):
    monkeypatch.setattr(
        "flowboard.services.llm.openai.resolve_cli_binary",
        lambda *_a, **_kw: path,
    )


def _stub_run(monkeypatch, dispatcher: Callable[[list[str], dict], _FakeResult]):
    """Patch ``subprocess.run`` and route each call through ``dispatcher``.

    The dispatcher receives the argv list + kwargs and decides what to
    return. This shape lets each test branch on ``--version`` /
    ``--help`` / actual dispatch arg patterns.
    """
    state: dict = {"calls": []}

    def _run(*args, **kwargs):
        argv = list(args[0])
        state["calls"].append((argv, kwargs))
        return dispatcher(argv, kwargs)

    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _run)
    return state


def _missing_codex(*_a, **_kw):
    """Patch subprocess.run to raise FileNotFoundError (codex not on PATH)."""
    raise FileNotFoundError("codex")


def _route_probe(version_rc: int = 0, help_image_flag: Optional[str] = "--image"):
    """Return a dispatcher that handles only ``--version`` and ``--help``
    (any other argv pattern triggers an AssertionError — useful for tests
    that should not reach the dispatch path).
    """
    help_text = (
        f"  {help_image_flag} PATH\n".encode()
        if help_image_flag
        else b"  -p PROMPT\n  --json\n"
    )

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv:
            return _FakeResult(returncode=version_rc, stdout=b"codex 1.0\n")
        if "--help" in argv:
            return _FakeResult(returncode=0, stdout=help_text)
        raise AssertionError(f"unexpected dispatch argv: {argv}")

    return dispatcher


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
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
    await p._probe_cli()
    assert p._cli_available is False
    assert p._cli_image_flag is None


@pytest.mark.asyncio
async def test_probe_cli_resolves_image_flag(tmp_secrets_path, monkeypatch):
    """Codex installed + --help advertises --image → _cli_image_flag set."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _route_probe(help_image_flag="--image"))
    await p._probe_cli()
    assert p._cli_available is True
    assert p._cli_image_flag == "--image"


@pytest.mark.asyncio
async def test_probe_cli_text_only_when_no_image_flag(tmp_secrets_path, monkeypatch):
    """Codex installed but --help doesn't advertise an image flag → text-only."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _route_probe(help_image_flag=None))
    await p._probe_cli()
    assert p._cli_available is True
    assert p._cli_image_flag is None


@pytest.mark.asyncio
async def test_probe_cli_runs_at_most_once(tmp_secrets_path, monkeypatch):
    """The probe should be a one-shot — `_cli_probed` short-circuits
    re-runs even after timeouts / errors."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _route_probe())
    await p._probe_cli()
    await p._probe_cli()
    await p._probe_cli()
    # First probe = --version + --help = 2 spawns; subsequent calls = 0.
    assert len(state["calls"]) == 2


# ── is_available ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_available_false_without_cli_or_key(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_true_with_cli_only(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _route_probe())
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_is_available_true_with_api_key_only(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    secrets.set_api_key("openai", "sk-1")
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
    assert await p.is_available() is True


# ── mode property ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mode_returns_cli_when_codex_available(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _route_probe())
    await p.is_available()
    assert p.mode == "cli"


@pytest.mark.asyncio
async def test_mode_returns_api_when_only_key(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    secrets.set_api_key("openai", "sk-1")
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
    await p.is_available()
    assert p.mode == "api"


@pytest.mark.asyncio
async def test_mode_returns_none_when_nothing_configured(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
    await p.is_available()
    assert p.mode == "none"


# ── run — CLI dispatch ────────────────────────────────────────────────


def _route_dispatch(envelope_stdout: bytes, *, image_flag: Optional[str] = "--image"):
    """Probe + dispatch in one dispatcher: --version/--help return probe
    fixtures, anything else returns the supplied envelope."""
    probe = _route_probe(help_image_flag=image_flag)

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv or "--help" in argv:
            return probe(argv, kwargs)
        return _FakeResult(returncode=0, stdout=envelope_stdout)

    return dispatcher


@pytest.mark.asyncio
async def test_run_text_via_cli_when_codex_available(
    tmp_secrets_path, monkeypatch
):
    """Critical Windows fix: prompt is delivered via stdin (kwargs['input'])
    rather than ``-p <prompt>`` argv. Same ``.cmd`` shim rationale as
    claude_cli — cmd.exe re-parses argv for ``.cmd`` shims and mangles
    long prompts. ``-p -`` argv signals stdin to codex."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(
        monkeypatch,
        _route_dispatch(b'{"result": "hello text"}\n'),
    )
    out = await p.run("hi", system_prompt="be terse")
    assert out == "hello text"
    # Pull the dispatch call (skip --version + --help probes).
    dispatch_calls = [
        (argv, kwargs) for argv, kwargs in state["calls"]
        if "--version" not in argv and "--help" not in argv
    ]
    assert len(dispatch_calls) == 1
    argv, kwargs = dispatch_calls[0]
    assert "exec" in argv
    assert "-p" in argv and "-" in argv
    # Prompt is on stdin, not in argv.
    assert kwargs["input"] == b"hi"
    assert "hi" not in argv
    assert "--system" in argv


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
    _stub_resolve(monkeypatch)
    state = _stub_run(
        monkeypatch,
        _route_dispatch(b'{"result": "described"}\n', image_flag="--image"),
    )
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
    dispatch_calls = [
        argv for argv, _kw in state["calls"]
        if "--version" not in argv and "--help" not in argv
    ]
    assert len(dispatch_calls) == 1
    assert "--image" in dispatch_calls[0]


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
    _stub_resolve(monkeypatch)

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv:
            return _FakeResult(returncode=0, stdout=b"codex 0.x\n")
        if "--help" in argv:
            return _FakeResult(returncode=0, stdout=b"  -p PROMPT\n")  # no image flag
        # If we land here, the test failed — vision should have gone to API.
        raise AssertionError(f"vision dispatch hit CLI when it should hit API: {argv}")

    _stub_run(monkeypatch, dispatcher)
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
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _route_probe(help_image_flag=None))
    with pytest.raises(LLMError, match="does not support vision"):
        await p.run("describe", attachments=[str(img)])


@pytest.mark.asyncio
async def test_run_text_via_codex_text_only_works(
    tmp_secrets_path, monkeypatch
):
    """Text-only Codex still serves text dispatches just fine — only vision
    falls back. Sanity check that the mode-routing doesn't over-trigger."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _route_dispatch(b'{"result": "text answer"}\n', image_flag=None),
    )
    out = await p.run("hi")
    assert out == "text answer"


# ── run — API-only path ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_api_only_when_no_cli(tmp_secrets_path, monkeypatch):
    secrets.set_api_key("openai", "sk-api-only")
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
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
    _stub_resolve(monkeypatch)
    monkeypatch.setattr("flowboard.services.llm.openai.subprocess.run", _missing_codex)
    with pytest.raises(LLMError, match="not configured"):
        await p.run("hi")


# ── CLI envelope error handling ───────────────────────────────────────


@pytest.mark.asyncio
async def test_cli_envelope_error_field_raises(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _route_dispatch(b'{"is_error": true, "error": "auth required"}\n'),
    )
    with pytest.raises(LLMError, match="codex CLI reported error"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_cli_envelope_accepts_alternate_field_names(
    tmp_secrets_path, monkeypatch
):
    """Codex CLI's output field name has shifted between versions — accept
    `result`, `output_text`, or `text`."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _route_dispatch(b'{"output_text": "via output_text"}\n'),
    )
    out = await p.run("hi")
    assert out == "via output_text"


@pytest.mark.asyncio
async def test_cli_nonzero_exit_raises(tmp_secrets_path, monkeypatch):
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv:
            return _FakeResult(returncode=0, stdout=b"codex 1.0\n")
        if "--help" in argv:
            return _FakeResult(returncode=0, stdout=b"  --image PATH\n")
        return _FakeResult(returncode=1, stderr=b"login required")

    _stub_run(monkeypatch, dispatcher)
    with pytest.raises(LLMError, match="codex CLI exited 1"):
        await p.run("hi")
