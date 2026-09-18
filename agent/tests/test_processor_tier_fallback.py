"""Tests for the worker processor's paygate_tier resolution chain.

The handler reads tier from three sources in priority order:
  1. params["paygate_tier"] — stamped by the frontend at dispatch
  2. flow_client.paygate_tier — a live signal, if an extension old enough to
     capture a Bearer token is attached
  3. FLOWBOARD_PAYGATE_TIER — the configured plan

Link 3 replaced an outright refusal. Link 2 used to be the authoritative one,
resolved against /v1/credits with the sniffed Bearer; flow.google.com mints no
Bearer, so it is now permanently absent and "fail loud when both are missing"
would mean failing every dispatch.

The bug that rule existed for is still guarded, one layer down: the tier picks
the video checkpoint, so it must never be *guessed*. An unrecognised value
raises in `flow_sdk.resolve_paygate_tier` and the handler reports it instead
of dispatching — see test_gen_image_refuses_a_misconfigured_tier. The old
default (a hardcoded PAYGATE_TIER_ONE) downgraded Ultra users to Pro and
stamped the wrong tier into the DB, poisoning /api/auth/me for the session.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import DEFAULT_PAYGATE_TIER
from flowboard.worker import processor as proc


@pytest.fixture(autouse=True)
def _reset_flow_client_tier():
    flow_client._paygate_tier = None
    yield
    flow_client._paygate_tier = None


@pytest.mark.asyncio
async def test_gen_image_uses_caller_stamped_tier_first():
    """When the dispatch stamps a tier into params, that wins —
    caller intent always beats the live signal."""
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(return_value={
            "media_ids": ["m"],
            "media_entries": [],
        })
        await proc._handle_gen_image({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "paygate_tier": "PAYGATE_TIER_ONE",  # explicit caller value
        })
        kwargs = m.return_value.gen_image.call_args.kwargs
        assert kwargs["paygate_tier"] == "PAYGATE_TIER_ONE"


@pytest.mark.asyncio
async def test_gen_image_falls_back_to_live_flow_client_tier():
    """No paygate_tier in params + flow_client has one cached →
    handler must pick up the live signal instead of defaulting to
    TIER_ONE. This is the case we regressed away from before #20:
    legacy frontends that don't stamp tier still got the right tier
    once the extension sniffed it."""
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(return_value={
            "media_ids": ["m"],
            "media_entries": [],
        })
        await proc._handle_gen_image({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            # no paygate_tier — relies on the fallback chain
        })
        kwargs = m.return_value.gen_image.call_args.kwargs
        assert kwargs["paygate_tier"] == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_gen_image_falls_back_to_the_configured_tier():
    """No caller-stamped tier and no live signal → use the configured plan.

    This is the normal state since the Flow migration: nothing can sniff a
    tier any more. The handler must dispatch with the configured value rather
    than refusing, and must pass exactly that value through — not a guess of
    its own.
    """
    flow_client._paygate_tier = None

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(return_value={
            "media_ids": ["m"],
            "media_entries": [],
        })
        _, err = await proc._handle_gen_image({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
        })
        assert err is None
        kwargs = m.return_value.gen_image.call_args.kwargs
        assert kwargs["paygate_tier"] == DEFAULT_PAYGATE_TIER


@pytest.mark.asyncio
async def test_gen_video_falls_back_to_the_configured_tier():
    """Same chain, gen_video path — the one the tier actually still steers."""
    flow_client._paygate_tier = None

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video = AsyncMock(return_value={
            "operation_names": [],
        })
        _, err = await proc._handle_gen_video({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "src-1",
        })
        # No operations came back from the stub, so the handler reports that —
        # what matters here is that it got far enough to dispatch at all.
        assert err == "no_operations_returned"
        kwargs = m.return_value.gen_video.call_args.kwargs
        assert kwargs["paygate_tier"] == DEFAULT_PAYGATE_TIER


@pytest.mark.asyncio
async def test_edit_image_falls_back_to_the_configured_tier():
    """Same chain, edit_image path."""
    flow_client._paygate_tier = None

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.edit_image = AsyncMock(return_value={
            "media_ids": ["m"],
            "media_entries": [],
        })
        _, err = await proc._handle_edit_image({
            "prompt": "make it pop",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "source_media_id": "src-1",
        })
        assert err is None
        kwargs = m.return_value.edit_image.call_args.kwargs
        assert kwargs["paygate_tier"] == DEFAULT_PAYGATE_TIER


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "handler,params",
    [
        ("_handle_gen_image", {}),
        ("_handle_gen_video", {"start_media_id": "src-1"}),
        ("_handle_edit_image", {"source_media_id": "src-1"}),
    ],
)
async def test_handlers_refuse_a_misconfigured_tier(handler, params, monkeypatch):
    """A tier nobody recognises must stop the dispatch, not pick a checkpoint.

    This is what is left of the silent-Pro-downgrade guard: the value is now
    declared rather than sniffed, so the failure mode moved from "absent" to
    "wrong", and a wrong one still must never reach Flow.
    """
    from flowboard.services import flow_sdk

    flow_client._paygate_tier = None
    monkeypatch.setattr(flow_sdk, "DEFAULT_PAYGATE_TIER", "PAYGATE_TIER_PLATINUM")

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        _, err = await getattr(proc, handler)({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            **params,
        })
        assert err is not None and "paygate_tier_invalid" in err
        assert "PAYGATE_TIER_PLATINUM" in err
        # The SDK must not have been touched — the worker bailed before dispatch.
        m.return_value.gen_image.assert_not_called()
        m.return_value.gen_video.assert_not_called()
        m.return_value.edit_image.assert_not_called()


@pytest.mark.asyncio
async def test_gen_video_applies_same_resolution_chain():
    """Resolution chain must be consistent across handlers — gen_video
    has its own copy of the lookup, so verify it behaves the same."""
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        # Stub the dispatch to return a synthesised "no operations"
        # so the handler exits before polling. We only care about the
        # tier arg passed to gen_video.
        m.return_value.gen_video = AsyncMock(return_value={
            "operation_names": [],
        })
        await proc._handle_gen_video({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "src-1",
            # no paygate_tier — fallback path
        })
        kwargs = m.return_value.gen_video.call_args.kwargs
        assert kwargs["paygate_tier"] == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_edit_image_applies_same_resolution_chain():
    """Third handler — same chain, same expectation."""
    flow_client._paygate_tier = "PAYGATE_TIER_TWO"

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.edit_image = AsyncMock(return_value={
            "media_ids": ["m"],
            "media_entries": [],
        })
        await proc._handle_edit_image({
            "prompt": "make it pop",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "source_media_id": "src-1",
        })
        kwargs = m.return_value.edit_image.call_args.kwargs
        assert kwargs["paygate_tier"] == "PAYGATE_TIER_TWO"
