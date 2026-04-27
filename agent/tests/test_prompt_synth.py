"""Tests for prompt_synth service + /api/prompt/auto route."""
from __future__ import annotations

import pytest

from flowboard.db import get_session
from flowboard.db.models import Edge, Node, Board
from flowboard.services import claude_cli, prompt_synth


def _seed_board_with_chain(monkeypatch=None) -> dict:
    """Create a Board + 3 nodes (character, visual_asset, image) + edges
    char→image, asset→image. Return their ids."""
    with get_session() as s:
        b = Board(name="t")
        s.add(b)
        s.commit()
        s.refresh(b)
        char = Node(
            board_id=b.id,
            short_id="char",
            type="character",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Character",
                "aiBrief": "young Korean woman, neutral expression, dark hair tied back",
                "mediaId": "uuuuuuuu-1111-2222-3333-444444444444",
            },
            status="done",
        )
        asset = Node(
            board_id=b.id,
            short_id="asse",
            type="visual_asset",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Visual asset",
                "aiBrief": "white cotton crewneck t-shirt with small heart logo on chest",
                "mediaId": "uuuuuuuu-2222-2222-3333-444444444444",
            },
            status="done",
        )
        target = Node(
            board_id=b.id,
            short_id="targ",
            type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Composed image"},
            status="idle",
        )
        s.add_all([char, asset, target])
        s.commit()
        s.refresh(char); s.refresh(asset); s.refresh(target)
        s.add(Edge(board_id=b.id, source_id=char.id, target_id=target.id))
        s.add(Edge(board_id=b.id, source_id=asset.id, target_id=target.id))
        s.commit()
        return {"target_id": target.id, "char_id": char.id, "asset_id": asset.id}


@pytest.mark.asyncio
async def test_auto_prompt_calls_claude_with_upstream_briefs(client, monkeypatch):
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub_run(prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return "Photoreal studio shot of a Korean woman wearing a white heart-logo t-shirt"

    monkeypatch.setattr(claude_cli, "run_claude", stub_run)

    out = await prompt_synth.auto_prompt(ids["target_id"])
    assert "Korean woman" in out
    # Both upstream briefs must surface in the prompt sent to Claude.
    assert "Korean woman" in captured["prompt"]
    assert "white cotton crewneck" in captured["prompt"]
    # System prompt must set photo-realistic style + fashion-editorial pose
    # guidance (so the model showcases the product instead of standing
    # arms-down). These are the load-bearing instructions for hero shots.
    sp = (captured["system_prompt"] or "").lower()
    assert "photoreal" in sp
    assert "pose" in sp
    assert "three-quarter" in sp or "three quarter" in sp
    assert "hero" in sp


@pytest.mark.asyncio
async def test_auto_prompt_video_uses_motion_system_prompt(client, monkeypatch):
    """Video targets get a *motion* system prompt (camera moves, micro-
    expressions) — distinct from the composition prompt for image targets.
    The user message still surfaces the source image's brief."""
    with get_session() as s:
        b = Board(name="t")
        s.add(b); s.commit(); s.refresh(b)
        src = Node(
            board_id=b.id, short_id="src", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Source",
                "aiBrief": "young Korean woman wearing a white t-shirt in a closet",
                "mediaId": "uuuuuuuu-3333-3333-3333-444444444444",
            },
            status="done",
        )
        vid = Node(
            board_id=b.id, short_id="vid", type="video",
            x=0, y=0, w=240, h=180,
            data={"title": "Vid"},
            status="idle",
        )
        s.add_all([src, vid]); s.commit(); s.refresh(src); s.refresh(vid)
        s.add(Edge(board_id=b.id, source_id=src.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured: dict = {}

    async def stub_run(prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return "Slow camera dolly-in, gentle smile, fabric softly catching the light."

    monkeypatch.setattr(claude_cli, "run_claude", stub_run)
    out = await prompt_synth.auto_prompt(vid_id)
    assert "dolly-in" in out
    assert "motion" in (captured["system_prompt"] or "").lower()
    assert "Korean woman" in captured["prompt"]


@pytest.mark.asyncio
async def test_auto_prompt_video_static_camera_locks_system_prompt(client, monkeypatch):
    """When camera='static' the synthesiser must use the locked-camera
    system variant and NOT propose dolly/pan/zoom (which crops the product
    out of frame in e-commerce shots)."""
    with get_session() as s:
        b = Board(name="t")
        s.add(b); s.commit(); s.refresh(b)
        src = Node(
            board_id=b.id, short_id="src2", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Source",
                "aiBrief": "model wearing a white t-shirt with a heart logo",
                "mediaId": "uuuuuuuu-9999-3333-3333-444444444444",
            },
            status="done",
        )
        vid = Node(
            board_id=b.id, short_id="vid2", type="video",
            x=0, y=0, w=240, h=180,
            data={"title": "Vid"},
            status="idle",
        )
        s.add_all([src, vid]); s.commit(); s.refresh(src); s.refresh(vid)
        s.add(Edge(board_id=b.id, source_id=src.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured: dict = {}

    async def stub_run(prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return "blink, faint smile, fabric breathing softly"

    monkeypatch.setattr(claude_cli, "run_claude", stub_run)
    out = await prompt_synth.auto_prompt(vid_id, camera="static")
    assert "fabric" in out
    sp = (captured["system_prompt"] or "").lower()
    # Camera lock — strict
    assert "static" in sp
    assert "no zoom" in sp
    assert "no pan" in sp
    # Pose guidance — the model still moves to showcase the garment even
    # with a locked-off camera, and must perform multiple beats over 8s.
    assert "pose change" in sp or "pose-change" in sp or "pose shift" in sp
    assert "three-quarter" in sp or "three quarter" in sp
    # Time-coded beat structure
    assert "0-3s" in sp
    assert "6-8s" in sp


@pytest.mark.asyncio
async def test_auto_prompt_video_default_camera_allows_movement(client, monkeypatch):
    """No camera arg → default video system prompt; doesn't include the
    static-only constraint."""
    with get_session() as s:
        b = Board(name="t")
        s.add(b); s.commit(); s.refresh(b)
        src = Node(
            board_id=b.id, short_id="src3", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "x", "aiBrief": "scene", "mediaId": "uuuuuuuu-aaaa-3333-3333-444444444444"},
            status="done",
        )
        vid = Node(
            board_id=b.id, short_id="vid3", type="video",
            x=0, y=0, w=240, h=180,
            data={"title": "v"},
            status="idle",
        )
        s.add_all([src, vid]); s.commit(); s.refresh(src); s.refresh(vid)
        s.add(Edge(board_id=b.id, source_id=src.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured: dict = {}

    async def stub_run(prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return "subtle motion"

    monkeypatch.setattr(claude_cli, "run_claude", stub_run)
    await prompt_synth.auto_prompt(vid_id)  # no camera arg
    sp = captured["system_prompt"] or ""
    # default variant should NOT enforce no-zoom/no-pan rule
    assert "no zoom, no pan" not in sp.lower()


@pytest.mark.asyncio
async def test_auto_prompt_with_no_upstream_falls_back_to_title(client, monkeypatch):
    """A bare image node with no edges still gets a sensible prompt."""
    with get_session() as s:
        b = Board(name="t")
        s.add(b); s.commit(); s.refresh(b)
        n = Node(
            board_id=b.id, short_id="bare", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "A red sneaker on white"},
            status="idle",
        )
        s.add(n); s.commit(); s.refresh(n)
        nid = n.id

    async def stub_run(prompt, *, system_prompt=None, timeout=0):
        # Verify the prompt mentions the title even with no upstream.
        assert "red sneaker" in prompt.lower()
        return "studio photo of a red sneaker on white background"

    monkeypatch.setattr(claude_cli, "run_claude", stub_run)
    out = await prompt_synth.auto_prompt(nid)
    assert "sneaker" in out


@pytest.mark.asyncio
async def test_auto_prompt_raises_for_unknown_node(client):
    with pytest.raises(prompt_synth.PromptSynthError):
        await prompt_synth.auto_prompt(999999)


@pytest.mark.asyncio
async def test_auto_prompt_caps_long_responses(client, monkeypatch):
    ids = _seed_board_with_chain()
    long_text = "a" * 900

    async def stub_run(*a, **k):
        return long_text

    monkeypatch.setattr(claude_cli, "run_claude", stub_run)
    out = await prompt_synth.auto_prompt(ids["target_id"])
    assert len(out) <= 501
    assert out.endswith("…")


def test_route_happy_path(client, monkeypatch):
    ids = _seed_board_with_chain()

    async def stub(node_id, *, camera=None):
        assert node_id == ids["target_id"]
        return "synthesized prompt"

    monkeypatch.setattr(prompt_synth, "auto_prompt", stub)
    r = client.post("/api/prompt/auto", json={"node_id": ids["target_id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt"] == "synthesized prompt"
    assert body["node_id"] == ids["target_id"]


def test_route_passes_camera_arg_through(client, monkeypatch):
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub(node_id, *, camera=None):
        captured["camera"] = camera
        return "ok"

    monkeypatch.setattr(prompt_synth, "auto_prompt", stub)
    r = client.post(
        "/api/prompt/auto",
        json={"node_id": ids["target_id"], "camera": "static"},
    )
    assert r.status_code == 200, r.text
    assert captured["camera"] == "static"


def test_route_502_on_synth_failure(client, monkeypatch):
    async def stub(node_id, *, camera=None):
        raise prompt_synth.PromptSynthError("claude CLI failed: timeout")

    monkeypatch.setattr(prompt_synth, "auto_prompt", stub)
    r = client.post("/api/prompt/auto", json={"node_id": 1})
    assert r.status_code == 502
