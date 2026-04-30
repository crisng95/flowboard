"""Tests for the Gemini provider.

The Gemini CLI's non-interactive surface only has ``-p, --prompt`` — no
``--system`` and no image-attachment flag. Both are folded into the
prompt body (system prompt as a `[System: ...]` block, attachments as
``@<path>`` inline). These tests pin that contract.

No real `gemini` binary is invoked — ``asyncio.create_subprocess_exec``
is patched to return a fake process per test.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from flowboard.services.llm.base import LLMError
from flowboard.services.llm.gemini import GeminiProvider


class _FakeProc:
    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0):
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode

    async def communicate(self):
        return self._stdout, self._stderr

    def kill(self):  # noqa: D401
        pass


def _spawn_returning(*procs: _FakeProc):
    iterator = iter(procs)

    async def _spawn(*_args, **_kwargs):
        try:
            return next(iterator)
        except StopIteration:
            raise AssertionError("subprocess called more times than expected")

    return _spawn


# ── is_available ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_available_true_when_version_succeeds(monkeypatch):
    p = GeminiProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=b"gemini 0.30.0\n", returncode=0)),
    )
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_is_available_false_when_binary_missing(monkeypatch):
    p = GeminiProvider()
    async def _no_binary(*_a, **_kw):
        raise FileNotFoundError("gemini")
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_binary)
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_false_when_version_nonzero(monkeypatch):
    """CLI installed but the binary returns non-zero (e.g. incompatible
    Node version) — treat as unavailable."""
    p = GeminiProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stderr=b"node ver mismatch", returncode=1)),
    )
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_caches_after_first_probe(monkeypatch):
    """Probe should be cheap — don't re-spawn `gemini --version` per dispatch."""
    p = GeminiProvider()
    spawn_mock = AsyncMock(return_value=_FakeProc(returncode=0))
    monkeypatch.setattr("asyncio.create_subprocess_exec", spawn_mock)
    await p.is_available()
    await p.is_available()
    await p.is_available()
    assert spawn_mock.call_count == 1


# ── run — prompt composition ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_returns_stdout_stripped(monkeypatch):
    p = GeminiProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=b"hello world\n", returncode=0)),
    )
    out = await p.run("hi")
    assert out == "hello world"


@pytest.mark.asyncio
async def test_run_passes_prompt_as_argv_token(monkeypatch):
    """No shell — prompt with quotes/newlines reaches the CLI verbatim
    via argv, not mangled by shell substitution."""
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    tricky = 'a "quoted" $VAR\nnewline'
    await p.run(tricky)
    args = list(captured["args"])
    # `-p` carries the prompt as the next argv token. Locate it by name
    # rather than hardcoding the index — the argv now also includes
    # `-m <model>` for stable-model pinning, so positional asserts
    # would drift if the order changes again.
    p_idx = args.index("-p")
    assert args[p_idx + 1] == tricky


@pytest.mark.asyncio
async def test_run_prepends_system_prompt_into_body(monkeypatch):
    """The CLI has no `--system` flag (verified against the real binary's
    `--help`), so the system prompt is prepended into the prompt body
    as a `[System: ...]` block separated by a blank line."""
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("user question", system_prompt="be terse")
    args = list(captured["args"])
    prompt = args[args.index("-p") + 1]
    # Both the system block and the user prompt land in the SAME -p arg.
    assert "[System: be terse]" in prompt
    assert "user question" in prompt
    # System block precedes the user content.
    assert prompt.index("[System:") < prompt.index("user question")
    # NO `--system` flag should appear in the argv.
    assert "--system" not in args


@pytest.mark.asyncio
async def test_run_pins_stable_model_via_m_flag(monkeypatch):
    """Default pins `gemini-2.5-flash` (stable tier) via `-m`. Avoids
    Gemini CLI v0.38.2's Auto-mode default of `gemini-3-flash-preview`
    which Google routinely 429s with MODEL_CAPACITY_EXHAUSTED — even
    when the user's quota is fine — because preview models are
    capacity-throttled server-side. The CLI then retries with backoff,
    inflating per-call latency by 30+ seconds.

    `gemini-3-flash` (without `-preview` suffix) returns ModelNotFound
    on the CodeAssist backend, so we use `gemini-2.5-flash` instead."""
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    monkeypatch.delenv("FLOWBOARD_GEMINI_MODEL", raising=False)
    await p.run("hi")
    args = list(captured["args"])
    m_idx = args.index("-m")
    assert args[m_idx + 1] == "gemini-2.5-flash"
    # Regression guard — never default to a preview model.
    assert "-preview" not in args[m_idx + 1]


@pytest.mark.asyncio
async def test_run_respects_env_var_model_override(monkeypatch):
    """Operator can pin a stable model via FLOWBOARD_GEMINI_MODEL when
    the CLI's default Auto mode keeps landing on a capacity-exhausted
    preview variant. Stable values that work as `-m` arguments today:
    `gemini-2.5-flash`, `gemini-2.5-pro`."""
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    monkeypatch.setenv("FLOWBOARD_GEMINI_MODEL", "gemini-2.5-flash")
    await p.run("hi")
    args = list(captured["args"])
    m_idx = args.index("-m")
    assert args[m_idx + 1] == "gemini-2.5-flash"


@pytest.mark.asyncio
async def test_run_does_not_pass_system_flag(monkeypatch):
    """Regression guard — earlier versions of this provider passed
    `--system <text>` which the real CLI rejects (it prints `--help` to
    stderr and exits non-zero). Verify we never emit that flag."""
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("hi", system_prompt="anything")
    assert "--system" not in captured["args"]


@pytest.mark.asyncio
async def test_run_no_system_prompt_omits_system_block(monkeypatch):
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("just the user prompt")
    args = list(captured["args"])
    prompt = args[args.index("-p") + 1]
    assert "[System:" not in prompt
    assert prompt == "just the user prompt"


# ── run — image attachments via @path ─────────────────────────────────


@pytest.mark.asyncio
async def test_run_inlines_attachments_as_at_paths(monkeypatch, tmp_path):
    """Gemini CLI reads `@<path>` tokens from the prompt body and
    forwards the file as a multimodal block. Same pattern as Claude
    CLI — no `--image` flag exists. Verified live."""
    p = GeminiProvider()
    img1 = tmp_path / "a.jpg"; img1.write_bytes(b"fake")
    img2 = tmp_path / "b.jpg"; img2.write_bytes(b"fake")
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("describe", attachments=[str(img1), str(img2)])
    args = list(captured["args"])
    prompt = args[args.index("-p") + 1]
    # Both absolute paths appear with the @ prefix
    assert f"@{img1}" in prompt or f"@{img1.resolve()}" in prompt
    assert f"@{img2}" in prompt or f"@{img2.resolve()}" in prompt


@pytest.mark.asyncio
async def test_run_attachments_use_absolute_paths(monkeypatch, tmp_path):
    """@<path> tokens must be absolute so the CLI's cwd doesn't matter."""
    p = GeminiProvider()
    img = tmp_path / "x.jpg"; img.write_bytes(b"fake")
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("describe", attachments=[str(img)])
    args = list(captured["args"])
    prompt = args[args.index("-p") + 1]
    # The path embedded in the prompt is absolute (starts with `/`).
    assert "@/" in prompt


# ── run — error paths ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_raises_on_nonzero_exit(monkeypatch):
    p = GeminiProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stderr=b"auth required", returncode=1)),
    )
    with pytest.raises(LLMError, match="exited 1"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_missing_binary(monkeypatch):
    p = GeminiProvider()
    async def _no_binary(*_a, **_kw):
        raise FileNotFoundError("gemini")
    monkeypatch.setattr("asyncio.create_subprocess_exec", _no_binary)
    with pytest.raises(LLMError, match="not found on PATH"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_timeout(monkeypatch):
    p = GeminiProvider()

    class _SlowProc(_FakeProc):
        async def communicate(self):
            import asyncio as _aio
            await _aio.sleep(10)
            return b"", b""

    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_SlowProc(returncode=0)),
    )
    with pytest.raises(LLMError, match="timed out"):
        await p.run("hi", timeout=0.05)
