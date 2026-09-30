"""Tests for the muse2api transport of the Muse provider.

A fake muse2api is served through ``httpx.MockTransport`` (swapped in via
``muse2api._TRANSPORT``) so no socket is opened. It mimics the gateway's
OpenAI-compatible surface: chat completions, image generations (b64_json),
the async ``/v1/videos`` task API, ``/v1/media/{name}``, ``/readyz`` and
``/v1/models``.
"""
from __future__ import annotations

import base64
import json
from unittest.mock import patch

import httpx
import pytest

from flowboard.services import muse2api
from flowboard.services.llm.base import LLMError

BASE = "http://muse2api.test:18610"
KEY = "sk-test-muse"
PNG = b"\x89PNG\r\n\x1a\nfake-png-bytes"
MP4 = b"\x00\x00\x00\x18ftypmp42fake-mp4"


class FakeMuse2API:
    """Minimal in-memory muse2api. Records every request it sees."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.ready = True
        self.chat_status = 200
        self.video_polls_before_done = 1
        self.video_fail = False
        self.edit_status = 501
        self._videos: dict[str, dict] = {}

    def json_body(self, path: str) -> dict:
        for r in self.requests:
            if r.url.path == path and r.method == "POST":
                return json.loads(r.content)
        raise AssertionError(f"no POST to {path}")

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        public = path in ("/readyz",) or path.startswith("/v1/media/")
        if not public and request.headers.get("authorization") != f"Bearer {KEY}":
            return httpx.Response(401, json={"error": {"message": "invalid or missing API key",
                                                       "code": "invalid_api_key"}})
        if path == "/readyz":
            return httpx.Response(200, json={"ready": self.ready})
        if path == "/v1/models":
            return httpx.Response(200, json={"object": "list", "data": [
                {"id": "muse-chat", "kind": "chat"},
                {"id": "muse-image", "kind": "image"},
                {"id": "gpt-4o", "kind": "chat", "alias_of": "muse-chat"},
            ]})
        if path == "/v1/chat/completions":
            if self.chat_status != 200:
                return httpx.Response(self.chat_status, json={"error": {
                    "message": "no account available", "code": "no_account_available"}})
            body = json.loads(request.content)
            last = body["messages"][-1]["content"]
            text = last if isinstance(last, str) else last[0]["text"]
            return httpx.Response(200, json={"choices": [
                {"index": 0, "message": {"role": "assistant", "content": f"echo: {text}"}}]})
        if path == "/v1/images/generations":
            body = json.loads(request.content)
            item = {"b64_json": base64.b64encode(PNG).decode(), "revised_prompt": body["prompt"]}
            return httpx.Response(200, json={"created": 1, "data": [item] * body["n"]})
        if path == "/v1/images/edits":
            if self.edit_status != 200:
                return httpx.Response(self.edit_status, json={"error": {
                    "message": "/v1/images/edits is planned", "code": "not_implemented"}})
            return httpx.Response(200, json={"data": [
                {"b64_json": base64.b64encode(PNG).decode()}]})
        if path == "/v1/videos" and request.method == "POST":
            vid = f"task_{len(self._videos)}"
            self._videos[vid] = {"polls": 0}
            return httpx.Response(200, json={"id": vid, "status": "queued", "progress": 0})
        if path.startswith("/v1/videos/"):
            vid = path.rsplit("/", 1)[1]
            state = self._videos[vid]
            state["polls"] += 1
            if state["polls"] < self.video_polls_before_done:
                return httpx.Response(200, json={"id": vid, "status": "running"})
            if self.video_fail:
                return httpx.Response(200, json={"id": vid, "status": "failed", "error": {
                    "message": "upstream refused", "code": "upstream_refused"}})
            # Deliberately NOT our base host: muse2api builds media links from
            # its own view of the request; the client must re-root them.
            return httpx.Response(200, json={"id": vid, "status": "succeeded", "result": {
                "url": f"http://0.0.0.0:18610/v1/media/vid_{vid}.mp4", "mime": "video/mp4"}})
        if path.startswith("/v1/media/"):
            ctype = "video/mp4" if path.endswith(".mp4") else "image/png"
            return httpx.Response(200, content=MP4 if ctype == "video/mp4" else PNG,
                                  headers={"content-type": ctype})
        return httpx.Response(404, json={"error": {"message": "not found"}})


@pytest.fixture
def fake(monkeypatch):
    srv = FakeMuse2API()
    monkeypatch.setattr(muse2api.config, "MUSE2API_BASE", BASE)
    monkeypatch.setattr(muse2api.config, "MUSE2API_KEY", KEY)
    monkeypatch.setattr(muse2api.config, "MUSE2API_POLL_S", 0.0)
    monkeypatch.setattr(muse2api, "_TRANSPORT", httpx.MockTransport(srv.handler))
    muse2api.reset_cache()
    yield srv
    muse2api.reset_cache()


def _only_host(srv: FakeMuse2API) -> set[str]:
    return {r.url.host for r in srv.requests}


# ── configuration ─────────────────────────────────────────────────────


def test_unconfigured_by_default(monkeypatch):
    monkeypatch.setattr(muse2api.config, "MUSE2API_BASE", "")
    assert muse2api.is_configured() is False


def test_size_for_orientation():
    assert muse2api.size_for_orientation("HORIZONTAL") == "16:9"
    assert muse2api.size_for_orientation("VERTICAL") == "9:16"
    assert muse2api.size_for_orientation(None) is None


# ── LLM provider ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_muse_provider_chat_via_gateway(fake, tmp_path):
    from flowboard.services import provider_jobs as pq
    from flowboard.services.llm.muse import MuseProvider

    img = tmp_path / "ref.png"
    img.write_bytes(PNG)
    with patch.object(pq, "create_provider_job") as queued:
        text = await MuseProvider().run(
            "describe", system_prompt="be terse", attachments=[str(img)],
            model="muse-spark",
        )
    assert text == "echo: describe"
    queued.assert_not_called()  # gateway mode never touches the queue

    body = fake.json_body("/v1/chat/completions")
    assert body["stream"] is False
    assert "model" not in body  # queue placeholder id is not forwarded
    assert body["messages"][0] == {"role": "system", "content": "be terse"}
    parts = body["messages"][1]["content"]
    assert parts[0] == {"type": "text", "text": "describe"}
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert _only_host(fake) == {"muse2api.test"}


@pytest.mark.asyncio
async def test_muse_provider_forwards_real_model(fake):
    from flowboard.services.llm.muse import MuseProvider

    await MuseProvider().run("hi", model="muse-chat")
    assert fake.json_body("/v1/chat/completions")["model"] == "muse-chat"


@pytest.mark.asyncio
async def test_muse_provider_gateway_error_is_llm_error(fake):
    from flowboard.services.llm.muse import MuseProvider

    fake.chat_status = 503
    with pytest.raises(LLMError, match="503.*no account available"):
        await MuseProvider().run("hi")


@pytest.mark.asyncio
async def test_muse_provider_bad_key_surfaces_401(fake, monkeypatch):
    from flowboard.services.llm.muse import MuseProvider

    monkeypatch.setattr(muse2api.config, "MUSE2API_KEY", "wrong")
    with pytest.raises(LLMError, match="401") as exc:
        await MuseProvider().run("hi")
    assert "wrong" not in str(exc.value)  # never echo the key


@pytest.mark.asyncio
async def test_muse_provider_availability_is_readyz(fake):
    from flowboard.services.llm.muse import MuseProvider

    p = MuseProvider()
    assert p.mode == "gateway"
    assert p.default_model == "muse-chat"
    assert await p.is_available() is True
    fake.ready = False
    assert await p.is_available() is True  # cached
    p.reset_cache()
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_muse_provider_unreachable_gateway_is_unavailable(monkeypatch):
    from flowboard.services.llm.muse import MuseProvider

    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(muse2api.config, "MUSE2API_BASE", BASE)
    monkeypatch.setattr(muse2api, "_TRANSPORT", httpx.MockTransport(boom))
    muse2api.reset_cache()
    assert await MuseProvider().is_available() is False
    assert await MuseProvider().list_models() == []
    muse2api.reset_cache()


@pytest.mark.asyncio
async def test_muse_provider_lists_gateway_chat_models(fake):
    from flowboard.services.llm.muse import MuseProvider

    models = await MuseProvider().list_models()
    assert [m["id"] for m in models] == ["muse-chat"]  # no image kinds, no aliases


def test_providers_route_reports_gateway_mode(fake, client):
    by_name = {p["name"]: p for p in client.get("/api/llm/providers").json()}
    muse = by_name["muse"]
    assert muse["mode"] == "gateway"
    assert muse["available"] is True and muse["configured"] is True
    assert muse["defaultModel"] == "muse-chat"


# ── media ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gen_image_via_gateway(fake):
    from flowboard.services import media as media_service
    from flowboard.services import muse_media

    result, error = await muse_media.run_muse_media(
        kind="image", prompt="a cat", orientation="VERTICAL",
        reference_media_ids=["abc123"], extra={"variant_count": 2},
    )
    assert error is None, error
    assert result["transport"] == "muse2api"
    assert len(result["media_ids"]) == 2
    for mid in result["media_ids"]:
        assert media_service.cached_path(mid).read_bytes() == PNG
    assert "reference image(s) ignored" in result["warnings"][0]

    body = fake.json_body("/v1/images/generations")
    assert body == {"prompt": "a cat", "n": 2, "response_format": "b64_json", "size": "9:16"}


@pytest.mark.asyncio
async def test_gen_image_per_variant_prompts(fake):
    from flowboard.services import muse_media

    result, error = await muse_media.run_muse_media(
        kind="image", prompt="base", extra={"prompts": ["one", "two", "three"]},
    )
    assert error is None
    assert len(result["media_ids"]) == 3
    sent = sorted(json.loads(r.content)["prompt"] for r in fake.requests
                  if r.url.path == "/v1/images/generations")
    assert sent == ["one", "three", "two"]


@pytest.mark.asyncio
async def test_gen_image_variant_count_split_over_cap(fake):
    from flowboard.services import muse_media

    result, error = await muse_media.run_muse_media(
        kind="image", prompt="x", extra={"variant_count": 6},
    )
    assert error is None
    assert len(result["media_ids"]) == 6
    ns = sorted(json.loads(r.content)["n"] for r in fake.requests
                if r.url.path == "/v1/images/generations")
    assert ns == [2, 4]


@pytest.mark.asyncio
async def test_gen_video_i2v_polls_and_reroots_media_url(fake, tmp_path):
    from flowboard.services import media as media_service
    from flowboard.services import muse_media

    frame = tmp_path / "frame.png"
    frame.write_bytes(PNG)
    fake.video_polls_before_done = 3

    async def fake_resolve(mid):
        return f"file://{frame}"

    with patch.object(muse_media, "_resolve_media_input_url", fake_resolve):
        result, error = await muse_media.run_muse_media(
            kind="video", prompt="pan left", orientation="HORIZONTAL",
            source_media_ids=["f1", "f2"],
        )
    assert error is None, error
    assert len(result["media_ids"]) == 2  # one task per start frame
    assert media_service.cached_path(result["media_ids"][0]).read_bytes() == MP4

    creates = [json.loads(r.content) for r in fake.requests
               if r.url.path == "/v1/videos" and r.method == "POST"]
    assert len(creates) == 2
    assert creates[0]["size"] == "16:9"
    assert creates[0]["image"].startswith("data:image/png;base64,")
    # The 0.0.0.0 link was fetched from our configured base instead.
    assert _only_host(fake) == {"muse2api.test"}


@pytest.mark.asyncio
async def test_gen_video_refs_uses_first_ref_and_duration(fake, tmp_path):
    from flowboard.services import muse_media

    frame = tmp_path / "ref.png"
    frame.write_bytes(PNG)

    async def fake_resolve(mid):
        return f"file://{frame}"

    with patch.object(muse_media, "_resolve_media_input_url", fake_resolve):
        result, error = await muse_media.run_muse_media(
            kind="video_refs", prompt="dance", reference_media_ids=["r1", "r2"],
            extra={"duration_s": 8},
        )
    assert error is None
    assert len(result["media_ids"]) == 1
    assert "1 reference image(s) ignored" in result["warnings"][0]
    body = fake.json_body("/v1/videos")
    assert body["duration"] == 8 and body["image"].startswith("data:")


@pytest.mark.asyncio
async def test_gen_video_task_failure_is_error(fake):
    from flowboard.services import muse_media

    fake.video_fail = True
    result, error = await muse_media.run_muse_media(kind="video_refs", prompt="x")
    assert result == {}
    assert error.startswith("muse2api_failed:") and "upstream refused" in error


@pytest.mark.asyncio
async def test_edit_image_not_implemented_upstream_is_error(fake, tmp_path):
    from flowboard.services import muse_media

    src = tmp_path / "src.png"
    src.write_bytes(PNG)

    async def fake_resolve(mid):
        return f"file://{src}"

    with patch.object(muse_media, "_resolve_media_input_url", fake_resolve):
        _result, error = await muse_media.run_muse_media(
            kind="edit_image", prompt="make it blue", source_media_ids=["s1"],
        )
    assert "muse2api HTTP 501" in error and "planned" in error


@pytest.mark.asyncio
async def test_edit_image_multipart_when_supported(fake, tmp_path):
    from flowboard.services import muse_media

    src = tmp_path / "src.png"
    src.write_bytes(PNG)
    fake.edit_status = 200

    async def fake_resolve(mid):
        return f"file://{src}"

    with patch.object(muse_media, "_resolve_media_input_url", fake_resolve):
        result, error = await muse_media.run_muse_media(
            kind="edit_image", prompt="make it blue", source_media_ids=["s1"],
            reference_media_ids=["r1"],
        )
    assert error is None
    req = next(r for r in fake.requests if r.url.path == "/v1/images/edits")
    assert req.headers["content-type"].startswith("multipart/form-data")
    assert req.content.count(b'name="image[]"') == 2
    assert b"make it blue" in req.content


@pytest.mark.asyncio
async def test_processor_gen_image_muse_routes_to_gateway(fake):
    from flowboard.worker.processor import _handle_gen_image

    result, error = await _handle_gen_image(
        {"prompt": "a dog", "media_provider": "muse",
         "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE"}
    )
    assert error is None
    assert result["provider"] == "muse" and result["transport"] == "muse2api"
    assert fake.json_body("/v1/images/generations")["size"] == "16:9"
