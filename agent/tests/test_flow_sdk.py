"""Tests for the Flow SDK on Flow's batchexecute transport.

The SDK's entire observable output is the ``f.req`` envelope it hands to
``flow_client.batch_rpc``, so these tests decode that envelope and assert on
the positional slots. That matters more than it sounds: Flow accepts a
well-formed request with a value in the wrong slot without complaining, and
then ignores it. Several tests below exist because a wrong slot looked like it
was working.

Response fixtures come from ``tests.batch_harness``, which also names the slot
indices so the magic numbers live in one place.
"""
import pytest

from flowboard.services import flow_batch as fb
from flowboard.services.flow_sdk import (
    DEFAULT_PAYGATE_TIER,
    FlowSDK,
    _extract_media_ids,
    extract_media_entries,
    extract_operation_names,
    extract_video_operations,
    resolve_paygate_tier,
)
from tests.batch_harness import (
    IMG_ASPECT,
    IMG_INPUTS,
    IMG_MODEL,
    IMG_SEED,
    INPUT_TYPE,
    OMNI_MODEL,
    OMNI_REFS,
    SRC_MEDIA_ID,
    VID_ASPECT,
    VID_MODEL,
    VID_SOURCE,
    BatchRecorder,
    batch_envelope,
    batch_error_envelope,
    complaint_detail,
    image_items,
    image_recorder,
    listing_payload_text,
    media_urls_payload,
    operation_payload,
    video_item,
)

TIER = "PAYGATE_TIER_ONE"
PID = "8b62385c-4916-4abd-b01f-b28173d8eb04"
MEDIA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _context_of(payload_context) -> tuple:
    """(project_id, captcha_slot) out of the shared generate context block."""
    return payload_context[5], payload_context[10][0]


# ── the tier resolver ─────────────────────────────────────────────────────


def test_resolve_paygate_tier_accepts_the_two_real_plans():
    assert resolve_paygate_tier("PAYGATE_TIER_ONE") == "PAYGATE_TIER_ONE"
    assert resolve_paygate_tier("PAYGATE_TIER_TWO") == "PAYGATE_TIER_TWO"


def test_resolve_paygate_tier_falls_back_to_config_when_unset():
    assert resolve_paygate_tier(None) == DEFAULT_PAYGATE_TIER
    assert resolve_paygate_tier("") == DEFAULT_PAYGATE_TIER


@pytest.mark.parametrize("bad", ["PAYGATE_TIER_ONE ", "tier_one", "FREE", "1"])
def test_resolve_paygate_tier_refuses_anything_else(bad):
    """Guards the silent-downgrade bug in its new form.

    The tier is declared rather than sniffed now, so the failure mode moved
    from "absent" to "wrong" — and a wrong one still picks a video
    checkpoint, so it must raise rather than resolve.
    """
    with pytest.raises(ValueError, match="paygate_tier_invalid"):
        resolve_paygate_tier(bad)


# ── project creation and listing, both unported ───────────────────────────


@pytest.mark.asyncio
async def test_create_project_refuses_when_no_project_is_pinned(monkeypatch):
    from flowboard.services import flow_sdk

    monkeypatch.setattr(flow_sdk, "FLOW_PROJECT_ID", "")
    out = await FlowSDK(client=BatchRecorder()).create_project("Board")
    assert out["error"].startswith("NO_FLOW_PROJECT")
    assert "FLOWBOARD_FLOW_PROJECT_ID" in out["error"]


@pytest.mark.asyncio
async def test_create_project_hands_back_the_pinned_project_marked_reused(monkeypatch):
    """It must not claim to have created something. Boards share one project."""
    from flowboard.services import flow_sdk

    monkeypatch.setattr(flow_sdk, "FLOW_PROJECT_ID", PID)
    out = await FlowSDK(client=BatchRecorder()).create_project("Board")
    assert out["project_id"] == PID
    assert out["reused"] is True
    assert "error" not in out


@pytest.mark.asyncio
async def test_project_listing_reports_unsupported_rather_than_empty():
    """An empty list would read as "this user has no projects"."""
    sdk = FlowSDK(client=BatchRecorder())
    page = await sdk.search_user_projects()
    assert page["projects"] == []
    assert page["error"].startswith("UNSUPPORTED_ON_BATCH_API")

    everything = await sdk.list_user_projects_all()
    assert everything["projects"] == []
    assert everything["error"].startswith("UNSUPPORTED_ON_BATCH_API")


# ── image generation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gen_image_envelope_carries_project_captcha_and_prompt():
    rec = image_recorder(1)
    out = await FlowSDK(client=rec).gen_image(
        prompt="a sleeping cat", project_id=PID, paygate_tier=TIER,
    )
    assert out["media_ids"] == ["img-0"]

    call = rec.rpcs(fb.RPC_GEN_IMAGE)[0]
    assert call["captcha_action"] == fb.CAPTCHA_IMAGE == "IMAGE_GENERATION"

    payload = rec.payload(fb.RPC_GEN_IMAGE)
    project_id, captcha = _context_of(payload[3])
    assert project_id == PID
    # A placeholder, not a token: the mint has to happen in the page moments
    # before the request leaves, because the token is single-use.
    assert captcha == fb.CAPTCHA_SLOT == "__CAPTCHA__"

    item = image_items(payload)[0]
    assert item[8][0][0][0] == "a sleeping cat"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "nickname,wire",
    [
        ("NANO_BANANA_PRO", "GEM_PIX_2"),
        ("NANO_BANANA_2", "NARWHAL"),
        (None, "GEM_PIX_2"),
    ],
)
async def test_gen_image_resolves_this_projects_model_policy(nickname, wire):
    """Flowboard's model map decides, not flow_batch's default.

    flow_batch is kept byte-identical to flowkit's copy and its own default
    model differs, so the nickname has to be resolved here and passed in
    explicitly. If that ever regresses, generation silently switches model.
    """
    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER, image_model=nickname,
    )
    assert image_items(rec.payload(fb.RPC_GEN_IMAGE))[0][IMG_MODEL] == wire


@pytest.mark.asyncio
async def test_gen_image_reference_images_land_in_the_inputs_slot():
    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
        ref_media_ids=["ref-1", "ref-2"],
    )
    inputs = image_items(rec.payload(fb.RPC_GEN_IMAGE))[0][IMG_INPUTS]
    assert [i[0] for i in inputs] == ["ref-1", "ref-2"]
    assert all(i[INPUT_TYPE] == fb.REF_TYPE_IMAGE for i in inputs)


@pytest.mark.asyncio
async def test_gen_image_accepts_the_legacy_character_media_ids_kwarg():
    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
        character_media_ids=["char-1"],
    )
    inputs = image_items(rec.payload(fb.RPC_GEN_IMAGE))[0][IMG_INPUTS]
    assert [i[0] for i in inputs] == ["char-1"]


@pytest.mark.asyncio
async def test_gen_image_per_variant_prompts_reach_their_own_rpc():
    rec = image_recorder(3)
    await FlowSDK(client=rec).gen_image(
        prompt="fallback", project_id=PID, paygate_tier=TIER, variant_count=3,
        prompts=["first", "", None],
    )
    texts = [
        image_items(rec.payload(fb.RPC_GEN_IMAGE, i))[0][8][0][0][0]
        for i in range(3)
    ]
    # Blank and missing entries fall back to the shared prompt.
    assert texts == ["first", "fallback", "fallback"]


@pytest.mark.asyncio
async def test_gen_image_keeps_the_variants_that_rendered():
    """Three good images must not be thrown away because the fourth failed."""
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [
            batch_envelope(fb.RPC_GEN_IMAGE,
                           [["https://flow-content.google/image/ok-1?s=x"]]),
            batch_error_envelope(fb.RPC_GEN_IMAGE),
            batch_envelope(fb.RPC_GEN_IMAGE,
                           [["https://flow-content.google/image/ok-3?s=x"]]),
        ],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER, variant_count=3,
    )
    assert out.get("error") is None
    assert sorted(out["media_ids"]) == ["ok-1", "ok-3"]
    assert out["raw"]["data"]["failed_variants"][0]["index"] == 2


@pytest.mark.asyncio
async def test_gen_image_reports_an_error_when_every_variant_fails():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [batch_error_envelope(fb.RPC_GEN_IMAGE)],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
    )
    assert out["error"]
    assert "media_ids" not in out


@pytest.mark.asyncio
async def test_gen_image_propagates_a_bridge_level_error():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [{"error": "CAPTCHA_FAILED: NO_FLOW_TAB"}],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
    )
    assert "NO_FLOW_TAB" in out["error"]


@pytest.mark.asyncio
async def test_gen_image_errors_when_the_response_has_no_media_url():
    """A 200 with nothing usable in it is a failure, not an empty success.

    Reporting it as success is how a content-filter rejection used to look
    like a generation that produced zero images.
    """
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [batch_envelope(fb.RPC_GEN_IMAGE, [None, [], 1])],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
    )
    assert "no media url" in out["error"]


@pytest.mark.asyncio
async def test_gen_image_returns_entries_with_signed_urls():
    rec = image_recorder(2)
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER, variant_count=2,
    )
    assert len(out["media_entries"]) == 2
    for entry in out["media_entries"]:
        assert entry["mediaType"] == "image"
        assert entry["url"].startswith("https://flow-content.google/image/")
        assert entry["media_id"] in entry["url"]


@pytest.mark.asyncio
async def test_gen_image_without_a_project_says_so():
    from flowboard.services import flow_sdk

    monkey = BatchRecorder()
    original = flow_sdk.FLOW_PROJECT_ID
    flow_sdk.FLOW_PROJECT_ID = ""
    try:
        out = await FlowSDK(client=monkey).gen_image(
            prompt="x", project_id="", paygate_tier=TIER,
        )
    finally:
        flow_sdk.FLOW_PROJECT_ID = original
    assert out["error"].startswith("NO_FLOW_PROJECT")
    assert monkey.calls == [], "must not reach the bridge without a project"


# ── video: Veo i2v ────────────────────────────────────────────────────────


def _video_recorder(op_ids):
    return BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload(op))
            for op in op_ids
        ],
    })


@pytest.mark.asyncio
async def test_gen_video_envelope_and_captcha():
    rec = _video_recorder(["op-1"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="wave in the wind", project_id=PID, start_media_id="img-abc",
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE", paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1"]

    call = rec.rpcs(fb.RPC_GEN_VIDEO)[0]
    assert call["captcha_action"] == fb.CAPTCHA_VIDEO == "VIDEO_GENERATION"

    item = video_item(rec.payload(fb.RPC_GEN_VIDEO))
    assert item[0][2][0][0][0] == "wave in the wind"
    assert item[VID_SOURCE][SRC_MEDIA_ID] == "img-abc"


@pytest.mark.asyncio
async def test_video_aspect_uses_its_own_encoding_not_the_image_one():
    """Trap worth a dedicated test: the two encodings disagree.

    For an image 1 is square, 2 portrait, 3 landscape. For a video 1 is
    PORTRAIT and 2 is landscape. Conflating them renders the wrong shape and
    Flow reports nothing wrong.
    """
    rec = _video_recorder(["op-p", "op-l"])
    sdk = FlowSDK(client=rec)

    await sdk.gen_video(
        prompt="x", project_id=PID, start_media_id="m", paygate_tier=TIER,
        aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
    )
    await sdk.gen_video(
        prompt="x", project_id=PID, start_media_id="m", paygate_tier=TIER,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
    )
    portrait = video_item(rec.payload(fb.RPC_GEN_VIDEO, 0))[VID_ASPECT]
    landscape = video_item(rec.payload(fb.RPC_GEN_VIDEO, 1))[VID_ASPECT]
    assert (portrait, landscape) == (1, 2)

    # And here is why conflating them is silent rather than loud: the numbers
    # collide. A video portrait (1) is a valid image SQUARE, and a video
    # landscape (2) is a valid image PORTRAIT — so the wrong encoding is never
    # rejected, it just renders the wrong shape.
    assert fb.VIDEO_ASPECT_PORTRAIT == fb.ASPECT_SQUARE == 1
    assert fb.VIDEO_ASPECT_LANDSCAPE == fb.ASPECT_PORTRAIT == 2
    assert fb.ASPECT_LANDSCAPE == 3, "3 is a valid image aspect and a meaningless video one"
    with pytest.raises(ValueError, match="video aspect must be 1 or 2"):
        fb.resolve_video_aspect(fb.ASPECT_LANDSCAPE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tier,quality,expected",
    [
        ("PAYGATE_TIER_TWO", "fast", "veo_3_1_i2v_s_fast_ultra"),
        ("PAYGATE_TIER_TWO", "lite", "veo_3_1_i2v_lite"),
        ("PAYGATE_TIER_ONE", "lite", "veo_3_1_i2v_lite"),
    ],
)
async def test_gen_video_maps_tier_and_quality_onto_a_batch_model(tier, quality, expected):
    """The suffixed REST names are rejected; only the intent survives."""
    rec = _video_recorder(["op-1"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_id="m",
        paygate_tier=tier, video_quality=quality,
    )
    assert out["model"] == expected
    assert video_item(rec.payload(fb.RPC_GEN_VIDEO))[VID_MODEL] == expected
    assert expected in fb.VIDEO_MODELS


@pytest.mark.asyncio
async def test_gen_video_batch_dispatches_one_operation_per_source():
    rec = _video_recorder(["op-1", "op-2", "op-3"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="wave", project_id=PID,
        start_media_ids=["src-1", "src-2", "src-3"], paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1", "op-2", "op-3"]
    sources = [
        video_item(rec.payload(fb.RPC_GEN_VIDEO, i))[VID_SOURCE][SRC_MEDIA_ID]
        for i in range(3)
    ]
    assert sources == ["src-1", "src-2", "src-3"]


@pytest.mark.asyncio
async def test_gen_video_batch_keeps_the_sources_that_submitted():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload("op-1")),
            batch_error_envelope(fb.RPC_GEN_VIDEO),
        ],
    })
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_ids=["src-1", "src-2"],
        paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1"]
    assert out["raw"]["data"]["failed_sources"][0]["media_id"] == "src-2"


@pytest.mark.asyncio
async def test_gen_video_falls_back_to_the_single_source_kwarg():
    rec = _video_recorder(["op-1"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_id="only-1",
        start_media_ids=[], paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1"]
    item = video_item(rec.payload(fb.RPC_GEN_VIDEO))
    assert item[VID_SOURCE][SRC_MEDIA_ID] == "only-1"


@pytest.mark.asyncio
async def test_gen_video_errors_when_the_submit_yields_no_operation():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [batch_envelope(fb.RPC_GEN_VIDEO, [None, 50, []])],
    })
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_id="m", paygate_tier=TIER,
    )
    assert out["error"]
    assert "operation_names" not in out


# ── video: Omni Flash reference-to-video ──────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("duration,model", [
    (4, "abra_r2v_4s"), (6, "abra_r2v_6s"),
    (8, "abra_r2v_8s"), (10, "abra_r2v_10s"),
])
async def test_gen_video_omni_model_key_carries_the_duration(duration, model):
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("omni-1")),
        ],
    })
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1"],
        duration_s=duration, paygate_tier=TIER,
    )
    assert out["operation_names"] == ["omni-1"]
    assert out["model"] == model
    assert out["duration_s"] == duration
    assert out["resolution"] == "720p"
    assert video_item(rec.payload(fb.RPC_GEN_VIDEO_REFERENCES))[OMNI_MODEL] == model


@pytest.mark.asyncio
async def test_gen_video_omni_references_are_wrapped_pairwise():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("omni-1")),
        ],
    })
    await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1", "", None, "r-2"],
        duration_s=8, paygate_tier=TIER,
    )
    refs = video_item(rec.payload(fb.RPC_GEN_VIDEO_REFERENCES))[OMNI_REFS]
    assert refs == [[None, "r-1"], [None, "r-2"]]


@pytest.mark.asyncio
async def test_gen_video_omni_requires_a_reference():
    rec = BatchRecorder()
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=[], duration_s=8,
        paygate_tier=TIER,
    )
    assert out["error"] == "missing_ref_media_ids"
    assert rec.calls == []


@pytest.mark.asyncio
async def test_gen_video_omni_rejects_an_unsupported_duration():
    rec = BatchRecorder()
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1"], duration_s=5,
        paygate_tier=TIER,
    )
    assert "5" in out["error"]
    assert rec.calls == []


@pytest.mark.asyncio
async def test_gen_video_omni_rejects_a_square_aspect():
    rec = BatchRecorder()
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1"], duration_s=8,
        aspect_ratio="VIDEO_ASPECT_RATIO_SQUARE", paygate_tier=TIER,
    )
    assert out["error"] == "omni_aspect_unsupported_VIDEO_ASPECT_RATIO_SQUARE"
    assert rec.calls == []


def test_omni_duration_keys_agree_with_the_envelope_builder():
    """Two places derive the model key; drift between them must be caught.

    flow_sdk validates the duration against its own map, then flow_batch
    builds the key from the same duration. If the two ever disagree, the
    error message would name one model and the wire would carry another.
    """
    from flowboard.services.flow_sdk import OMNI_FLASH_DURATION_KEYS

    for duration, key in OMNI_FLASH_DURATION_KEYS.items():
        freq = fb.omni_reference_video_request(
            "p", PID, ["r-1"], duration_s=duration, resolution="720p",
        )
        import json
        built = json.loads(json.loads(freq)[0][0][1])[0][0][OMNI_MODEL]
        assert built == key, f"{duration}s: flow_batch says {built}, sdk says {key}"


# ── polling ───────────────────────────────────────────────────────────────


def _poll_recorder(op_id, *, status="CAE", detail=None,
                   media_id=MEDIA, video=True, listing=True):
    return BatchRecorder(responses={
        fb.RPC_OPERATION: [batch_envelope(
            fb.RPC_OPERATION,
            operation_payload(op_id, status=status, detail=detail),
        )],
        fb.RPC_PROJECT_MEDIA: [
            listing_payload_text(op_id, media_id) if listing else ""
        ],
        fb.RPC_MEDIA: [batch_envelope(
            fb.RPC_MEDIA, media_urls_payload(media_id, video=video),
        )],
    })


@pytest.mark.asyncio
async def test_check_async_succeeds_once_a_video_url_exists():
    rec = _poll_recorder("op-1")
    out = await FlowSDK(client=rec).check_async(["op-1"])

    (op,) = out["operations"]
    assert op["name"] == "op-1"
    assert op["done"] is True
    assert op["status"] == "MEDIA_GENERATION_STATUS_SUCCESSFUL"
    entry = op["media_entries"][0]
    assert entry["media_id"] == MEDIA
    assert "/video/" in entry["url"]


@pytest.mark.asyncio
async def test_check_async_asks_the_listing_for_a_window_not_the_whole_thing():
    """The listing is past 17 MB; shipping it whole gets it truncated."""
    rec = _poll_recorder("op-1")
    await FlowSDK(client=rec).check_async(["op-1"])
    listing_call = rec.rpcs(fb.RPC_PROJECT_MEDIA)[0]
    assert listing_call["match"] == "op-1"
    assert listing_call["captcha_action"] is None, "a poll must not burn a captcha"


@pytest.mark.asyncio
async def test_check_async_stays_pending_while_only_the_poster_exists():
    """A media id arrives before the clip is fetchable.

    The media record serves the poster image first and grows the /video/ url
    later, so finishing on the id alone downloads a still picture.
    """
    rec = _poll_recorder("op-1", video=False)
    out = await FlowSDK(client=rec).check_async(["op-1"])

    (op,) = out["operations"]
    assert op["done"] is False
    assert op["status"] == "MEDIA_GENERATION_STATUS_PENDING"
    assert op["media_entries"] == []


@pytest.mark.asyncio
async def test_check_async_treats_media_not_found_as_a_complaint_not_a_verdict():
    """Operations report this and still deliver a finished clip.

    Surfacing it as a terminal error is what killed live runs: the worker
    stops polling and the clip lands seconds later with nobody watching.
    """
    rec = _poll_recorder("op-1", detail=complaint_detail("Media not found."))
    out = await FlowSDK(client=rec).check_async(["op-1"])

    (op,) = out["operations"]
    assert op["done"] is True
    assert op["error"] is None, "a complaint must not become a terminal error"
    assert op["media_entries"][0]["media_id"] == MEDIA


@pytest.mark.asyncio
async def test_check_async_reports_pending_when_the_listing_has_no_media_yet():
    rec = _poll_recorder("op-1", listing=False)
    out = await FlowSDK(client=rec).check_async(["op-1"])
    (op,) = out["operations"]
    assert op["done"] is False
    assert rec.rpcs(fb.RPC_MEDIA) == [], "nothing to look up without a media id"


@pytest.mark.asyncio
async def test_check_async_survives_an_unreadable_operation_poll():
    """A decayed operation still appears in the listing, so keep looking."""
    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [batch_error_envelope(fb.RPC_OPERATION)],
        fb.RPC_PROJECT_MEDIA: [listing_payload_text("op-1", MEDIA)],
        fb.RPC_MEDIA: [batch_envelope(fb.RPC_MEDIA, media_urls_payload(MEDIA))],
    })
    sdk = FlowSDK(client=rec)
    # The listing lookup needs a project; a real submit would have noted one.
    sdk._remember_operation("op-1", PID)
    out = await sdk.check_async(["op-1"])
    assert out["operations"][0]["done"] is True


@pytest.mark.asyncio
async def test_check_async_preserves_the_requested_order_and_reports_gaps():
    """The worker keeps per-op state positionally aligned with this list."""
    rec = _poll_recorder("op-2")
    out = await FlowSDK(client=rec).check_async(["op-1", "op-2"])
    assert [op["name"] for op in out["operations"]] == ["op-1", "op-2"]
    # op-1 was never polled successfully, so it must read as still running.
    assert out["operations"][0]["done"] is False


@pytest.mark.asyncio
async def test_check_async_does_not_repoll_a_resolved_media_id():
    rec = _poll_recorder("op-1")
    sdk = FlowSDK(client=rec)
    await sdk.check_async(["op-1"])
    # Second round: the operation and listing scripts are exhausted, so if the
    # media id were not cached this would raise from the recorder.
    rec.responses[fb.RPC_MEDIA] = [
        batch_envelope(fb.RPC_MEDIA, media_urls_payload(MEDIA))
    ]
    out = await sdk.check_async(["op-1"])
    assert out["operations"][0]["done"] is True
    assert len(rec.rpcs(fb.RPC_OPERATION)) == 1


@pytest.mark.asyncio
async def test_check_async_ignores_pre_migration_workflow_handles():
    """They cannot be resumed; they must not be polled as operations either."""
    rec = _poll_recorder("op-1")
    out = await FlowSDK(client=rec).check_async(
        ["op-1"], workflows=[{"name": "wf-1", "primary_media_id": "m-1"}],
    )
    assert [op["name"] for op in out["operations"]] == ["op-1"]
    assert rec.rpcs(fb.RPC_MEDIA), "the real operation still resolved"


# ── upload ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_image_carries_a_captcha_and_returns_the_media_id():
    """Unlike the REST upload, maseQ is gated like a generate is.

    So an upload failing with CAPTCHA_FAILED is a Flow-tab problem, not a
    rejected image — worth asserting, because the two need opposite fixes.
    """
    rec = BatchRecorder(responses={
        fb.RPC_UPLOAD_IMAGE: [
            batch_envelope(fb.RPC_UPLOAD_IMAGE, [[MEDIA, PID, "op-x", "CAE"]]),
        ],
    })
    out = await FlowSDK(client=rec).upload_image(
        image_base64="Zm9v", mime_type="image/png", project_id=PID,
        file_name="hero.png",
    )
    assert out["media_id"] == MEDIA
    assert out["raw"]["data"]["media"]["name"] == MEDIA

    call = rec.rpcs(fb.RPC_UPLOAD_IMAGE)[0]
    assert call["captcha_action"] == fb.CAPTCHA_IMAGE
    payload = rec.payload(fb.RPC_UPLOAD_IMAGE)
    assert payload[1] == "Zm9v"        # bare base64, no data: prefix
    assert payload[2] == "image/png"
    assert payload[8] == "hero.png"
    assert _context_of(payload[0])[0] == PID


@pytest.mark.asyncio
async def test_upload_image_errors_when_no_media_handle_comes_back():
    rec = BatchRecorder(responses={
        fb.RPC_UPLOAD_IMAGE: [batch_envelope(fb.RPC_UPLOAD_IMAGE, [[]])],
    })
    out = await FlowSDK(client=rec).upload_image(
        image_base64="Zm9v", mime_type="image/png", project_id=PID,
    )
    assert "no media id" in out["error"]
    assert "media_id" not in out


# ── pure helpers, unchanged by the migration ──────────────────────────────


def test_resolve_image_model_helper_accepts_known_keys_only():
    from flowboard.services.flow_sdk import resolve_image_model

    assert resolve_image_model("NANO_BANANA_PRO") == "GEM_PIX_2"
    assert resolve_image_model("NANO_BANANA_2") == "NARWHAL"
    # Anything else falls back to Pro — defense-in-depth.
    assert resolve_image_model("UNKNOWN") == "GEM_PIX_2"
    assert resolve_image_model("") == "GEM_PIX_2"
    assert resolve_image_model(None) == "GEM_PIX_2"

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

    # Lite — multi-aspect, same key for landscape and portrait. Both
    # tiers share the `veo_3_1_i2v_lite` checkpoint (verified from PRO
    # PLAN curl in video_model.md AND ULTRA PLAN curl in
    # video_model_ultra.md); the per-tier difference is `userPaygateTier`
    # in clientContext, not the model key.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite"
    ) == "veo_3_1_i2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite"
    ) == "veo_3_1_i2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite"
    ) == "veo_3_1_i2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite"
    ) == "veo_3_1_i2v_lite"

    # Quality — third quality tier (xịn hơn Fast, slower). Both tiers
    # share the `veo_3_1_i2v_s*` family; the difference is the
    # `userPaygateTier` in clientContext, not the model key. Landscape
    # key verified from PRO PLAN curl in video_model.md; portrait key
    # verified from an Ultra labs.google curl and reused for Pro.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "quality"
    ) == "veo_3_1_i2v_s"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "quality"
    ) == "veo_3_1_i2v_s_portrait"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "quality"
    ) == "veo_3_1_i2v_s"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "quality"
    ) == "veo_3_1_i2v_s_portrait"

    # Lite Relaxed — Ultra-only 0-credit low-priority queue. Verified
    # LANDSCAPE key from ULTRA PLAN curl in video_model_ultra.md;
    # portrait reuses the same key (multi-aspect, same as plain lite).
    # Tier 1 has no `lite_relaxed` mapping → falls back to Tier 1 fast.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite_relaxed"
    ) == "veo_3_1_i2v_lite_low_priority"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite_relaxed"
    ) == "veo_3_1_i2v_lite_low_priority"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite_relaxed"
    ) == "veo_3_1_i2v_s_fast"

    # Fast Relaxed — Ultra-only 0-credit low-priority queue. Verified
    # LANDSCAPE key from ULTRA PLAN curl in video_model_ultra.md;
    # portrait reuses the LANDSCAPE key as best-effort fallback (no
    # portrait curl observed yet). Tier 1 has no `fast_relaxed` mapping
    # → falls back to Tier 1 fast.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast_relaxed"
    ) == "veo_3_1_i2v_s_fast_ultra_relaxed"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "fast_relaxed"
    ) == "veo_3_1_i2v_s_fast_ultra_relaxed"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast_relaxed"
    ) == "veo_3_1_i2v_s_fast"

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

@pytest.mark.asyncio
async def test_gen_video_returns_error_when_no_source_provided():
    c = BatchRecorder()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(prompt="x", project_id=PID, paygate_tier="PAYGATE_TIER_ONE")
    assert out.get("error") == "missing_start_media_id"

@pytest.mark.asyncio
async def test_gen_video_rejects_unknown_tier_aspect_combo():
    c = BatchRecorder()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="x",
        project_id=PID,
        start_media_id="m",
        aspect_ratio="VIDEO_ASPECT_RATIO_WEIRD",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["error"].startswith("no_video_model_for_tier")
    # No HTTP call attempted.
    assert c.calls == []
