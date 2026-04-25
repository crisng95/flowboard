"""Tests for the minimal Flow SDK. Uses a recording fake FlowClient so we can
assert on the JSON-RPC shape without touching a real WS.
"""
from typing import Any

import pytest

from flowboard.services.flow_sdk import (
    FlowSDK,
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
async def test_gen_image_empty_media_when_flow_returns_no_media():
    c = RecordingClient()
    c.api_response = {"status": 200, "data": {"other": "shape"}}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_image(prompt="x", project_id="p")
    assert out["media_ids"] == []


@pytest.mark.asyncio
async def test_gen_image_propagates_extension_error():
    c = RecordingClient()
    c.api_response = {"error": "CAPTCHA_FAILED: no tab"}
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_image(prompt="x", project_id="p")
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
    out = await sdk.gen_image(prompt="x", project_id="p")
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
async def test_gen_video_rejects_unknown_tier_aspect_combo():
    c = RecordingClient()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="x",
        project_id="p",
        start_media_id="m",
        aspect_ratio="VIDEO_ASPECT_RATIO_WEIRD",
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
        prompt="x", project_id="p", start_media_id="m"
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
