"""Tests for the Gemini provider — subprocess flow + image-flag detection.

No real `gemini` binary is invoked. We patch ``asyncio.create_subprocess_exec``
to return a fake process that simulates whatever stdout/stderr/returncode
the test wants.
"""
from __future__ import annotations

from typing import Optional
from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services.llm.base import LLMError
from flowboard.services.llm.gemini import GeminiProvider


class _FakeProc:
    """Stand-in for ``asyncio.subprocess.Process``."""

    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0):
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode

    async def communicate(self):
        return self._stdout, self._stderr

    def kill(self):  # noqa: D401
        pass


def _spawn_returning(*procs: _FakeProc):
    """Build a side_effect that returns each fake process in order.

    Lets a single test sequence multiple subprocess calls (e.g. probe
    --version, then probe --help, then run -p) without re-mocking."""
    iterator = iter(procs)

    async def _spawn(*_args, **_kwargs):
        try:
            return next(iterator)
        except StopIteration:
            raise AssertionError("subprocess called more times than expected")

    return _spawn


# ── is_available ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_is_available_true_when_version_succeeds(monkeypatch):
    p = GeminiProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=b"gemini 1.0.0\n", returncode=0)),
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
    """CLI installed but the binary returns a non-zero exit code (e.g.
    incompatible Node version) — treat as unavailable."""
    p = GeminiProvider()
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stderr=b"node ver mismatch", returncode=1)),
    )
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_caches_after_first_probe(monkeypatch):
    """The probe is supposed to be cheap — we don't want to re-spawn
    `gemini --version` on every dispatch."""
    p = GeminiProvider()
    spawn_mock = AsyncMock(return_value=_FakeProc(returncode=0))
    monkeypatch.setattr("asyncio.create_subprocess_exec", spawn_mock)
    await p.is_available()
    await p.is_available()
    await p.is_available()
    assert spawn_mock.call_count == 1


# ── image-flag resolution ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_resolve_image_flag_picks_image_first(monkeypatch):
    p = GeminiProvider()
    help_text = b"Usage: gemini [options]\n  --image PATH\n  --file PATH\n"
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=help_text, returncode=0)),
    )
    assert await p._resolve_image_flag() == "--image"


@pytest.mark.asyncio
async def test_resolve_image_flag_falls_back_to_file(monkeypatch):
    """When `--image` isn't advertised, accept `--file` as the next
    candidate. Mirrors how older / newer gemini-cli versions might
    rename the flag."""
    p = GeminiProvider()
    help_text = b"Usage:\n  -p PROMPT\n  --file PATH\n  --json\n"
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=help_text, returncode=0)),
    )
    assert await p._resolve_image_flag() == "--file"


@pytest.mark.asyncio
async def test_resolve_image_flag_returns_none_when_unknown(monkeypatch):
    """No recognised flag → None. Caller must treat as 'this version is
    text-only' and surface a clear vision-unsupported error rather than
    silently dropping the attachment."""
    p = GeminiProvider()
    help_text = b"Usage:\n  -p PROMPT\n  --json\n"
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=help_text, returncode=0)),
    )
    assert await p._resolve_image_flag() is None


@pytest.mark.asyncio
async def test_resolve_image_flag_caches(monkeypatch):
    p = GeminiProvider()
    spawn_mock = AsyncMock(return_value=_FakeProc(stdout=b"--image PATH\n", returncode=0))
    monkeypatch.setattr("asyncio.create_subprocess_exec", spawn_mock)
    await p._resolve_image_flag()
    await p._resolve_image_flag()
    assert spawn_mock.call_count == 1


# ── run ────────────────────────────────────────────────────────────

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
    """No shell — prompt with quotes/newlines must reach the CLI verbatim
    via argv, not get mangled by a shell substitution."""
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    tricky = 'a "quoted" $VAR\nnewline'
    await p.run(tricky)
    args = captured["args"]
    # Args = (binary, "-p", prompt). Prompt is one argv token verbatim.
    assert args[1] == "-p"
    assert args[2] == tricky


@pytest.mark.asyncio
async def test_run_includes_system_prompt(monkeypatch):
    p = GeminiProvider()
    captured: dict = {}

    async def _spawn(*args, **_kwargs):
        captured["args"] = args
        return _FakeProc(stdout=b"ok\n", returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("hi", system_prompt="be terse")
    assert "--system" in captured["args"]
    assert "be terse" in captured["args"]


@pytest.mark.asyncio
async def test_run_attaches_images_with_resolved_flag(monkeypatch, tmp_path):
    """End-to-end attachment path: --help probe resolves the image flag,
    then `run` repeats it per attachment with absolute paths."""
    p = GeminiProvider()
    img1 = tmp_path / "a.jpg"; img1.write_bytes(b"fake")
    img2 = tmp_path / "b.jpg"; img2.write_bytes(b"fake")
    captured: dict = {}

    procs = iter([
        _FakeProc(stdout=b"  --image PATH\n", returncode=0),  # --help probe
        _FakeProc(stdout=b"ok\n", returncode=0),               # actual run
    ])

    async def _spawn(*args, **_kwargs):
        proc = next(procs)
        if "-p" in args:
            captured["run_args"] = args
        return proc

    monkeypatch.setattr("asyncio.create_subprocess_exec", _spawn)
    await p.run("describe", attachments=[str(img1), str(img2)])
    args = captured["run_args"]
    # Each attachment paired with the flag, paths absolute.
    assert args.count("--image") == 2
    assert str(img1) in args
    assert str(img2) in args


@pytest.mark.asyncio
async def test_run_raises_when_attachments_but_no_image_flag(monkeypatch, tmp_path):
    p = GeminiProvider()
    img = tmp_path / "x.jpg"; img.write_bytes(b"fake")

    # --help advertises NO image flag → vision dispatch must fail.
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        _spawn_returning(_FakeProc(stdout=b"  -p PROMPT\n", returncode=0)),
    )
    with pytest.raises(LLMError, match="image attachment flag"):
        await p.run("describe", attachments=[str(img)])


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
