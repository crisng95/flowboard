"""Tests for services/claude_cli.py.

The provider invokes ``claude`` synchronously via ``subprocess.run`` (a
deliberate Windows-compat choice — asyncio subprocess on Windows requires
``ProactorEventLoop`` which FastAPI doesn't use). Tests stub
``subprocess.run`` at the module boundary and assert on the argv it
receives plus the JSON envelope it returns.

Critical invariant: the user prompt is piped via **stdin** rather than
``-p <prompt>`` argv. On Windows, npm ships ``.cmd`` shims and Python's
subprocess.run on a ``.cmd`` re-invokes through cmd.exe which re-parses
the args — newlines/quotes/``&`` inside long prompts get split, so the
CLI sees an empty ``-p`` and replies conversationally in plain text
("what would you like me to do?"). Stdin sidesteps the parser entirely.
"""
import json
import subprocess as _subprocess
from dataclasses import dataclass

import pytest

from flowboard.services import claude_cli


@dataclass
class _FakeResult:
    returncode: int = 0
    stdout: bytes = b""
    stderr: bytes = b""


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


def _stub_run(monkeypatch, returns):
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
        "flowboard.services.claude_cli.subprocess.run", _run,
    )
    return state


def _stub_resolve(monkeypatch, path: str = "/fake/bin/claude"):
    monkeypatch.setattr(
        "flowboard.services.claude_cli.resolve_cli_binary",
        lambda *_a, **_kw: path,
    )


@pytest.mark.asyncio
async def test_run_claude_pipes_prompt_via_stdin(monkeypatch):
    """Critical Windows fix: prompt is sent via stdin (kwargs['input'])
    rather than ``-p <prompt>`` argv. This avoids cmd.exe re-parsing
    breaking long prompts on ``.cmd``-shimmed npm installs."""
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("hello")))
    out = await claude_cli.run_claude(
        user_prompt="say hi", system_prompt="be brief"
    )
    assert out == "hello"
    args, kwargs = state["calls"][0]
    argv = list(args[0])
    # Prompt must be on stdin, NOT in argv after `-p`.
    assert kwargs["input"] == b"say hi"
    p_idx = argv.index("-p")
    assert argv[p_idx + 1] == "--output-format", (
        "argv should be `-p --output-format json …`, not `-p <prompt> …`"
    )
    assert "say hi" not in argv  # the user prompt itself is not in argv
    # Other flags still wired through argv.
    assert "--output-format" in argv and "json" in argv
    assert "--append-system-prompt" in argv and "be brief" in argv


@pytest.mark.asyncio
async def test_run_claude_attachments_embed_as_at_paths(monkeypatch, tmp_path):
    """Claude CLI accepts file attachments via @<path> tokens in the
    prompt. With stdin-based prompt delivery, those tokens live in the
    stdin payload (not argv). Permission flags MUST still be present:
    parent dirs --add-dir-ed, --permission-mode bypassPermissions, so
    the Read tool can open the files non-interactively."""
    img_a = tmp_path / "a.png"; img_a.write_bytes(b"fake")
    img_b = tmp_path / "b.png"; img_b.write_bytes(b"fake")
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await claude_cli.run_claude(
        user_prompt="describe this",
        attachments=[str(img_a), str(img_b)],
    )
    args, kwargs = state["calls"][0]
    argv = list(args[0])
    # @<path> tokens are part of the stdin-delivered prompt body.
    stdin_text = kwargs["input"].decode("utf-8")
    assert f"@{img_a}" in stdin_text
    assert f"@{img_b}" in stdin_text
    assert "describe this" in stdin_text
    # Permission flags so Claude CLI doesn't refuse to open the file.
    # Both attachments share the same parent dir, so a single --add-dir
    # entry is expected.
    assert "--add-dir" in argv
    add_dir_idx = argv.index("--add-dir")
    assert argv[add_dir_idx + 1] == str(tmp_path)
    assert "--permission-mode" in argv
    pm_idx = argv.index("--permission-mode")
    assert argv[pm_idx + 1] == "bypassPermissions"


@pytest.mark.asyncio
async def test_run_claude_no_attachments_skips_permission_flags(monkeypatch):
    """Plain text-only call must NOT add --add-dir or
    --permission-mode bypassPermissions — those are only relevant when
    we need the Read tool."""
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await claude_cli.run_claude(user_prompt="say hi")
    argv = list(state["calls"][0][0][0])
    assert "--add-dir" not in argv
    assert "--permission-mode" not in argv


@pytest.mark.asyncio
async def test_run_claude_without_system_prompt_omits_flag(monkeypatch):
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await claude_cli.run_claude(user_prompt="x")
    argv = list(state["calls"][0][0][0])
    assert "--append-system-prompt" not in argv


@pytest.mark.asyncio
async def test_run_claude_raises_on_nonzero_exit(monkeypatch):
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=1, stderr=b"auth failed"))
    with pytest.raises(claude_cli.ClaudeCliError):
        await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_raises_on_is_error_envelope(monkeypatch):
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _FakeResult(returncode=0, stdout=_envelope("something went sideways", is_error=True)),
    )
    with pytest.raises(claude_cli.ClaudeCliError):
        await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_raises_on_non_json_stdout(monkeypatch):
    """Regression for the Windows bug: when prompt was sent via argv it
    sometimes got mangled, claude received nothing actionable, and
    replied with conversational plain text starting with "I see the
    system reminders…". Even with the stdin fix we keep this guard so
    any future regression surfaces as a clean error rather than a
    silent garbage return."""
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"not json at all"))
    with pytest.raises(claude_cli.ClaudeCliError, match="non-JSON output"):
        await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_file_not_found_raises_clean_error(monkeypatch):
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise FileNotFoundError("claude")
    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _raise)
    with pytest.raises(claude_cli.ClaudeCliError, match="not found on PATH"):
        await claude_cli.run_claude(user_prompt="x")


@pytest.mark.asyncio
async def test_run_claude_timeout_raises_clean_error(monkeypatch):
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise _subprocess.TimeoutExpired(cmd="claude", timeout=0.05)
    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _raise)
    with pytest.raises(claude_cli.ClaudeCliError, match="timed out"):
        await claude_cli.run_claude(user_prompt="x", timeout=0.05)


@pytest.mark.asyncio
async def test_is_available_cached_after_first_probe(monkeypatch):
    claude_cli.reset_availability_cache()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"2.1.119"))
    r1 = await claude_cli.is_available()
    r2 = await claude_cli.is_available()
    assert r1 is True and r2 is True
    # Second call should hit the cache, not exec again.
    assert len(state["calls"]) == 1
    claude_cli.reset_availability_cache()


@pytest.mark.asyncio
async def test_is_available_handles_missing_binary(monkeypatch):
    claude_cli.reset_availability_cache()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise FileNotFoundError("claude")
    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _raise)
    assert await claude_cli.is_available() is False
    claude_cli.reset_availability_cache()


@pytest.mark.asyncio
async def test_run_claude_emits_model_and_effort_flags(monkeypatch):
    """Per-feature selection reaches argv as `--model` / `--effort`."""
    captured: dict = {}

    def _fake_run(args, **kwargs):
        captured["argv"] = list(args)
        return _FakeResult(returncode=0, stdout=_envelope("ok"))

    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _fake_run)
    await claude_cli.run_claude("hi", model="opus", effort="xhigh")
    argv = captured["argv"]
    assert argv[argv.index("--model") + 1] == "opus"
    assert argv[argv.index("--effort") + 1] == "xhigh"


@pytest.mark.asyncio
async def test_run_claude_omits_model_and_effort_when_unset(monkeypatch):
    """Unset means "leave the user's own claude settings alone" — passing
    a hard-coded model here would silently override their choice."""
    captured: dict = {}

    def _fake_run(args, **kwargs):
        captured["argv"] = list(args)
        return _FakeResult(returncode=0, stdout=_envelope("ok"))

    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _fake_run)
    await claude_cli.run_claude("hi")
    assert "--model" not in captured["argv"]
    assert "--effort" not in captured["argv"]


# ── Event-loop discipline ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_claude_does_not_park_the_event_loop(monkeypatch):
    """`subprocess.run` stays — see the module docstring for the Windows
    `.cmd` reason — but runs in a worker thread.

    The agent is one process on one loop, shared by the generation
    worker, the extension WebSocket and every HTTP route. A `claude -p`
    turn can run for minutes; blocking here froze all of it, and the
    availability probe behind it sits on `/api/llm/providers`, which an
    always-mounted badge polls every 30s.
    """
    import asyncio
    import time as _time

    _stub_resolve(monkeypatch)

    def _slow(*_a, **_kw):
        _time.sleep(0.25)
        return _FakeResult(returncode=0, stdout=_envelope("ok"))

    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _slow)

    ticks = 0

    async def _tick():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    ticker = asyncio.create_task(_tick())
    try:
        out = await claude_cli.run_claude("hi")
    finally:
        ticker.cancel()

    assert out == "ok"
    assert ticks >= 5, "the event loop was parked for the whole subprocess call"


@pytest.mark.asyncio
async def test_availability_probe_does_not_park_the_event_loop(monkeypatch):
    import asyncio
    import time as _time

    _stub_resolve(monkeypatch)
    claude_cli.reset_availability_cache()

    def _slow(*_a, **_kw):
        _time.sleep(0.25)
        return _FakeResult(returncode=0, stdout=b"1.0.0\n")

    monkeypatch.setattr("flowboard.services.claude_cli.subprocess.run", _slow)

    ticks = 0

    async def _tick():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    ticker = asyncio.create_task(_tick())
    try:
        assert await claude_cli.is_available(force=True) is True
    finally:
        ticker.cancel()
        claude_cli.reset_availability_cache()

    assert ticks >= 5, "the event loop was parked for the whole subprocess call"
