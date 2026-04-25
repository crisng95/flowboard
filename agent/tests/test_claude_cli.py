"""Tests for services/claude_cli.py. Mocks asyncio.create_subprocess_exec so
we never shell out to a real `claude` binary.
"""
import json
from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services import claude_cli


class _FakeProc:
    def __init__(self, stdout: bytes, stderr: bytes = b"", rc: int = 0):
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = rc
        self.killed = False

    async def communicate(self):
        return self._stdout, self._stderr

    def kill(self):
        self.killed = True


def _envelope(result_text: str, is_error: bool = False) -> bytes:
    return json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "is_error": is_error,
            "result": result_text,
            "duration_ms": 10,
        }
    ).encode()


@pytest.mark.asyncio
async def test_run_claude_passes_argv_and_returns_result():
    proc = _FakeProc(_envelope("hello from the model"))
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ) as m:
        out = await claude_cli.run_claude(
            user_prompt="say hi", system_prompt="be brief"
        )
    assert out == "hello from the model"

    argv = list(m.call_args.args)
    assert argv[0] == "claude"
    assert "-p" in argv and "say hi" in argv
    assert "--output-format" in argv and "json" in argv
    assert "--append-system-prompt" in argv and "be brief" in argv


@pytest.mark.asyncio
async def test_run_claude_without_system_prompt_omits_flag():
    proc = _FakeProc(_envelope("ok"))
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ) as m:
        await claude_cli.run_claude(user_prompt="x")
    argv = list(m.call_args.args)
    assert "--append-system-prompt" not in argv


@pytest.mark.asyncio
async def test_run_claude_raises_on_nonzero_exit():
    proc = _FakeProc(b"", stderr=b"auth failed", rc=1)
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ):
        with pytest.raises(claude_cli.ClaudeCliError):
            await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_raises_on_is_error_envelope():
    proc = _FakeProc(_envelope("something went sideways", is_error=True))
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ):
        with pytest.raises(claude_cli.ClaudeCliError):
            await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_raises_on_non_json_stdout():
    proc = _FakeProc(b"not json at all")
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ):
        with pytest.raises(claude_cli.ClaudeCliError):
            await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_file_not_found_raises_clean_error():
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(side_effect=FileNotFoundError),
    ):
        with pytest.raises(claude_cli.ClaudeCliError):
            await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_is_available_cached_after_first_probe():
    claude_cli.reset_availability_cache()

    probe = _FakeProc(b"2.1.119", rc=0)
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=probe),
    ) as m:
        r1 = await claude_cli.is_available()
        r2 = await claude_cli.is_available()
    assert r1 is True and r2 is True
    # Second call should hit the cache, not exec again.
    assert m.await_count == 1


@pytest.mark.asyncio
async def test_is_available_handles_missing_binary():
    claude_cli.reset_availability_cache()
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(side_effect=FileNotFoundError),
    ):
        assert await claude_cli.is_available() is False
    claude_cli.reset_availability_cache()
