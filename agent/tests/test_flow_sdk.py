"""Tests for the minimal Flow SDK. Uses a recording fake FlowClient so we can
assert on the JSON-RPC shape without touching a real WS.
"""
from typing import Any

import pytest

from flowboard.services.flow_sdk import (
    FlowSDK,
    _extract_inner_api_error,
    _extract_project_id,
    _extract_media_ids,
    extract_media_entries,
    extract_operation_names,
    extract_video_operations,
)


class RecordingClient:
    def __init__(self) -> None:
        self.api_calls: list[dict[str, Any]] = []
        self.trpc_calls: list[dict[str, Any]] = []
        self.trpc_response: dict[str, Any] = {}
        self.api_response: dict[str, Any] = {}

    async def api_request(self, **kwargs):
        self.api_calls.append(kwargs)
        return self.api_response

    async def trpc_request(self, **kwargs):
        self.trpc_calls.append(kwargs)
        return self.trpc_response


def _make_project_response(project_id: str = "proj-123") -> dict:
    return {
        "status": 200,
        "data": {
            "result": {"data": {"json": {"result": {"projectId": project_id}}}}
        },
    }


def _make_gen_image_response(ids: list[str], with_urls: bool = False) -> dict:
    media = []
    for mid in ids:
        item: dict[str, Any] = {"name": mid}
        if with_urls:
            item["image"] = {
                "generatedImage": {
                    "fifeUrl": f"https://flow-content.google/image/{mid}?sig=xyz",
                    "mediaId": mid,
                },
            }
        media.append(item)
    return {"status": 200, "data": {"media": media}}


@pytest.mark.asyncio
async def test_create_project_body_shape_and_id_extraction():
    c = RecordingClient()
    c.trpc_response = _make_project_response("p-xyz")
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.create_project("Test Board")

    assert len(c.trpc_calls) == 1
    call = c.trpc_calls[0]
    assert call["url"] == "https://labs.google/fx/api/trpc/project.createProject"
    assert call["method"] == "POST"
    assert call["body"] == {
        "json": {"projectTitle": "Test Board", "toolName": "PINHOLE"}
    }
    assert call["headers"]["content-type"] == "application/json"
    assert out["project_id"] == "p-xyz"
    assert out["raw"]["status"] == 200


@pytest.mark.asyncio
async def test_create_project_surfaces_error_when_id_missing():
    c = RecordingClient()
    c.trpc_response = {"status": 200, "data": {"result": {"data": {"json": {}}}}}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.create_project("x")
    assert "project_id" not in out
    assert out["error"] == "no_project_id_in_response"


@pytest.mark.asyncio
async def test_create_project_passes_extension_error_through():
    c = RecordingClient()
    c.trpc_response = {"error": "extension_disconnected"}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.create_project("x")
    assert out["error"] == "extension_disconnected"
    assert out["raw"] == {"error": "extension_disconnected"}


@pytest.mark.asyncio
async def test_gen_image_body_shape_includes_captcha_and_context():
    c = RecordingClient()
    c.api_response = _make_gen_image_response(["m-1", "m-2"])
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_image(
        prompt="a sleeping cat",
        project_id="proj-123",
        aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
    )

    assert len(c.api_calls) == 1
    call = c.api_calls[0]
    assert call["captcha_action"] == "IMAGE_GENERATION"
    assert call["method"] == "POST"
    assert call["url"].endswith("/v1/projects/proj-123/flowMedia:batchGenerateImages")

    body = call["body"]
    assert body["clientContext"]["projectId"] == "proj-123"
    assert body["clientContext"]["recaptchaContext"]["token"] == ""  # extension fills in
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_ONE"

    assert body["useNewMedia"] is True
    assert "batchId" in body["mediaGenerationContext"]
    req = body["requests"][0]
    assert req["imageAspectRatio"] == "IMAGE_ASPECT_RATIO_LANDSCAPE"
    assert req["structuredPrompt"]["parts"][0]["text"] == "a sleeping cat"
    assert req["imageModelName"] == "GEM_PIX_2"
    assert isinstance(req["seed"], int)

    assert out["media_ids"] == ["m-1", "m-2"]


@pytest.mark.asyncio
async def test_gen_image_resolves_image_model_nickname_to_flow_id():
    """The user-facing nickname (NANO_BANANA_PRO / NANO_BANANA_2) must
    map to the correct Flow model identifier in the request body. Tests
    both branches plus the unknown-key fallback to Pro."""
    c = RecordingClient()
    c.api_response = _make_gen_image_response(["m-1"])
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]

    # Banana 2 → NARWHAL
    await sdk.gen_image(
        prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE",
        image_model="NANO_BANANA_2",
    )
    assert c.api_calls[-1]["body"]["requests"][0]["imageModelName"] == "NARWHAL"

    # Pro explicit → GEM_PIX_2
    await sdk.gen_image(
        prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE",
        image_model="NANO_BANANA_PRO",
    )
    assert c.api_calls[-1]["body"]["requests"][0]["imageModelName"] == "GEM_PIX_2"

    # Unknown key → fallback to Pro (defends against stale frontend).
    await sdk.gen_image(
        prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE",
        image_model="BOGUS_MODEL",
    )
    assert c.api_calls[-1]["body"]["requests"][0]["imageModelName"] == "GEM_PIX_2"

    # Default image_model (no kwarg) → Pro.
    await sdk.gen_image(prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE")
    assert c.api_calls[-1]["body"]["requests"][0]["imageModelName"] == "GEM_PIX_2"


def test_resolve_image_model_helper_accepts_known_keys_only():
    from flowboard.services.flow_sdk import resolve_image_model

    assert resolve_image_model("NANO_BANANA_PRO") == "GEM_PIX_2"
    assert resolve_image_model("NANO_BANANA_2") == "NARWHAL"
    # Anything else falls back to Pro — defense-in-depth.
    assert resolve_image_model("UNKNOWN") == "GEM_PIX_2"
    assert resolve_image_model("") == "GEM_PIX_2"
    assert resolve_image_model(None) == "GEM_PIX_2"


def test_client_context_rejects_invalid_paygate_tier():
    """Defense-in-depth — a stale frontend or buggy caller passing a
    garbage tier MUST NOT silently coerce to TIER_ONE (the pre-v1.1.5
    behaviour, which was the silent-Pro-downgrade footgun). Now the
    chokepoint raises ValueError so a code regression fails loud
    instead of serving Ultra users at the Pro checkpoint.
    """
    import pytest as _pytest

    from flowboard.services.flow_sdk import _client_context

    # Known good values pass through unchanged.
    one = _client_context("p", "PAYGATE_TIER_ONE")
    assert one["userPaygateTier"] == "PAYGATE_TIER_ONE"
    two = _client_context("p", "PAYGATE_TIER_TWO")
    assert two["userPaygateTier"] == "PAYGATE_TIER_TWO"

    # Unknown / malformed values raise loudly (not silent coerce).
    for bad in ("PAYGATE_TIER_THREE", "", "<script>", "PAYGATE_TIER_FREE"):
        with _pytest.raises(ValueError, match="invalid paygate_tier"):
            _client_context("p", bad)


def test_resolve_video_model_routes_by_tier_quality_aspect():
    """Video model resolver layers fallback: unknown quality → fast,
    unknown tier → TIER_ONE, unknown aspect → None. So a stale
    frontend can still dispatch *something* instead of silently
    swallowing the request."""
    from flowboard.services.flow_sdk import resolve_video_model

    # Tier 1 fast + landscape
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast"
    ) == "veo_3_1_i2v_s_fast"
    # Tier 1 fast + portrait → separate model
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "fast"
    ) == "veo_3_1_i2v_s_fast_portrait"
    # Tier 2 fast — distinct landscape and portrait models. Both keys
    # verified against real Flow web request bodies (curl exports from
    # labs.google Network tab); never speculate suffixes here. Regression
    # guard for the bug where Tier 2 Portrait Fast was incorrectly mapped
    # to a landscape-only `_ultra_relaxed` model that ignored aspectRatio
    # and forced 1280×720 output even when 9:16 was requested.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast"
    ) == "veo_3_1_i2v_s_fast_ultra"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "fast"
    ) == "veo_3_1_i2v_s_fast_portrait_ultra"

    # Lite is a Tier 2 (Ultra) exclusive — multi-aspect, same key for
    # landscape and portrait.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite"
    ) == "veo_3_1_t2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite"
    ) == "veo_3_1_t2v_lite"

    # Tier 1 has no Lite checkpoint — a stale frontend that asks for Lite
    # at Tier 1 must fall back to Tier 1 Fast rather than crash or silently
    # dispatch a Tier 2-only model the user is not paygated for.
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite"
    ) == "veo_3_1_i2v_s_fast"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite"
    ) == "veo_3_1_i2v_s_fast_portrait"

    # Tier 2 Quality — third quality tier (xịn hơn Fast, slower). Portrait
    # key verified from a real labs.google curl; landscape key follows the
    # same drop-`_portrait` naming convention used everywhere else.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "quality"
    ) == "veo_3_1_i2v_s"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "quality"
    ) == "veo_3_1_i2v_s_portrait"

    # Tier 1 has no Quality checkpoint either — same fallback story as Lite.
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "quality"
    ) == "veo_3_1_i2v_s_fast"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "quality"
    ) == "veo_3_1_i2v_s_fast_portrait"

    # Default quality (None / empty) → fast.
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", None
    ) == "veo_3_1_i2v_s_fast"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", ""
    ) == "veo_3_1_i2v_s_fast"

    # Unknown quality → falls back to fast within the tier.
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "ultra"
    ) == "veo_3_1_i2v_s_fast"

    # Unknown tier → falls back to TIER_ONE.
    assert resolve_video_model(
        "PAYGATE_TIER_BOGUS", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast"
    ) == "veo_3_1_i2v_s_fast"

    # Unknown aspect → None (caller surfaces a clear error).
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "BOGUS_ASPECT", "fast"
    ) is None


@pytest.mark.asyncio
async def test_gen_image_empty_media_when_flow_returns_no_media():
    c = RecordingClient()
    c.api_response = {"status": 200, "data": {"other": "shape"}}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_image(prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE")
    assert out["media_ids"] == []


@pytest.mark.asyncio
async def test_gen_image_propagates_extension_error():
    c = RecordingClient()
    c.api_response = {"error": "CAPTCHA_FAILED: no tab"}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_image(prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE")
    assert out["error"] == "CAPTCHA_FAILED: no tab"


def test_extract_project_id_returns_none_on_unexpected_shape():
    assert _extract_project_id({}) is None
    assert _extract_project_id({"data": {"result": "oops"}}) is None
    assert _extract_project_id(None) is None


def test_extract_media_ids_filters_non_dicts():
    assert _extract_media_ids({"data": {"media": [{"name": "a"}, "junk"]}}) == ["a"]
    assert _extract_media_ids({"data": {}}) == []
    assert _extract_media_ids("not a dict") == []


def test_extract_media_entries_pulls_fife_url():
    resp = {
        "data": {
            "media": [
                {
                    "name": "abc123",
                    "image": {
                        "generatedImage": {
                            "fifeUrl": "https://flow-content.google/image/abc123?sig=z",
                        }
                    },
                },
                {"name": "no-url"},
            ],
        },
    }
    entries = extract_media_entries(resp)
    assert len(entries) == 2
    assert entries[0]["media_id"] == "abc123"
    assert entries[0]["url"] == "https://flow-content.google/image/abc123?sig=z"
    assert entries[0]["mediaType"] == "image"
    assert entries[1]["url"] is None


@pytest.mark.asyncio
async def test_gen_image_returns_media_entries_with_urls():
    c = RecordingClient()
    c.api_response = _make_gen_image_response(["m1", "m2"], with_urls=True)
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_image(prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE")
    assert out["media_ids"] == ["m1", "m2"]
    assert len(out["media_entries"]) == 2
    assert out["media_entries"][0]["url"].startswith("https://flow-content.google/")


# ── Video gen ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gen_video_body_shape_and_captcha():
    c = RecordingClient()
    c.api_response = {
        "status": 200,
        "data": {
            "operations": [
                {"operation": {"name": "projects/p/operations/op-xyz"}},
            ]
        },
    }
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="wave in the wind",
        project_id="proj-1",
        start_media_id="img-abc",
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["operation_names"] == ["projects/p/operations/op-xyz"]

    call = c.api_calls[0]
    assert call["captcha_action"] == "VIDEO_GENERATION"
    assert call["url"].endswith("/v1/video:batchAsyncGenerateVideoStartImage")
    body = call["body"]
    req0 = body["requests"][0]
    assert req0["startImage"]["mediaId"] == "img-abc"
    assert req0["aspectRatio"] == "VIDEO_ASPECT_RATIO_LANDSCAPE"
    assert req0["videoModelKey"] == "veo_3_1_i2v_s_fast"
    assert req0["textInput"]["structuredPrompt"]["parts"][0]["text"] == "wave in the wind"
    assert body["useV2ModelConfig"] is True


@pytest.mark.asyncio
async def test_gen_video_batch_with_multiple_start_media_ids():
    """When the upstream image has N variants, gen_video must dispatch
    one request_item per source so the batch produces N videos in a
    single Flow call instead of generating only the first variant."""
    c = RecordingClient()
    c.api_response = {
        "status": 200,
        "data": {
            "operations": [
                {"operation": {"name": "op-1"}},
                {"operation": {"name": "op-2"}},
                {"operation": {"name": "op-3"}},
            ]
        },
    }
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="wave",
        project_id="proj-1",
        start_media_ids=["src-1", "src-2", "src-3"],
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["operation_names"] == ["op-1", "op-2", "op-3"]

    body = c.api_calls[0]["body"]
    items = body["requests"]
    assert len(items) == 3
    media_ids = [it["startImage"]["mediaId"] for it in items]
    assert media_ids == ["src-1", "src-2", "src-3"]
    # Distinct seeds so Flow doesn't dedupe
    seeds = [it["seed"] for it in items]
    assert len(set(seeds)) == 3


@pytest.mark.asyncio
async def test_gen_video_falls_back_to_single_start_media_id():
    """Single source still works through the legacy path."""
    c = RecordingClient()
    c.api_response = {
        "status": 200,
        "data": {"operations": [{"operation": {"name": "op-only"}}]},
    }
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="x", project_id="p", start_media_id="solo-id",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["operation_names"] == ["op-only"]
    items = c.api_calls[0]["body"]["requests"]
    assert len(items) == 1
    assert items[0]["startImage"]["mediaId"] == "solo-id"


@pytest.mark.asyncio
async def test_gen_video_returns_error_when_no_source_provided():
    c = RecordingClient()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(prompt="x", project_id="p", paygate_tier="PAYGATE_TIER_ONE")
    assert out.get("error") == "missing_start_media_id"


@pytest.mark.asyncio
async def test_gen_video_rejects_unknown_tier_aspect_combo():
    c = RecordingClient()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="x",
        project_id="p",
        start_media_id="m",
        aspect_ratio="VIDEO_ASPECT_RATIO_WEIRD",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["error"].startswith("no_video_model_for_tier")
    # No HTTP call attempted.
    assert len(c.api_calls) == 0


@pytest.mark.asyncio
async def test_gen_video_returns_error_on_no_operations():
    c = RecordingClient()
    c.api_response = {"status": 200, "data": {"operations": []}}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="x", project_id="p", start_media_id="m",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["error"] == "no_operations_in_response"


@pytest.mark.asyncio
async def test_check_async_marks_done_when_video_meta_has_url():
    c = RecordingClient()
    c.api_response = {
        "status": 200,
        "data": {
            "operations": [
                {
                    "operation": {
                        "name": "op-1",
                        "done": True,
                        "metadata": {
                            "video": {
                                "mediaId": "vid-1",
                                "fifeUrl": "https://flow-content.google/video/vid-1?sig=x",
                            }
                        },
                    }
                },
                {
                    "operation": {
                        "name": "op-2",
                        "metadata": {},  # still pending
                    }
                },
            ]
        },
    }
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.check_async(["op-1", "op-2"])
    ops = out["operations"]
    assert len(ops) == 2
    assert ops[0]["done"] is True
    assert ops[0]["media_entries"][0]["media_id"] == "vid-1"
    assert ops[0]["media_entries"][0]["url"].startswith("https://flow-content.google/")
    assert ops[1]["done"] is False
    assert ops[1]["media_entries"] == []

    # No captcha for poll
    call = c.api_calls[0]
    assert "captcha_action" not in call or call["captcha_action"] is None
    assert call["url"].endswith("/v1/video:batchCheckAsyncVideoGenerationStatus")


def test_extract_operation_names_tolerates_missing_inner():
    resp = {"data": {"operations": [{"name": "top-level-name"}, {"operation": {"name": "inner"}}]}}
    assert extract_operation_names(resp) == ["top-level-name", "inner"]


def test_extract_video_operations_handles_missing_and_out_of_order():
    resp = {
        "data": {
            "operations": [
                {"operation": {"name": "b", "done": True, "metadata": {"video": {"mediaId": "mb", "fifeUrl": "https://flow-content.google/video/mb?x"}}}},
            ]
        }
    }
    out = extract_video_operations(resp, requested=["a", "b"])
    assert out[0]["name"] == "a"
    assert out[0]["done"] is False
    assert out[1]["name"] == "b"
    assert out[1]["done"] is True


def test_extract_video_operations_recovers_uuid_from_fife_url():
    """Flow's video poll response omits ``metadata.video.mediaId`` — it only
    has ``mediaGenerationId`` (base64 protobuf, NOT UUID). The real UUID is
    embedded in ``fifeUrl`` as ``/video/<UUID>?...``. Without URL recovery
    we'd return media_entries=[] for a perfectly-finished video."""
    resp = {
        "data": {
            "operations": [
                {
                    "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                    "operation": {
                        "name": "op-1",
                        "metadata": {
                            "video": {
                                "mediaGenerationId": "CAUS-base64-not-a-uuid",
                                "fifeUrl": "https://flow-content.google/video/f0b6561a-73f2-4360-96aa-35e071aac9ce?Expires=1&Signature=x",
                            }
                        },
                    },
                },
            ]
        }
    }
    out = extract_video_operations(resp, requested=["op-1"])
    assert out[0]["done"] is True
    assert out[0]["media_entries"] == [
        {
            "media_id": "f0b6561a-73f2-4360-96aa-35e071aac9ce",
            "url": "https://flow-content.google/video/f0b6561a-73f2-4360-96aa-35e071aac9ce?Expires=1&Signature=x",
            "mediaType": "video",
        }
    ]


def test_extract_video_operations_surfaces_per_op_failure():
    """A real Flow rejection mid-poll: status FAILED at the envelope, plus
    ``operation.error.message: PUBLIC_ERROR_AUDIO_FILTERED`` on the inner
    object. Old code only checked SUCCESSFUL → spent the full 7-min timeout
    polling a doomed op. Worker now treats `error` as terminal."""
    resp = {
        "data": {
            "operations": [
                {
                    "status": "MEDIA_GENERATION_STATUS_FAILED",
                    "operation": {
                        "name": "vid-bad",
                        "error": {"code": 3, "message": "PUBLIC_ERROR_AUDIO_FILTERED"},
                    },
                },
            ]
        }
    }
    out = extract_video_operations(resp, requested=["vid-bad"])
    assert out[0]["done"] is True
    assert out[0]["error"] == "PUBLIC_ERROR_AUDIO_FILTERED"
    # No media_entries should be attached when the op itself errored.
    assert out[0]["media_entries"] == []


def test_extract_video_operations_recognizes_status_successful_envelope():
    """Flow returns operation status at the *outer* envelope level
    (op["status"]), not on the inner operation. Older code only checked
    inner.done and missed legitimately-completed videos."""
    resp = {
        "data": {
            "operations": [
                {
                    "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                    "operation": {
                        "name": "vid-ok",
                        "metadata": {"video": {"mediaId": "abc-123", "fifeUrl": "https://flow-content.google/video/abc?sig"}},
                    },
                },
                {
                    "status": "MEDIA_GENERATION_STATUS_PENDING",
                    "operation": {"name": "vid-pending"},
                },
            ]
        }
    }
    out = extract_video_operations(resp, requested=["vid-ok", "vid-pending"])
    assert out[0]["done"] is True
    assert out[0]["media_entries"] == [
        {"media_id": "abc-123", "url": "https://flow-content.google/video/abc?sig", "mediaType": "video"}
    ]
    assert out[1]["done"] is False
    assert out[1]["media_entries"] == []


def test_extract_inner_api_error_returns_none_on_success():
    assert _extract_inner_api_error({"status": 200, "data": {"media": []}}) is None
    assert _extract_inner_api_error({"data": {"operations": [{"x": 1}]}}) is None
    assert _extract_inner_api_error("not a dict") is None


def test_extract_inner_api_error_surfaces_prominent_people_filter():
    """Real Flow rejection: status 400 + INVALID_ARGUMENT with the content
    filter reason. Worker must see this so it doesn't mark the request done
    with media_ids=[]."""
    resp = {
        "id": "abc",
        "status": 400,
        "data": {
            "error": {
                "code": 400,
                "message": "Request contains an invalid argument.",
                "status": "INVALID_ARGUMENT",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        "reason": "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED",
                    }
                ],
            }
        },
    }
    err = _extract_inner_api_error(resp)
    assert err is not None
    assert "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED" in err
    assert "invalid argument" in err.lower()


def test_extract_inner_api_error_handles_status_only():
    """status >= 400 with no structured error body → still report failure."""
    err = _extract_inner_api_error({"status": 503, "data": {}})
    assert err == "API_503"


@pytest.mark.asyncio
async def test_gen_image_propagates_prominent_people_filter():
    """Without the inner-error check, gen_image returned ``media_ids: []``
    on a content-filter rejection — worker then marked it `done` instead of
    `failed`. Verify the SDK surfaces an `error` key for the worker."""
    client = RecordingClient()
    client.api_response = {
        "id": "x",
        "status": 400,
        "data": {
            "error": {
                "status": "INVALID_ARGUMENT",
                "message": "Request contains an invalid argument.",
                "details": [
                    {"reason": "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED"}
                ],
            }
        },
    }
    sdk = FlowSDK(client)
    out = await sdk.gen_image(
        prompt="x", project_id="abcd1234", aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert "error" in out
    assert "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED" in out["error"]
    assert "media_ids" not in out
