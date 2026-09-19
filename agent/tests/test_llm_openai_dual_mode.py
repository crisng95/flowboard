"""Tests for the OpenAI provider's dual-mode dispatch.

Covers the cross-product the UI Spec lays out — Codex CLI present /
absent, vision flag detected / not, API key configured / not, and the
mode-selection logic that picks between CLI and API per dispatch based
on whether attachments are present.

No real subprocess + no real network. Both transports are stubbed.

The provider invokes ``codex`` synchronously via ``subprocess.run`` (a
deliberate Windows-compat choice — asyncio subprocess on Windows requires
``ProactorEventLoop`` which FastAPI doesn't use). Tests stub
``subprocess.run`` at the module boundary.

The CLI contract changed with codex-cli 0.155.0 and these tests pin the
new one: ``--output-format`` no longer exists, ``-p`` now means
``--profile`` (not "prompt"), the prompt is a positional argument, and
the answer comes back through ``-o <file>`` rather than a stdout JSON
envelope. The stub dispatcher therefore writes to the ``-o`` path the
provider passes it, exactly as the real binary does.
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


def _route_dispatch(answer: str, *, image_flag: Optional[str] = "--image"):
    """Probe + dispatch in one dispatcher: --version/--help return probe
    fixtures, anything else behaves like ``codex exec`` — it writes the
    final message to the file named after ``-o`` and exits 0."""
    probe = _route_probe(help_image_flag=image_flag)

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv or "--help" in argv:
            return probe(argv, kwargs)
        Path(argv[argv.index("-o") + 1]).write_text(answer)
        return _FakeResult(returncode=0)

    return dispatcher


def _dispatch_calls(state) -> list[tuple[list[str], dict]]:
    """Recorded subprocess calls minus the --version / --help probes."""
    return [
        (argv, kwargs) for argv, kwargs in state["calls"]
        if "--version" not in argv and "--help" not in argv
    ]


@pytest.mark.asyncio
async def test_run_text_via_cli_when_codex_available(
    tmp_secrets_path, monkeypatch
):
    """The corrected invocation: prompt positional, answer via ``-o``."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _route_dispatch("hello text"))
    out = await p.run("hi", system_prompt="be terse")
    assert out == "hello text"
    dispatch_calls = _dispatch_calls(state)
    assert len(dispatch_calls) == 1
    argv, kwargs = dispatch_calls[0]
    assert argv[1] == "exec"
    assert "--skip-git-repo-check" in argv
    assert argv[argv.index("--sandbox") + 1] == "read-only"
    # Prompt is the last positional token, system prompt folded in.
    assert argv[-1].endswith("hi")
    assert "[System: be terse]" in argv[-1]


@pytest.mark.asyncio
async def test_run_cli_does_not_emit_the_dead_flags(tmp_secrets_path, monkeypatch):
    """Regression guard for the flag migration. On codex-cli 0.155.0
    ``--output-format`` is gone ("error: unexpected argument
    '--output-format' found") and ``-p`` means ``--profile``, so the old
    ``codex exec --output-format json -p -`` failed before the model was
    ever reached. Neither may come back."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _route_dispatch("ok"))
    await p.run("hi", system_prompt="be terse")
    argv, kwargs = _dispatch_calls(state)[0]
    assert "--output-format" not in argv
    assert "-p" not in argv           # would now be read as --profile
    assert "--profile" not in argv
    assert "--system" not in argv     # codex exec has no --system either
    # The prompt must not be piped: codex appends piped stdin to the
    # prompt as a `<stdin>` block, duplicating what we passed positionally.
    assert kwargs.get("input") is None
    assert kwargs.get("stdin") is _subprocess.DEVNULL


@pytest.mark.asyncio
async def test_run_cli_passes_model_and_effort(tmp_secrets_path, monkeypatch):
    """Codex has no dedicated effort flag — reasoning depth rides on the
    generic ``-c`` config override, whose value is parsed as TOML (hence
    the embedded quotes)."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _route_dispatch("ok"))
    await p.run("hi", model="gpt-5.6-sol", effort="high")
    argv, _kwargs = _dispatch_calls(state)[0]
    assert argv[argv.index("-m") + 1] == "gpt-5.6-sol"
    assert argv[argv.index("-c") + 1] == 'model_reasoning_effort="high"'


@pytest.mark.asyncio
async def test_run_cli_omits_model_and_effort_when_unset(
    tmp_secrets_path, monkeypatch
):
    """Unset leaves ~/.codex/config.toml's own model/effort in charge."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _route_dispatch("ok"))
    await p.run("hi")
    argv, _kwargs = _dispatch_calls(state)[0]
    assert "-m" not in argv
    assert "-c" not in argv


@pytest.mark.asyncio
async def test_run_cli_cleans_up_the_output_file(tmp_secrets_path, monkeypatch):
    """One temp file per dispatch would otherwise pile up for the life of
    the agent process."""
    seen: dict = {}
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    probe = _route_probe()

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv or "--help" in argv:
            return probe(argv, kwargs)
        seen["path"] = argv[argv.index("-o") + 1]
        Path(seen["path"]).write_text("answer")
        return _FakeResult(returncode=0)

    _stub_run(monkeypatch, dispatcher)
    assert await p.run("hi") == "answer"
    assert not Path(seen["path"]).exists()


@pytest.mark.asyncio
async def test_run_cli_cleans_up_the_output_file_on_failure(
    tmp_secrets_path, monkeypatch
):
    seen: dict = {}
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    probe = _route_probe()

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv or "--help" in argv:
            return probe(argv, kwargs)
        seen["path"] = argv[argv.index("-o") + 1]
        return _FakeResult(returncode=1, stderr=b"boom")

    _stub_run(monkeypatch, dispatcher)
    with pytest.raises(LLMError):
        await p.run("hi")
    assert not Path(seen["path"]).exists()


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
        _route_dispatch("described", image_flag="--image"),
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
    _stub_run(monkeypatch, _route_dispatch("text answer", image_flag=None))
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
async def test_cli_empty_output_file_raises(tmp_secrets_path, monkeypatch):
    """Exit 0 but nothing written means the turn ended without a final
    assistant message. Handing callers "" would push the failure three
    layers downstream into a JSON parser — same class of bug the Gemini
    provider guards against."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _route_dispatch("   \n"))
    with pytest.raises(LLMError, match="empty response"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_cli_failure_surfaces_stdout_detail(tmp_secrets_path, monkeypatch):
    """Codex writes API errors to stdout (its event log), not stderr — a
    400 with an empty stderr must still produce a useful message."""
    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    probe = _route_probe()

    def dispatcher(argv: list[str], kwargs: dict) -> _FakeResult:
        if "--version" in argv or "--help" in argv:
            return probe(argv, kwargs)
        return _FakeResult(
            returncode=1,
            stdout=b'ERROR: {"error": {"message": "Invalid value: \'bogus\'"}}',
            stderr=b"",
        )

    _stub_run(monkeypatch, dispatcher)
    with pytest.raises(LLMError, match="Invalid value"):
        await p.run("hi")


# ── model catalog + effort ladder ─────────────────────────────────────


@pytest.mark.asyncio
async def test_list_models_returns_static_catalog(tmp_secrets_path):
    """`codex models` needs a terminal ("Error: stdin is not a terminal"),
    so there is nothing to shell out to from a FastAPI worker — the
    catalog is static and must not spawn a subprocess."""
    p = OpenAIProvider()
    models = await p.list_models()
    assert {"id": "gpt-5.6-sol", "label": "GPT-5.6-Sol"} in models
    assert all(set(m) == {"id", "label"} for m in models)
    # Hidden/internal routing targets are not user-selectable.
    assert all(m["id"] not in ("gpt-reserve", "codex-auto-review") for m in models)


def test_provider_declares_codex_effort_ladder():
    """Intersection of the API's enum and every listed model's supported
    levels. ``none``/``minimal`` are API-only and ``ultra`` is
    model-specific, so neither is offered."""
    p = OpenAIProvider()
    assert p.supports_effort is True
    assert p.efforts == ["low", "medium", "high", "xhigh", "max"]


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


# ── Event-loop discipline ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cli_dispatch_does_not_park_the_event_loop(
    tmp_secrets_path, monkeypatch
):
    """`subprocess.run` stays for the Windows `.cmd` reason above, but
    runs in a worker thread.

    One loop carries the generation worker, the extension WebSocket and
    every HTTP route. The `--version` / `--help` probes behind
    `is_available()` are reached from `/api/llm/providers`, which an
    always-mounted badge polls every 30s; a Codex turn itself can run for
    minutes.
    """
    import asyncio
    import time as _time

    p = OpenAIProvider()
    _stub_resolve(monkeypatch)
    inner = _route_dispatch("hello text")

    def _slow(argv, kwargs):
        _time.sleep(0.12)
        return inner(argv, kwargs)

    _stub_run(monkeypatch, _slow)

    ticks = 0

    async def _tick():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    ticker = asyncio.create_task(_tick())
    try:
        out = await p.run("hi")
    finally:
        ticker.cancel()

    assert out == "hello text"
    # Three blocking calls here (--version, --help, dispatch); any one of
    # them holding the loop would leave this near zero.
    assert ticks >= 5, "the event loop was parked for the whole subprocess call"
