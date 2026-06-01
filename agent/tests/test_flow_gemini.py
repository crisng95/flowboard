"""Tests for the ``flow_gemini`` LLM provider.

The provider never calls a model directly: it enqueues a Control-Plane
``task_type="text_gen"`` request and polls the request row until the browser
extension's cloud-worker completes it. Every test here injects a *mocked*
``ControlPlaneService`` (``FlowGeminiProvider(control_plane=mock)``) so no
network / Supabase / extension is ever touched. The base64 attachment encoder
and ``_build_input_data`` are pure and tested directly.

Covers spec ``gemini-via-flow-generatecontent`` tasks 6.3 (Property 5),
6.4 (provider unit tests), and 6.6 (redaction / secrets).

What is mocked and why:
- ``ControlPlaneService`` — replaced with explicit ``AsyncMock`` methods
  (``create_or_reset_request`` / ``_get_request`` / ``get_client_user_id``)
  matching the real signatures in ``control_plane.py``. This isolates the
  provider's enqueue → poll → extract logic from the cloud.
- Worker identity env vars (``FLOWBOARD_TEXT_GEN_USER_ID/BOARD_ID/NODE_ID``)
  are set via ``monkeypatch`` *before* constructing the provider (they are
  read in ``__init__``) so ``_enqueue`` doesn't raise the
  "identity not configured" guard.
Nothing about the generated text or token plumbing is faked beyond the
Control-Plane row contents the worker would have written.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import tempfile
from unittest.mock import AsyncMock, MagicMock

import pytest
from hypothesis import example, given, settings
from hypothesis import strategies as st

from flowboard.services.llm import registry
from flowboard.services.llm.base import LLMError, LLMProvider
from flowboard.services.llm.flow_gemini import FlowGeminiProvider, _sanitize_error


# ── shared helpers / fixtures ──────────────────────────────────────────


def _make_mock_cp(
    *,
    request_id: str = "req-1",
    rows=None,
    user_id: str = "user-1",
) -> MagicMock:
    """Build a Control-Plane double with the three async methods the provider
    actually calls. ``rows`` is either a single row dict (returned every poll)
    or a list consumed in order across successive ``_get_request`` calls."""
    cp = MagicMock()
    cp.create_or_reset_request = AsyncMock(return_value={"id": request_id})
    cp.get_client_user_id = AsyncMock(return_value=user_id)
    if isinstance(rows, list):
        cp._get_request = AsyncMock(side_effect=rows)
    else:
        cp._get_request = AsyncMock(return_value=rows)
    return cp


@pytest.fixture
def identity_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the Control-Plane worker identity so ``_enqueue`` passes its guard.

    Read in ``FlowGeminiProvider.__init__`` — set BEFORE constructing.
    """
    monkeypatch.setenv("FLOWBOARD_TEXT_GEN_USER_ID", "user-1")
    monkeypatch.setenv("FLOWBOARD_TEXT_GEN_BOARD_ID", "board-1")
    monkeypatch.setenv("FLOWBOARD_TEXT_GEN_NODE_ID", "node-1")


def _completed_row(text: str) -> dict:
    return {"status": "completed", "output_result": {"text": text}}


# ════════════════════════════════════════════════════════════════════════
# Task 6.3 — Property 5: attachment base64 encode/decode round-trip
# ════════════════════════════════════════════════════════════════════════
#
# Feature: gemini-via-flow-generatecontent, Property 5: For all image byte
# sequences, base64-encoding into inlineData.data then base64-decoding
# reproduces the original bytes exactly.
#
# Validates: Requirements 7.4


@settings(max_examples=150, deadline=None)
@given(
    blobs=st.lists(
        st.binary(min_size=0, max_size=4096),
        min_size=1,
        max_size=4,
    )
)
@example(blobs=[b""])  # empty file
@example(blobs=[bytes(range(256))])  # every byte value (binary)
@example(blobs=[bytes(range(256)) * 256])  # large (~64KB)
def test_property5_attachment_base64_roundtrip(blobs):
    """Writing arbitrary bytes to files, passing them as attachments, then
    base64-decoding the encoded ``data`` reproduces the original bytes, in
    order. ``_build_input_data`` is pure and synchronous so no Control Plane
    is needed."""
    provider = FlowGeminiProvider()
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for i, blob in enumerate(blobs):
            p = os.path.join(d, f"img_{i}.png")
            with open(p, "wb") as fh:
                fh.write(blob)
            paths.append(p)

        data = provider._build_input_data("describe these", None, paths)

        atts = data["attachments"]
        # Order preserved, one entry per attachment.
        assert len(atts) == len(blobs)
        for att, original in zip(atts, blobs):
            assert base64.b64decode(att["data"]) == original


# ════════════════════════════════════════════════════════════════════════
# Task 6.4 — flow_gemini.py unit tests
# ════════════════════════════════════════════════════════════════════════


def test_provider_registered_and_protocol_conforming():
    """Req 6.1 — the provider is registered under ``flow_gemini`` and conforms
    to the ``LLMProvider`` protocol (structural / runtime-checkable)."""
    assert "flow_gemini" in registry._PROVIDERS
    instance = registry._PROVIDERS["flow_gemini"]
    assert isinstance(instance, FlowGeminiProvider)
    # runtime_checkable Protocol — verifies name/supports_vision/run/is_available.
    assert isinstance(instance, LLMProvider)
    assert instance.name == "flow_gemini"


def test_supports_vision_is_true():
    """Req 6.5 — multimodal capable, so the registry's vision gate lets
    attachments through."""
    assert FlowGeminiProvider.supports_vision is True
    assert FlowGeminiProvider().supports_vision is True


@pytest.mark.asyncio
async def test_run_enqueues_and_returns_completed_text(identity_env):
    """Req 6.2 — ``run`` enqueues a text_gen job via ``create_or_reset_request``
    and returns the completed ``output_result.text``."""
    cp = _make_mock_cp(rows=_completed_row("generated answer"))
    provider = FlowGeminiProvider(control_plane=cp)

    out = await provider.run("write a haiku")

    assert out == "generated answer"
    cp.create_or_reset_request.assert_awaited_once()
    kwargs = cp.create_or_reset_request.await_args.kwargs
    assert kwargs["provider"] == "flow"
    assert kwargs["task_type"] == "text_gen"
    assert kwargs["expected_output"] == "text"
    assert kwargs["input_data"]["prompt"] == "write a haiku"
    # Polled the request row at least once.
    cp._get_request.assert_awaited()


@pytest.mark.asyncio
async def test_run_carries_system_prompt_into_input_data(identity_env):
    """Req 6.3 — a supplied ``system_prompt`` is carried into
    ``input_data['system_prompt']`` (turned into ``systemInstruction`` by the
    worker)."""
    cp = _make_mock_cp(rows=_completed_row("ok"))
    provider = FlowGeminiProvider(control_plane=cp)

    await provider.run("user question", system_prompt="You are terse.")

    input_data = cp.create_or_reset_request.await_args.kwargs["input_data"]
    assert input_data["system_prompt"] == "You are terse."


@pytest.mark.asyncio
async def test_run_omits_system_prompt_when_absent(identity_env):
    """Req 7.5-adjacent — no ``system_prompt`` key when none supplied."""
    cp = _make_mock_cp(rows=_completed_row("ok"))
    provider = FlowGeminiProvider(control_plane=cp)

    await provider.run("just a prompt")

    input_data = cp.create_or_reset_request.await_args.kwargs["input_data"]
    assert "system_prompt" not in input_data


@pytest.mark.asyncio
async def test_non_string_system_prompt_raises_and_does_not_enqueue(identity_env):
    """Req 6.4 — a non-string ``system_prompt`` is a hard error raised BEFORE
    enqueue; the job is never dispatched without the system prompt."""
    cp = _make_mock_cp(rows=_completed_row("should-not-reach"))
    provider = FlowGeminiProvider(control_plane=cp)

    with pytest.raises(LLMError):
        await provider.run("hi", system_prompt={"not": "a string"})  # type: ignore[arg-type]

    cp.create_or_reset_request.assert_not_awaited()


@pytest.mark.asyncio
async def test_empty_completed_text_raises_llm_error(identity_env):
    """Req 8.4 — a completed job whose text is empty/whitespace surfaces an
    ``LLMError`` rather than returning an empty string."""
    cp = _make_mock_cp(rows=_completed_row("   "))
    provider = FlowGeminiProvider(control_plane=cp)

    with pytest.raises(LLMError, match="empty"):
        await provider.run("hi")


@pytest.mark.asyncio
async def test_poll_timeout_raises_llm_error(identity_env):
    """Req 8.5 — when the job never reaches a terminal state within the
    timeout budget, ``run`` raises an ``LLMError`` mentioning the timeout.

    The poll interval is shrunk so the test resolves in well under a second.
    """
    cp = _make_mock_cp(rows={"status": "queued"})  # never terminal
    provider = FlowGeminiProvider(control_plane=cp)
    provider._poll_interval = 0.005  # keep polls bounded & fast

    with pytest.raises(LLMError, match="timed out"):
        await provider.run("hi", timeout=0.05)


@pytest.mark.asyncio
async def test_failed_job_raises_llm_error(identity_env):
    """Req 8 — a ``failed`` request row surfaces an ``LLMError``."""
    cp = _make_mock_cp(
        rows={"status": "failed", "error_message": "upstream blew up"}
    )
    provider = FlowGeminiProvider(control_plane=cp)

    with pytest.raises(LLMError, match="failed"):
        await provider.run("hi")


@pytest.mark.asyncio
async def test_unreadable_attachment_skipped_valid_kept(identity_env, tmp_path):
    """Req 7.2 — a per-attachment read failure is skipped; remaining valid
    attachments still go through. One nonexistent path + one real file → only
    the valid one lands in ``input_data['attachments']``."""
    good = tmp_path / "real.png"
    good.write_bytes(b"\x89PNG\r\n\x1a\nrealbytes")
    missing = str(tmp_path / "does_not_exist.png")

    cp = _make_mock_cp(rows=_completed_row("ok"))
    provider = FlowGeminiProvider(control_plane=cp)

    await provider.run("describe", attachments=[missing, str(good)])

    atts = cp.create_or_reset_request.await_args.kwargs["input_data"]["attachments"]
    assert len(atts) == 1
    assert base64.b64decode(atts[0]["data"]) == b"\x89PNG\r\n\x1a\nrealbytes"


@pytest.mark.asyncio
async def test_empty_attachments_yields_text_only_payload(identity_env):
    """Req 7.5 — an empty attachments list yields a payload with no
    ``attachments`` key (text-only)."""
    cp = _make_mock_cp(rows=_completed_row("ok"))
    provider = FlowGeminiProvider(control_plane=cp)

    await provider.run("text only", attachments=[])

    input_data = cp.create_or_reset_request.await_args.kwargs["input_data"]
    assert "attachments" not in input_data


# ════════════════════════════════════════════════════════════════════════
# Task 6.6 — redaction / secrets
# ════════════════════════════════════════════════════════════════════════
#
# Validates: Requirements 9.1, 9.2, 9.3


def test_sanitize_error_scrubs_bearer_token():
    """Req 9.3 — Bearer-shaped tokens are scrubbed from error strings."""
    secret = "ya29.A0ARrdaM-FAKE_bearer.token123"
    out = _sanitize_error(f"auth rejected: Bearer {secret}")
    assert secret not in out
    assert "[REDACTED]" in out


def test_sanitize_error_scrubs_token_fields():
    """Req 9.3 — ``token`` / ``recaptcha`` / ``authorization`` value shapes
    are scrubbed."""
    recaptcha = "03AGdBq26FAKErecaptchaTOKENvalue-xyz"
    out = _sanitize_error(f'{{"token": "{recaptcha}"}}')
    assert recaptcha not in out
    assert "[REDACTED]" in out

    out2 = _sanitize_error(f"recaptchaToken={recaptcha}")
    assert recaptcha not in out2
    assert "[REDACTED]" in out2


@pytest.mark.asyncio
async def test_dispatch_log_records_hash_and_length_not_raw_prompt(
    identity_env, caplog
):
    """Req 9.2 — the dispatch log records the prompt length and a short hash,
    never the raw prompt content."""
    prompt = "TOP_SECRET sensitive customer api_key=sk-live-abc123 do not log me"
    cp = _make_mock_cp(rows=_completed_row("ok"))
    provider = FlowGeminiProvider(control_plane=cp)

    with caplog.at_level(logging.INFO, logger="flowboard.services.llm.flow_gemini"):
        await provider.run(prompt)

    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
    # Raw prompt MUST NOT appear; length + hash MUST.
    assert prompt not in caplog.text
    assert "TOP_SECRET" not in caplog.text
    assert f"prompt_len={len(prompt)}" in caplog.text
    assert prompt_hash in caplog.text


@pytest.mark.asyncio
async def test_bearer_token_never_in_logs_or_error(identity_env, caplog):
    """Req 9.1 / 9.3 — a Bearer token echoed back in a worker failure reason
    never reaches the surfaced error message or the logs."""
    bearer = "ya29.A0ARrdaM-LEAKED_bearer.token_99887766"
    cp = _make_mock_cp(
        rows={"status": "failed", "error_message": f"denied Bearer {bearer}"}
    )
    provider = FlowGeminiProvider(control_plane=cp)

    with caplog.at_level(logging.DEBUG, logger="flowboard.services.llm.flow_gemini"):
        with pytest.raises(LLMError) as exc_info:
            await provider.run("hi")

    err = str(exc_info.value)
    assert bearer not in err
    assert "[REDACTED]" in err
    assert bearer not in caplog.text
