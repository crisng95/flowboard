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
async def test_run_claude_attachments_embed_as_at_paths():
    """Claude CLI accepts file attachments via @<path> tokens in the prompt.
    `run_claude` joins them onto the user prompt; we never quote (argv) so
    paths with spaces still work as a single token. Critical: parent dirs
    must be `--add-dir`-ed and `--permission-mode bypassPermissions` set
    so the Read tool can open the files non-interactively (without these
    the CLI returns a 'I need permission to read' message)."""
    proc = _FakeProc(_envelope("ok"))
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ) as m:
        await claude_cli.run_claude(
            user_prompt="describe this",
            attachments=["/tmp/a.png", "/tmp/b.png"],
        )
    argv = list(m.call_args.args)
    p_idx = argv.index("-p")
    prompt_arg = argv[p_idx + 1]
    assert "@/tmp/a.png" in prompt_arg
    assert "@/tmp/b.png" in prompt_arg
    assert "describe this" in prompt_arg
    # Permission flags so Claude CLI doesn't refuse to open the file.
    assert "--add-dir" in argv
    add_dir_idx = argv.index("--add-dir")
    assert argv[add_dir_idx + 1] == "/tmp"
    assert "--permission-mode" in argv
    pm_idx = argv.index("--permission-mode")
    assert argv[pm_idx + 1] == "bypassPermissions"


@pytest.mark.asyncio
async def test_run_claude_no_attachments_skips_permission_flags():
    """Plain text-only call must NOT add --add-dir or
    --permission-mode bypassPermissions — those are only relevant when
    we need the Read tool."""
    proc = _FakeProc(_envelope("ok"))
    with patch(
        "flowboard.services.claude_cli.asyncio.create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ) as m:
        await claude_cli.run_claude(user_prompt="say hi")
    argv = list(m.call_args.args)
    assert "--add-dir" not in argv
    assert "--permission-mode" not in argv


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
