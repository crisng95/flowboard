"""Tests for the Gemini provider.

The provider invokes ``gemini`` synchronously via ``subprocess.run`` (a
deliberate Windows-compat choice — asyncio subprocess on Windows requires
``ProactorEventLoop`` which FastAPI doesn't use). Tests stub
``subprocess.run`` at the module boundary and assert on the argv it
receives plus the JSON envelope it returns.

CLI args under test:
- ``-m <model>``     stable-tier pin (default ``gemini-2.5-flash``)
- ``-o json``        structured envelope, parsed into ``response`` field
- ``-p <prompt>``    user prompt (system + attachments folded in body)
"""
from __future__ import annotations

import subprocess as _subprocess
from dataclasses import dataclass

import pytest

from flowboard.services.llm.base import LLMError
from flowboard.services.llm.gemini import GeminiProvider


@dataclass
class _FakeResult:
    """Stand-in for ``subprocess.CompletedProcess`` shape used by the provider."""
    returncode: int = 0
    stdout: bytes = b""
    stderr: bytes = b""


def _envelope(response: str) -> bytes:
    """Build a realistic ``-o json`` stdout envelope for stubbing."""
    import json
    return json.dumps({
        "session_id": "00000000-0000-0000-0000-000000000000",
        "response": response,
        "stats": {"models": {}},
    }).encode("utf-8")


def _stub_run(monkeypatch, returns):
    """Patch subprocess.run on the gemini module. ``returns`` may be a
    single _FakeResult or a list (consumed in order) or a callable
    ``(args, kwargs) -> _FakeResult`` for inspection-style tests."""
    state = {"calls": []}
    if callable(returns):
        def _run(*args, **kwargs):
            state["calls"].append((args, kwargs))
            return returns(args, kwargs)
    elif isinstance(returns, list):
        it = iter(returns)
        def _run(*args, **kwargs):
            state["calls"].append((args, kwargs))
            return next(it)
    else:
        def _run(*args, **kwargs):
            state["calls"].append((args, kwargs))
            return returns
    monkeypatch.setattr(
        "flowboard.services.llm.gemini.subprocess.run", _run,
    )
    return state


def _stub_resolve(monkeypatch, path: str = "/fake/bin/gemini"):
    """Pin the resolved binary path so PATH lookup doesn't leak."""
    monkeypatch.setattr(
        "flowboard.services.llm.gemini.resolve_cli_binary",
        lambda *_a, **_kw: path,
    )


# ── is_available ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_available_true_when_version_succeeds(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"gemini 0.38.0\n"))
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_is_available_false_when_binary_missing(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise FileNotFoundError("gemini")
    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _raise)
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_false_when_version_nonzero(monkeypatch):
    """CLI installed but the binary returns non-zero (e.g. incompatible
    Node version) — treat as unavailable."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=1, stderr=b"node ver mismatch"))
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_caches_after_first_probe(monkeypatch):
    """Probe should be cheap — don't re-spawn `gemini --version` per dispatch."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"gemini 0.38.0\n"))
    await p.is_available()
    await p.is_available()
    await p.is_available()
    assert len(state["calls"]) == 1


# ── run — prompt composition ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_returns_envelope_response_field(monkeypatch):
    """``-o json`` envelope shape: ``{response: "<text>", ...}``. The
    provider extracts ``response`` and discards everything else."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("hello world")))
    out = await p.run("hi")
    assert out == "hello world"


@pytest.mark.asyncio
async def test_run_emits_o_json_flag(monkeypatch):
    """Argv must include ``-o json`` so the CLI emits structured output
    instead of raw text mixed with banner / tip / ANSI noise."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("hi")
    argv = list(state["calls"][0][0][0])
    assert "-o" in argv
    assert argv[argv.index("-o") + 1] == "json"


@pytest.mark.asyncio
async def test_run_raises_when_envelope_is_not_json(monkeypatch):
    """If the CLI emits text outside the JSON shape (e.g. login banner
    consumed all of stdout), surface a clear LLMError instead of
    silently returning garbage."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"Loaded cached credentials\n"))
    with pytest.raises(LLMError, match="non-JSON output"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_when_envelope_missing_response_field(monkeypatch):
    """Defensive: if the envelope shape changes upstream and ``response``
    disappears, fail loud rather than returning the empty string."""
    import json
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _FakeResult(returncode=0, stdout=json.dumps({"session_id": "x"}).encode()),
    )
    with pytest.raises(LLMError, match="missing string 'response'"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_passes_prompt_as_argv_token(monkeypatch):
    """Prompt with quotes/newlines reaches the CLI verbatim via argv."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    tricky = 'a "quoted" $VAR\nnewline'
    await p.run(tricky)
    argv = list(state["calls"][0][0][0])
    p_idx = argv.index("-p")
    assert argv[p_idx + 1] == tricky


@pytest.mark.asyncio
async def test_run_prepends_system_prompt_into_body(monkeypatch):
    """The CLI has no `--system` flag (verified against the real binary's
    `--help`), so the system prompt is folded into the prompt body as a
    `[System: ...]` block separated by a blank line."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("user question", system_prompt="be terse")
    argv = list(state["calls"][0][0][0])
    prompt = argv[argv.index("-p") + 1]
    assert "[System: be terse]" in prompt
    assert "user question" in prompt
    assert prompt.index("[System:") < prompt.index("user question")
    assert "--system" not in argv


@pytest.mark.asyncio
async def test_run_pins_stable_model_via_m_flag(monkeypatch):
    """Default pins `gemini-2.5-flash` (stable tier) via `-m` to avoid
    Gemini CLI's Auto-mode default of `gemini-3-flash-preview`, which
    Google routinely 429s with MODEL_CAPACITY_EXHAUSTED."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    monkeypatch.delenv("FLOWBOARD_GEMINI_MODEL", raising=False)
    await p.run("hi")
    argv = list(state["calls"][0][0][0])
    m_idx = argv.index("-m")
    assert argv[m_idx + 1] == "gemini-2.5-flash"
    assert "-preview" not in argv[m_idx + 1]


@pytest.mark.asyncio
async def test_run_respects_env_var_model_override(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    monkeypatch.setenv("FLOWBOARD_GEMINI_MODEL", "gemini-2.5-pro")
    await p.run("hi")
    argv = list(state["calls"][0][0][0])
    m_idx = argv.index("-m")
    assert argv[m_idx + 1] == "gemini-2.5-pro"


@pytest.mark.asyncio
async def test_run_no_system_prompt_omits_system_block(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("just the user prompt")
    argv = list(state["calls"][0][0][0])
    prompt = argv[argv.index("-p") + 1]
    assert "[System:" not in prompt
    assert prompt == "just the user prompt"


# ── run — image attachments via @path ─────────────────────────────────


@pytest.mark.asyncio
async def test_run_inlines_attachments_as_at_paths(monkeypatch, tmp_path):
    p = GeminiProvider()
    img1 = tmp_path / "a.jpg"; img1.write_bytes(b"fake")
    img2 = tmp_path / "b.jpg"; img2.write_bytes(b"fake")
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("describe", attachments=[str(img1), str(img2)])
    argv = list(state["calls"][0][0][0])
    prompt = argv[argv.index("-p") + 1]
    assert f"@{img1}" in prompt or f"@{img1.resolve()}" in prompt
    assert f"@{img2}" in prompt or f"@{img2.resolve()}" in prompt


@pytest.mark.asyncio
async def test_run_attachments_use_absolute_paths(monkeypatch, tmp_path):
    """@<path> tokens must be absolute so the CLI's cwd doesn't matter."""
    p = GeminiProvider()
    img = tmp_path / "x.jpg"; img.write_bytes(b"fake")
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("describe", attachments=[str(img)])
    argv = list(state["calls"][0][0][0])
    prompt = argv[argv.index("-p") + 1]
    assert "@/" in prompt


# ── run — error paths ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_raises_on_nonzero_exit(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=1, stderr=b"auth required"))
    with pytest.raises(LLMError, match="exited 1"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_quota_exhaustion(monkeypatch):
    """Specific path for 429 / 'exhausted' / 'quota' so callers can
    surface a quota-aware message rather than a generic exit-code error."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=1, stderr=b"429 quota exhausted"))
    with pytest.raises(LLMError, match="quota exhausted"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_missing_binary(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise FileNotFoundError("gemini")
    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _raise)
    with pytest.raises(LLMError, match="not found on PATH"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_timeout(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise _subprocess.TimeoutExpired(cmd="gemini", timeout=0.05)
    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _raise)
    with pytest.raises(LLMError, match="timed out"):
        await p.run("hi", timeout=0.05)
