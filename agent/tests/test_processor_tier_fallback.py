"""Tests for the worker processor's paygate_tier resolution chain.

The handler reads tier from three sources in priority order:
  1. params["paygate_tier"] — stamped by the frontend at dispatch
  2. flow_client.paygate_tier — live signal pushed by extension
  3. "PAYGATE_TIER_ONE" — last-resort default

This was a behavior change made in response to the audit (#20): the
handlers used to read only from params, which meant a stale frontend
that fell back to TIER_ONE before the extension finished sniffing the
real tier would dispatch every request at TIER_ONE forever — even
after `flow_client.paygate_tier` was populated.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services.flow_client import flow_client
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
async def test_gen_image_defaults_to_tier_one_when_nothing_set():
    """No params, no flow_client cache → safe default. Without this
    the SDK would receive None and pass it through to Flow, which the
    audit fix #16 already clamps but ideally never sees."""
    flow_client._paygate_tier = None

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(return_value={
            "media_ids": ["m"],
            "media_entries": [],
        })
        await proc._handle_gen_image({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
        })
        kwargs = m.return_value.gen_image.call_args.kwargs
        assert kwargs["paygate_tier"] == "PAYGATE_TIER_ONE"


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
