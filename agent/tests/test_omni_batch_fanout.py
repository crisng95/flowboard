"""Bug-condition probe for the Omni Flash video batch fan-out regression.

Bug: when a 3-prompt list + a 3-image list are wired into a Video node and
the user picks x3, Omni Flash produces only 1 video instead of 3. The
backend handler ``_handle_gen_video_omni`` never reads ``start_media_ids`` /
``prompts`` from the request params and so never forwards the batch to the
SDK — even though ``FlowSDK.gen_video_omni`` already fans out one operation
per source image when handed ``start_media_ids``.

This probe simulates the handler with a 3-element batch and asserts the
CORRECT post-fix behaviour: the SDK must receive ``start_media_ids`` of
length 3. On the unfixed handler this FAILS (the handler bails out early
with ``missing_ref_media_ids`` and never calls the SDK), which confirms the
bug condition exists.

Once the handler is fixed (Task 2) this test must PASS.

**Validates: Requirements 1.1**
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services.flow_client import flow_client
from flowboard.worker import processor as proc

# A project id matching the shape Flow returns (UUID-ish), accepted by
# ``is_valid_project_id`` (regex ^[A-Za-z0-9_-]{1,128}$). Mirrors the ids
# used across tests/test_processor_tier_fallback.py.
_PROJECT_ID = "8b62385c-4916-4abd-b01f-b28173d8eb04"


@pytest.mark.asyncio
async def test_omni_handler_forwards_start_media_ids_batch_to_sdk():
    """Omni Flash must fan a 3-image / 3-prompt batch out to the SDK.

    Expected post-fix: ``sdk.gen_video_omni`` is called with
    ``start_media_ids`` of length 3 (one source image per video op).

    On the unfixed handler the SDK is never called (the handler returns
    ``missing_ref_media_ids`` before dispatch) — proving the bug.
    """
    flow_client._paygate_tier = "PAYGATE_TIER_ONE"

    params = {
        "prompt": "shared fallback prompt",
        "project_id": _PROJECT_ID,
        "start_media_ids": ["a", "b", "c"],
        "prompts": ["p1", "p2", "p3"],
        "duration_s": 4,
        "paygate_tier": "PAYGATE_TIER_ONE",
    }

    # Echo cross-project sync back in input order so the batch order is
    # preserved and no real network/upload is attempted.
    async def _fake_ensure(media_ids, project_id):
        return list(media_ids), []

    with patch("flowboard.worker.processor.get_flow_sdk") as m_sdk, patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project",
        new=AsyncMock(side_effect=_fake_ensure),
    ):
        # Stub the dispatch to return "no operations" so the handler exits
        # right after the SDK call instead of polling — we only care about
        # the batch arguments the handler hands to the SDK.
        m_sdk.return_value.gen_video_omni = AsyncMock(
            return_value={"operation_names": []}
        )

        result, err = await proc._handle_gen_video_omni(params)

        gen = m_sdk.return_value.gen_video_omni
        assert gen.called, (
            "BUG CONFIRMED: _handle_gen_video_omni never called the SDK with "
            "the batch. The handler does not read `start_media_ids` and bailed "
            f"out before dispatch (returned err={err!r}, result keys="
            f"{list(result)!r}). Expected it to forward a 3-image batch to "
            "sdk.gen_video_omni."
        )

        kwargs = gen.call_args.kwargs
        start_ids = kwargs.get("start_media_ids")
        assert start_ids is not None, (
            "BUG CONFIRMED: _handle_gen_video_omni called the SDK but did NOT "
            f"forward start_media_ids (SDK kwargs={kwargs!r}). The batch "
            "collapsed into a single request."
        )
        assert len(start_ids) == 3, (
            f"expected start_media_ids of length 3, got {start_ids!r}"
        )
        assert list(start_ids) == ["a", "b", "c"], (
            f"expected start_media_ids order preserved, got {start_ids!r}"
        )


# ===========================================================================
# Property-based tests (Task 4.2 / 4.3 / 4.4) — Properties P1–P6
#
# These exercise the Omni Flash batch fan-out across many random inputs.
#
# async + hypothesis note: we deliberately do NOT combine ``@given`` with
# ``@pytest.mark.asyncio`` (that pairing is flaky / unsupported). Instead each
# ``@given`` test is a plain sync function that drives the coroutine under
# test via ``asyncio.run(...)``. ``deadline=None`` avoids spurious deadline
# failures from event-loop setup per example.
# ===========================================================================
import asyncio
import string

from hypothesis import given, settings
from hypothesis import strategies as st

from flowboard.services.flow_sdk import FlowSDK

# Media-id alphabet: only chars that survive the handler's ``strip()`` /
# truthiness cleaning, so a generated id is never silently dropped. This keeps
# "list is non-empty" equivalent to "list has a usable id" for the validation
# property (P6).
_ID_ALPHABET = string.ascii_letters + string.digits + "-_"
_id_strategy = st.text(alphabet=_ID_ALPHABET, min_size=1, max_size=10)

# Per-variant prompts: free-form text, allowed to be shorter than the number
# of sources (to exercise the shared-prompt fallback) and to contain empty
# strings (falsy → fallback) or whitespace (truthy → used as-is).
_prompts_strategy = st.lists(st.text(max_size=12), min_size=0, max_size=8)

_SHARED_PROMPT = "shared fallback prompt"


def _expected_item_text(prompts, i, shared):
    """Replicate FlowSDK.gen_video_omni's per-item prompt selection exactly:
    use ``prompts[i]`` when present and truthy, else the shared ``prompt``."""
    if prompts and i < len(prompts) and isinstance(prompts[i], str) and prompts[i]:
        return prompts[i]
    return shared


class _RecordingClient:
    """Minimal fake FlowClient that records api_request kwargs and returns a
    canned response — mirrors tests/test_flow_sdk.py::RecordingClient."""

    def __init__(self) -> None:
        self.api_calls: list[dict] = []
        self.api_response: dict = {}

    async def api_request(self, **kwargs):
        self.api_calls.append(kwargs)
        return self.api_response

    async def trpc_request(self, **kwargs):  # pragma: no cover - unused here
        return {}


# ── Task 4.2 — SDK property test (Properties P1, P2) ───────────────────────

@settings(deadline=None, max_examples=60)
@given(start_ids=st.lists(_id_strategy, min_size=2, max_size=6, unique=True),
       prompts=_prompts_strategy)
def test_sdk_gen_video_omni_fans_out_one_item_per_source(start_ids, prompts):
    """SDK fan-out: one request item per ``start_media_ids`` entry, with each
    item's source image leading its ``referenceImages`` and its text resolved
    from ``prompts[i]`` (falling back to the shared prompt).

    Property P1: ``len(body["requests"]) == len(start_media_ids)``.
    Property P2: item ``i`` leads ``referenceImages`` with ``start_media_ids[i]``
    and uses ``prompts[i]`` (or the shared prompt when missing/empty).

    **Validates: Requirements 1.1, 1.2, 1.4**
    """
    async def _inner():
        c = _RecordingClient()
        n = len(start_ids)
        c.api_response = {
            "status": 200,
            "data": {
                "operations": [
                    {"operation": {"name": f"op-{i}"}} for i in range(n)
                ]
            },
        }
        sdk = FlowSDK(client=c)  # type: ignore[arg-type]
        await sdk.gen_video_omni(
            prompt=_SHARED_PROMPT,
            project_id="proj-1",
            ref_media_ids=[],            # pure batch (no shared ingredients)
            duration_s=4,
            aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
            paygate_tier="PAYGATE_TIER_ONE",
            start_media_ids=start_ids,
            prompts=prompts,
        )

        assert len(c.api_calls) == 1, "expected exactly one Flow API call"
        items = c.api_calls[0]["body"]["requests"]

        # P1 — one item per source image.
        assert len(items) == n, (
            f"P1 violated: expected {n} request items (one per source), "
            f"got {len(items)}"
        )

        for i, mid in enumerate(start_ids):
            refs = items[i]["referenceImages"]
            # P2 — source image leads referenceImages.
            assert refs[0]["mediaId"] == mid, (
                f"P2 violated: item {i} should lead referenceImages with "
                f"{mid!r}, got {refs[0]['mediaId']!r}"
            )
            # P2 — per-item text pairs with prompts[i] / shared fallback.
            text = items[i]["textInput"]["structuredPrompt"]["parts"][0]["text"]
            assert text == _expected_item_text(prompts, i, _SHARED_PROMPT), (
                f"P2 violated: item {i} text {text!r} != expected "
                f"{_expected_item_text(prompts, i, _SHARED_PROMPT)!r}"
            )

    asyncio.run(_inner())


# ── Handler test helpers ───────────────────────────────────────────────────

async def _run_omni_handler(params):
    """Drive ``_handle_gen_video_omni`` with the SDK + cross-project sync
    mocked out. Returns ``(gen_mock, result, err)``.

    * ``ensure_media_ids_in_project`` echoes its input in order (no real
      upload), so the batch order is preserved end-to-end.
    * ``sdk.gen_video_omni`` returns ``{"operation_names": []}`` so the
      handler exits at ``no_operations_returned`` right after dispatch
      instead of entering the (slow) poll loop — we only care about the
      arguments handed to the SDK.
    """
    async def _fake_ensure(media_ids, project_id):
        return list(media_ids), []

    with patch("flowboard.worker.processor.get_flow_sdk") as m_sdk, patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project",
        new=AsyncMock(side_effect=_fake_ensure),
    ):
        gen = AsyncMock(return_value={"operation_names": []})
        m_sdk.return_value.gen_video_omni = gen
        result, err = await proc._handle_gen_video_omni(params)
        return gen, result, err


# ── Task 4.3 — handler property tests (Properties P3, P4, P5) ──────────────

@settings(deadline=None, max_examples=60)
@given(start_ids=st.lists(_id_strategy, min_size=2, max_size=6, unique=True),
       prompts=_prompts_strategy)
def test_handler_forwards_batch_sources_in_order(start_ids, prompts):
    """Handler batch path: ``_handle_gen_video_omni`` forwards the batch
    sources to the SDK with the exact count AND order it received — the
    cross-project sync (echoed here) must not perturb positions.

    Property P5: order of ``start_media_ids`` is preserved through sync, so
    ``media_ids[i]`` always maps back to source ``i``.
    Property P3 (count, model-independent): N sources in → N sources out,
    establishing that fan-out width is driven by the inputs, not the model.

    **Validates: Requirements 1.1, 1.3, 3.1, 3.2**
    """
    async def _inner():
        params = {
            "prompt": _SHARED_PROMPT,
            "project_id": _PROJECT_ID,
            "start_media_ids": list(start_ids),
            "prompts": list(prompts),
            "duration_s": 4,
            "paygate_tier": "PAYGATE_TIER_ONE",
        }
        gen, _result, _err = await _run_omni_handler(params)

        assert gen.called, "handler must dispatch the batch to the SDK"
        kwargs = gen.call_args.kwargs
        forwarded = kwargs.get("start_media_ids")
        assert forwarded is not None, "handler dropped start_media_ids"
        # P3 — count preserved (fan-out width = number of sources).
        assert len(forwarded) == len(start_ids), (
            f"P3 violated: forwarded {len(forwarded)} sources, "
            f"expected {len(start_ids)}"
        )
        # P5 — order preserved exactly through the sync echo.
        assert list(forwarded) == list(start_ids), (
            f"P5 violated: source order changed: {forwarded!r} != {start_ids!r}"
        )
        # per-variant prompts forwarded unchanged when present.
        cleaned = [p for p in prompts if isinstance(p, str) and p.strip()]
        if cleaned:
            assert kwargs.get("prompts") == cleaned

    asyncio.run(_inner())


@settings(deadline=None, max_examples=60)
@given(ref_ids=st.lists(_id_strategy, min_size=1, max_size=6, unique=True))
def test_handler_single_input_does_not_fan_out(ref_ids):
    """Handler single-input path: with only ``ref_media_ids`` (no batch
    sources), the handler forwards the shared ingredients and passes
    ``start_media_ids=None`` so the SDK keeps its single-clip behaviour.

    Property P4: no batch arrays → exactly one video conditioned on the
    shared ``ref_media_ids`` (no fan-out, no regression).

    **Validates: Requirements 2.1, 2.3**
    """
    async def _inner():
        params = {
            "prompt": _SHARED_PROMPT,
            "project_id": _PROJECT_ID,
            "ref_media_ids": list(ref_ids),
            "duration_s": 4,
            "paygate_tier": "PAYGATE_TIER_ONE",
        }
        gen, _result, _err = await _run_omni_handler(params)

        assert gen.called, "handler must still dispatch the single-input video"
        kwargs = gen.call_args.kwargs
        # P4 — no batch fan-out.
        assert kwargs.get("start_media_ids") is None, (
            f"P4 violated: single-input request must not set start_media_ids, "
            f"got {kwargs.get('start_media_ids')!r}"
        )
        # Shared ingredients forwarded in order (sync echo preserves them).
        assert list(kwargs.get("ref_media_ids") or []) == list(ref_ids), (
            f"P4 violated: ref_media_ids {kwargs.get('ref_media_ids')!r} "
            f"!= {ref_ids!r}"
        )

    asyncio.run(_inner())


# ── Task 4.4 — validation property test (Property P6) ──────────────────────

@settings(deadline=None, max_examples=80)
@given(start_ids=st.lists(_id_strategy, min_size=0, max_size=5, unique=True),
       ref_ids=st.lists(_id_strategy, min_size=0, max_size=5, unique=True))
def test_handler_validation_requires_at_least_one_source(start_ids, ref_ids):
    """Handler validation: a request is valid iff at least one image source
    exists. When BOTH ``start_media_ids`` and ``ref_media_ids`` are empty the
    handler returns ``missing_ref_media_ids`` and never calls the SDK;
    otherwise it does NOT return that error and dispatches.

    Property P6: valid ⟺ (start_media_ids non-empty OR ref_media_ids
    non-empty); empty/empty → ``missing_ref_media_ids``.

    **Validates: Requirements 2.2**
    """
    async def _inner():
        params = {
            "prompt": _SHARED_PROMPT,
            "project_id": _PROJECT_ID,
            "start_media_ids": list(start_ids),
            "ref_media_ids": list(ref_ids),
            "duration_s": 4,                 # valid → never invalid_duration_s
            "paygate_tier": "PAYGATE_TIER_ONE",
        }
        gen, _result, err = await _run_omni_handler(params)

        both_empty = not start_ids and not ref_ids
        if both_empty:
            assert err == "missing_ref_media_ids", (
                f"P6 violated: empty/empty must reject with "
                f"missing_ref_media_ids, got err={err!r}"
            )
            assert not gen.called, (
                "P6 violated: SDK must not be called when no source exists"
            )
        else:
            assert err != "missing_ref_media_ids", (
                f"P6 violated: a request with at least one source must pass "
                f"validation, got missing_ref_media_ids (start={start_ids!r}, "
                f"ref={ref_ids!r})"
            )
            assert gen.called, (
                "P6 violated: validation passed but the SDK was never called"
            )

    asyncio.run(_inner())


# ===========================================================================
# Task 5.1 / 5.2 — Veo↔Omni symmetry (P3) and per-slot error ordering (P5)
#
# 5.1 asserts the fan-out width is model-independent: for the SAME
#     start_media_ids + prompts, _handle_gen_video (Veo) forwards exactly as
#     many sources to sdk.gen_video as _handle_gen_video_omni forwards to
#     sdk.gen_video_omni — and both equal N.
#
# 5.2 drives the Omni handler THROUGH its poll loop with a middle op failing
#     (content filter) and asserts the surviving slots keep their position:
#     media_ids == ["m0", None, "m2"] and slot_errors[1] carries the reason.
# ===========================================================================


@pytest.mark.asyncio
async def test_veo_and_omni_forward_equal_source_count_for_same_batch():
    """Veo↔Omni symmetry: identical batch inputs fan out to the SAME number
    of SDK sources on both models.

    With ``start_media_ids`` of length N (and matching ``prompts``), the
    number of sources ``_handle_gen_video`` forwards to ``sdk.gen_video``
    equals the number ``_handle_gen_video_omni`` forwards to
    ``sdk.gen_video_omni`` — and both equal N. Fan-out width is driven by the
    inputs, not the model.

    Both SDK stubs return ``{"operation_names": []}`` so each handler exits
    right after dispatch (``no_operations_returned``); we only inspect the
    forwarded ``start_media_ids`` kwargs.

    Property P3. **Validates: Requirements 1.1, 3.1**
    """
    start_ids = ["a", "b", "c"]
    prompts = ["p0", "p1", "p2"]
    n = len(start_ids)

    # Omni does cross-project sync; echo it back in input order so the batch
    # order is preserved and no real upload is attempted. Veo does not sync,
    # so this patch is harmless for the Veo call.
    async def _fake_ensure(media_ids, project_id):
        return list(media_ids), []

    with patch("flowboard.worker.processor.get_flow_sdk") as m_sdk, patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project",
        new=AsyncMock(side_effect=_fake_ensure),
    ):
        m_sdk.return_value.gen_video = AsyncMock(
            return_value={"operation_names": []}
        )
        m_sdk.return_value.gen_video_omni = AsyncMock(
            return_value={"operation_names": []}
        )

        # Veo batch path: pass start_media_ids (NOT the singular
        # start_media_id) so the handler takes the batch branch. Aspect/tier
        # default; video_quality is optional and omitted.
        veo_params = {
            "prompt": _SHARED_PROMPT,
            "project_id": _PROJECT_ID,
            "start_media_ids": list(start_ids),
            "prompts": list(prompts),
            "paygate_tier": "PAYGATE_TIER_ONE",
        }
        await proc._handle_gen_video(veo_params)

        # Omni batch path: same sources + prompts, plus a valid duration.
        omni_params = {
            "prompt": _SHARED_PROMPT,
            "project_id": _PROJECT_ID,
            "start_media_ids": list(start_ids),
            "prompts": list(prompts),
            "duration_s": 4,
            "paygate_tier": "PAYGATE_TIER_ONE",
        }
        await proc._handle_gen_video_omni(omni_params)

        gen_veo = m_sdk.return_value.gen_video
        gen_omni = m_sdk.return_value.gen_video_omni
        assert gen_veo.called, "Veo handler must dispatch the batch to sdk.gen_video"
        assert gen_omni.called, (
            "Omni handler must dispatch the batch to sdk.gen_video_omni"
        )

        forwarded_veo = gen_veo.call_args.kwargs.get("start_media_ids")
        forwarded_omni = gen_omni.call_args.kwargs.get("start_media_ids")
        assert forwarded_veo is not None, "Veo dropped start_media_ids"
        assert forwarded_omni is not None, "Omni dropped start_media_ids"

        # P3 — fan-out width is identical across models and equals N.
        assert len(forwarded_veo) == len(forwarded_omni) == n, (
            f"P3 violated: Veo forwarded {len(forwarded_veo)} sources, Omni "
            f"forwarded {len(forwarded_omni)}, expected {n} each"
        )


@pytest.mark.asyncio
async def test_omni_handler_preserves_slot_order_when_middle_op_fails(monkeypatch):
    """Per-slot error ordering: a failed middle op does not shift the
    surviving slots.

    The Omni handler runs through its poll loop with three ops where the
    middle one (``op-1``) terminates with a content-filter error while
    ``op-0`` and ``op-2`` succeed. The positional result must keep the failed
    slot as ``None`` in place (no left-shift), and ``slot_errors`` must carry
    the reason at the same index. Because ≥1 op succeeded, the batch is a
    partial success (``err is None``).

    Property P5 + Error Handling. **Validates: Requirements 1.3, 3.2**
    """
    # Run the poll loop with no real delay.
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0)

    async def _fake_ensure(media_ids, project_id):
        return list(media_ids), []

    # check_async response: op-0 + op-2 done with a media entry, op-1 fails
    # with a content-filter error. The handler reads ``e.get("media_id")``
    # so entries use the ``media_id`` key.
    poll_response = {
        "operations": [
            {"name": "op-0", "done": True, "media_entries": [{"media_id": "m0"}]},
            {"name": "op-1", "error": "PUBLIC_ERROR_UNSAFE_GENERATION"},
            {"name": "op-2", "done": True, "media_entries": [{"media_id": "m2"}]},
        ]
    }

    with patch("flowboard.worker.processor.get_flow_sdk") as m_sdk, patch(
        "flowboard.services.media_project_sync.ensure_media_ids_in_project",
        new=AsyncMock(side_effect=_fake_ensure),
    ):
        m_sdk.return_value.gen_video_omni = AsyncMock(
            return_value={"operation_names": ["op-0", "op-1", "op-2"]}
        )
        m_sdk.return_value.check_async = AsyncMock(return_value=poll_response)

        params = {
            "prompt": _SHARED_PROMPT,
            "project_id": _PROJECT_ID,
            "start_media_ids": ["a", "b", "c"],
            "prompts": ["p0", "p1", "p2"],
            "duration_s": 4,
            "paygate_tier": "PAYGATE_TIER_ONE",
        }
        result, err = await proc._handle_gen_video_omni(params)

    # P5 — failed middle slot stays None in place; survivors keep position.
    assert result["media_ids"] == ["m0", None, "m2"], (
        f"P5 violated: slot order shifted, got {result['media_ids']!r}"
    )
    # slot_errors mirrors media_ids by index: only the failed slot carries
    # the reason.
    assert result["slot_errors"][1] == "PUBLIC_ERROR_UNSAFE_GENERATION", (
        f"expected filter reason at slot 1, got {result['slot_errors']!r}"
    )
    assert result["slot_errors"][0] is None, (
        f"slot 0 succeeded, expected no error, got {result['slot_errors'][0]!r}"
    )
    assert result["slot_errors"][2] is None, (
        f"slot 2 succeeded, expected no error, got {result['slot_errors'][2]!r}"
    )
    # ≥1 op succeeded → partial batch is still an overall success.
    assert err is None, (
        f"expected partial-success batch (err is None), got err={err!r}"
    )
