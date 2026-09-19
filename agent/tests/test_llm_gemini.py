"""Tests for the Gemini provider, which drives the ``agy`` CLI.

The provider id is still ``gemini`` but the binary is ``agy`` — Google's
own ``gemini`` CLI now refuses individual Code Assist tiers outright. See
``services/llm/gemini.py``'s module docstring for the migration notes.

The provider invokes ``agy`` synchronously via ``subprocess.run`` (a
deliberate Windows-compat choice — asyncio subprocess on Windows requires
``ProactorEventLoop`` which FastAPI doesn't use). Tests stub
``subprocess.run`` at the module boundary and assert on the argv it
receives plus the JSON envelope it returns.

CLI args under test:
- ``--print <prompt>``     the prompt IS the flag's value; ``--print -``
                           does NOT read stdin (verified against the real
                           binary), so there is no stdin delivery path
- ``--output-format json`` structured envelope, parsed into ``response``
- ``--print-timeout <N>s`` agy's own deadline, set from the caller's
- ``--model`` / ``--effort``  per-feature overrides, omitted when unset
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


def _envelope(response: str, *, status: str = "SUCCESS", **extra) -> bytes:
    """Build a realistic ``--output-format json`` stdout envelope."""
    import json
    payload = {
        "conversation_id": "00000000-0000-0000-0000-000000000000",
        "status": status,
        "response": response,
        "duration_seconds": 1.5,
        "num_turns": 1,
        "usage": {"input_tokens": 10, "output_tokens": 2},
    }
    payload.update(extra)
    return json.dumps(payload).encode("utf-8")


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


def _stub_resolve(monkeypatch, path: str = "/fake/bin/agy"):
    """Pin the resolved binary path so PATH lookup doesn't leak."""
    monkeypatch.setattr(
        "flowboard.services.llm.gemini.resolve_cli_binary",
        lambda *_a, **_kw: path,
    )


def _prompt_of(state, call: int = 0) -> str:
    """Pull the prompt back out of a recorded argv."""
    argv = list(state["calls"][call][0][0])
    return argv[argv.index("--print") + 1]


# ── is_available ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_available_true_when_version_succeeds(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"1.2.7\n"))
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_is_available_probes_the_agy_binary(monkeypatch):
    """Regression guard for the migration: probing the old ``gemini``
    binary would report "available" on a host where the dead CLI is still
    installed, then fail every dispatch with IneligibleTierError."""
    p = GeminiProvider()
    seen: list[str] = []
    monkeypatch.setattr(
        "flowboard.services.llm.gemini.resolve_cli_binary",
        lambda name, *_a, **_kw: seen.append(name) or "/fake/bin/agy",
    )
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"1.2.7\n"))
    await p.is_available()
    assert seen == ["agy"]


@pytest.mark.asyncio
async def test_is_available_false_when_binary_missing(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise FileNotFoundError("agy")
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
    """Probe should be cheap — don't re-spawn `agy --version` per dispatch."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=b"1.2.7\n"))
    await p.is_available()
    await p.is_available()
    await p.is_available()
    assert len(state["calls"]) == 1


# ── run — prompt composition ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_returns_envelope_response_field(monkeypatch):
    """Envelope shape: ``{status: "SUCCESS", response: "<text>", ...}``.
    The provider extracts ``response`` and discards everything else."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("hello world")))
    out = await p.run("hi")
    assert out == "hello world"


@pytest.mark.asyncio
async def test_run_emits_output_format_json_flag(monkeypatch):
    """Argv must include ``--output-format json`` so the CLI emits a
    structured envelope instead of raw text mixed with banner noise."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("hi")
    argv = list(state["calls"][0][0][0])
    assert argv[argv.index("--output-format") + 1] == "json"
    # The old Gemini CLI's short forms must be gone — agy doesn't know them.
    assert "-o" not in argv
    assert "-p" not in argv


@pytest.mark.asyncio
async def test_run_passes_prompt_as_print_value_not_stdin(monkeypatch):
    """``--print -`` does NOT read stdin on agy (verified: it ignores the
    piped bytes and answers the empty prompt generically), so the prompt
    must travel as the flag's value and nothing may be piped in."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    tricky = 'a "quoted" $VAR\nnewline'
    await p.run(tricky)
    argv, kwargs = state["calls"][0][0][0], state["calls"][0][1]
    assert list(argv)[list(argv).index("--print") + 1] == tricky
    assert kwargs.get("input") is None


@pytest.mark.asyncio
async def test_run_sets_print_timeout_from_caller_timeout(monkeypatch):
    """agy gets its own deadline so it can tear the turn down and still
    emit an envelope, instead of being killed mid-write by subprocess."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("hi", timeout=45.0)
    argv = list(state["calls"][0][0][0])
    assert argv[argv.index("--print-timeout") + 1] == "45s"
    # ...and the subprocess deadline is looser so agy wins the race.
    assert state["calls"][0][1]["timeout"] > 45.0


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
        _FakeResult(
            returncode=0,
            stdout=json.dumps({"conversation_id": "x", "status": "SUCCESS"}).encode(),
        ),
    )
    with pytest.raises(LLMError, match="missing string 'response'"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_when_status_is_not_success(monkeypatch):
    """A non-SUCCESS status is a failure even though the process exited 0
    and the envelope parsed fine."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _FakeResult(returncode=0, stdout=_envelope("partial", status="ERROR")),
    )
    with pytest.raises(LLMError, match="status 'ERROR'"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_empty_response_with_denied_actions(monkeypatch):
    """THE bug this provider exists to prevent.

    agy is agentic: a prompt that makes it reach for a shell command gets
    that command auto-denied in a headless run. The envelope then comes
    back exit-0, ``status: "SUCCESS"``, ``response: ""`` and a
    ``denied_actions`` list. Returning "" from here is what made batch
    auto-prompt synth and planner plan-extraction blow up three layers
    downstream with an inscrutable parse error. The error must name the
    denied actions so the cause is visible at the point of failure."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(
        monkeypatch,
        _FakeResult(
            returncode=0,
            stdout=_envelope(
                "",
                denied_actions=[
                    {"action": "command", "display_name": "RunCommand"},
                ],
            ),
        ),
    )
    with pytest.raises(LLMError) as exc:
        await p.run("describe this")
    msg = str(exc.value)
    assert "RunCommand" in msg
    assert "headlessly" in msg


@pytest.mark.asyncio
async def test_run_raises_on_whitespace_only_response(monkeypatch):
    """Same guard without denied_actions — whitespace is still nothing."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("   \n ")))
    with pytest.raises(LLMError, match="empty response"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_prepends_system_prompt_into_body(monkeypatch):
    """agy has no `--system` flag, so the system prompt is folded into
    the prompt body as a `[System: ...]` block separated by a blank line."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("user question", system_prompt="be terse")
    prompt = _prompt_of(state)
    argv = list(state["calls"][0][0][0])
    assert "[System: be terse]" in prompt
    assert "user question" in prompt
    assert prompt.index("[System:") < prompt.index("user question")
    assert "--system" not in argv


@pytest.mark.asyncio
async def test_run_no_system_prompt_omits_system_block(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("just the user prompt")
    prompt = _prompt_of(state)
    assert "[System:" not in prompt
    assert prompt == "just the user prompt"


# ── run — model + effort ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_passes_model_and_effort_flags(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("hi", model="gemini-3.8-flash-low", effort="low")
    argv = list(state["calls"][0][0][0])
    assert argv[argv.index("--model") + 1] == "gemini-3.8-flash-low"
    assert argv[argv.index("--effort") + 1] == "low"


@pytest.mark.asyncio
async def test_run_omits_model_and_effort_when_unset(monkeypatch):
    """Unset means "leave agy's own session settings alone" — passing a
    hard-coded model here would silently override the user's choice."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("hi")
    argv = list(state["calls"][0][0][0])
    assert "--model" not in argv
    assert "--effort" not in argv


@pytest.mark.asyncio
async def test_never_passes_dangerous_permission_flag(monkeypatch):
    """agy's denied-tool problem has a safe fix (steering it at its
    file-reading tool). Auto-approving every tool is NOT that fix and
    must never appear in argv."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("hi", model="gemini-3.8-flash-low", effort="high")
    argv = list(state["calls"][0][0][0])
    assert "--dangerously-skip-permissions" not in argv


# ── run — image attachments via @path ─────────────────────────────────


@pytest.mark.asyncio
async def test_run_inlines_attachments_as_at_paths(monkeypatch, tmp_path):
    p = GeminiProvider()
    img1 = tmp_path / "a.jpg"; img1.write_bytes(b"fake")
    img2 = tmp_path / "b.jpg"; img2.write_bytes(b"fake")
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("describe", attachments=[str(img1), str(img2)])
    prompt = _prompt_of(state)
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
    assert "@/" in _prompt_of(state)


@pytest.mark.asyncio
async def test_run_attachments_steer_agy_to_its_file_read_tool(
    monkeypatch, tmp_path
):
    """``@<path>`` alone makes agy shell out to read the file, which is
    auto-denied headlessly and returns an empty response. The verified
    fix is prose: tell it to use its file-reading tool and to run no
    shell command."""
    p = GeminiProvider()
    img = tmp_path / "x.jpg"; img.write_bytes(b"fake")
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("describe", attachments=[str(img)])
    prompt = _prompt_of(state)
    assert "file-reading tool" in prompt
    assert "Do NOT run any shell command." in prompt
    assert str(img.resolve()) in prompt


@pytest.mark.asyncio
async def test_run_without_attachments_omits_the_steering_line(monkeypatch):
    """The instruction is attachment-specific — it must not leak into
    ordinary text prompts, where it would just confuse the model."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_envelope("ok")))
    await p.run("plain text question")
    assert "file-reading tool" not in _prompt_of(state)


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
        raise FileNotFoundError("agy")
    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _raise)
    with pytest.raises(LLMError, match="not found on PATH"):
        await p.run("hi")


@pytest.mark.asyncio
async def test_run_raises_on_timeout(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise _subprocess.TimeoutExpired(cmd="agy", timeout=0.05)
    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _raise)
    with pytest.raises(LLMError, match="timed out"):
        await p.run("hi", timeout=0.05)


# ── list_models — `agy models` catalog ────────────────────────────────


_MODELS_STDOUT = (
    b"Fetching available models...\n"
    b"gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n"
    b"gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n"
    b"claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n"
    b"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n"
)


@pytest.mark.asyncio
async def test_list_models_parses_tab_separated_rows(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_MODELS_STDOUT))
    models = await p.list_models()
    assert models[0] == {
        "id": "gemini-3.8-flash-high", "label": "Gemini 3.8 Flash (High)",
    }
    # agy fronts more than Gemini — the catalog is whatever it serves.
    assert {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6 (Thinking)"} in models


@pytest.mark.asyncio
async def test_list_models_skips_the_fetching_noise_line(monkeypatch):
    """`agy models` opens with a bare ``Fetching available models...``
    status line. Filtering on "has a tab" drops it without hard-coding
    its text, so any future banner is dropped the same way."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_MODELS_STDOUT))
    models = await p.list_models()
    assert len(models) == 4
    assert all("Fetching" not in m["id"] for m in models)


@pytest.mark.asyncio
async def test_list_models_caches_within_ttl(monkeypatch):
    """Opening the Settings panel polls /providers; each poll must not
    re-shell out to `agy models`."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_MODELS_STDOUT))
    await p.list_models()
    await p.list_models()
    await p.list_models()
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
async def test_list_models_force_refetches(monkeypatch):
    """The panel's Refresh button must actually re-fetch — a user who
    just gained access to a new model shouldn't wait out the TTL."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_MODELS_STDOUT))
    await p.list_models()
    await p.list_models(force=True)
    assert len(state["calls"]) == 2


@pytest.mark.asyncio
async def test_list_models_returns_empty_on_failure(monkeypatch):
    """Catalogs never raise — a missing binary degrades the UI to a
    free-text model field, it doesn't 500 the Settings panel."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    def _raise(*a, **kw):
        raise FileNotFoundError("agy")
    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _raise)
    assert await p.list_models() == []


@pytest.mark.asyncio
async def test_list_models_returns_empty_on_nonzero_exit(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    _stub_run(monkeypatch, _FakeResult(returncode=1, stderr=b"not signed in"))
    assert await p.list_models() == []


@pytest.mark.asyncio
async def test_list_models_does_not_cache_an_empty_listing(monkeypatch):
    """A transient failure must not pin the panel to "no models" for the
    whole TTL — the next call retries."""
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, [
        _FakeResult(returncode=1, stderr=b"transient"),
        _FakeResult(returncode=0, stdout=_MODELS_STDOUT),
    ])
    assert await p.list_models() == []
    assert len(await p.list_models()) == 4
    assert len(state["calls"]) == 2


@pytest.mark.asyncio
async def test_reset_cache_clears_the_model_catalog(monkeypatch):
    p = GeminiProvider()
    _stub_resolve(monkeypatch)
    state = _stub_run(monkeypatch, _FakeResult(returncode=0, stdout=_MODELS_STDOUT))
    await p.list_models()
    p.reset_cache()
    await p.list_models()
    assert len(state["calls"]) == 2


def test_provider_declares_agy_effort_ladder():
    """agy stops at ``high`` — it has no xhigh/max like Claude. Offering
    them would let the UI build a pair that fails at dispatch."""
    p = GeminiProvider()
    assert p.supports_effort is True
    assert p.efforts == ["low", "medium", "high"]


# ── Event-loop discipline ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_does_not_park_the_event_loop(monkeypatch):
    """`subprocess.run` stays (see the module docstring for the Windows
    `.cmd` reason) but must run in a worker thread.

    The agent is one process on one loop: the generation worker, the
    extension WebSocket and every HTTP route share it. An agy turn's
    ceiling is 180s, and `/api/llm/providers` — which probes and lists
    models — is polled every 30s by an always-mounted badge. Blocking
    here froze all of it.
    """
    import asyncio
    import time as _time

    _stub_resolve(monkeypatch)

    def _slow(*_a, **_kw):
        _time.sleep(0.25)
        return _FakeResult(returncode=0, stdout=_envelope("hi"))

    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _slow)

    ticks = 0

    async def _tick():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    ticker = asyncio.create_task(_tick())
    try:
        out = await GeminiProvider().run("hi", timeout=5.0)
    finally:
        ticker.cancel()

    assert out == "hi"
    assert ticks >= 5, "the event loop was parked for the whole subprocess call"


@pytest.mark.asyncio
async def test_model_catalog_does_not_park_the_event_loop(monkeypatch):
    """`agy models` measured ~3.6s, and `list_providers` awaits it on a
    route the Settings badge polls every 30s."""
    import asyncio
    import time as _time

    _stub_resolve(monkeypatch)

    def _slow(*_a, **_kw):
        _time.sleep(0.25)
        return _FakeResult(returncode=0, stdout=b"gemini-3.8-flash-low\tGemini 3.8\n")

    monkeypatch.setattr("flowboard.services.llm.gemini.subprocess.run", _slow)

    ticks = 0

    async def _tick():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    ticker = asyncio.create_task(_tick())
    try:
        models = await GeminiProvider().list_models()
    finally:
        ticker.cancel()

    assert [m["id"] for m in models] == ["gemini-3.8-flash-low"]
    assert ticks >= 5, "the event loop was parked for the whole subprocess call"
