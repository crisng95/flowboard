"""Tests for prompt_synth service + /api/prompt/auto route.

After the multi-LLM provider migration the service routes all dispatches
through `run_llm("auto_prompt", ...)`. Tests patch `run_llm` at the
import boundary in `prompt_synth` so the registry / provider stack is
fully bypassed; coverage for routing lives in `test_llm_registry.py`.
"""
from __future__ import annotations

import pytest

from flowboard.db import get_session
from flowboard.db.models import Edge, Node, Board
from flowboard.services import prompt_synth
from flowboard.services.llm.base import LLMError


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
async def test_auto_prompt_multi_variant_node_still_gets_ref_image_label(
    client, monkeypatch
):
    """When an upstream image node has 4 variants stored as `mediaIds`
    (and `mediaId` may even be unset), the synthesiser must still treat
    it as a ref source and emit a `ref_image_N` label. The frontend
    expands the variants flat into `ref_media_ids`; this test guards
    the backend's matching `has_media` check that drives `ref_index`
    assignment in `_collect_upstream`."""
    with get_session() as s:
        b = Board(name="multi-variant")
        s.add(b); s.commit(); s.refresh(b)
        # Multi-variant source: only `mediaIds` populated (4 entries).
        # `mediaId` intentionally omitted to prove the fallback path.
        outfit = Node(
            board_id=b.id, short_id="ofit", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Beige outfit (4 variants)",
                "aiBrief": "young East Asian woman in beige oversized blazer, neutral expression",
                "mediaIds": [
                    "uuuuuuuu-ofit-0001-0001-000000000001",
                    "uuuuuuuu-ofit-0002-0002-000000000002",
                    "uuuuuuuu-ofit-0003-0003-000000000003",
                    "uuuuuuuu-ofit-0004-0004-000000000004",
                ],
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="trgt", type="image",
            x=0, y=0, w=240, h=180, data={"title": "Output"},
            status="idle",
        )
        s.add_all([outfit, target]); s.commit()
        for n in (outfit, target):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=outfit.id, target_id=target.id))
        s.commit()
        tgt_id = target.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        return "Editorial photo of model in beige blazer"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(tgt_id)

    user = captured["prompt"] or ""
    # Multi-variant node still earns its `ref_image_N` slot — without
    # this the synthesiser would silently drop nodes that only have
    # `mediaIds` (no `mediaId`), leaving the LLM with no reference
    # label to bind to even though the wire payload includes 4 inputs.
    assert "ref_image_1:" in user
    assert "beige" in user.lower()


@pytest.mark.asyncio
async def test_auto_prompt_calls_provider_with_upstream_briefs(client, monkeypatch):
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return "Photoreal studio shot of a Korean woman wearing a white heart-logo t-shirt"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)

    out = await prompt_synth.auto_prompt(ids["target_id"])
    assert "Korean woman" in out
    # Both upstream briefs must surface in the prompt sent to Claude.
    assert "Korean woman" in captured["prompt"]
    assert "white cotton crewneck" in captured["prompt"]
    # System prompt must set photo-realistic style + fashion-editorial pose
    # guidance with the load-bearing anchors:
    #   - gaze must engage the camera (no profile / back / looking-away)
    #   - stance pool for variety (so successive gens aren't identical)
    #   - product-hero framing
    sp = (captured["system_prompt"] or "").lower()
    assert "photoreal" in sp
    assert "engage the camera" in sp or "engage the lens" in sp
    assert "no profile" in sp or "no looking-away" in sp
    assert "stance" in sp
    assert "three-quarter" in sp or "three quarter" in sp
    assert "hero" in sp
    # No-smile anchor — open-mouth smiles destabilise downstream i2v.
    assert "no smiling" in sp
    assert "closed-mouth" in sp
    assert "no teeth" in sp
    # Stance pool must list multiple options so the LLM has variety to
    # rotate through — assert at least 4 distinct gestures present.
    pool_options = [
        "hands in pockets",
        "brushing the collar",
        "hand-on-hip",
        "arms casually crossed",
        "hand running through hair",
        "walking towards camera",
        "leaning weight on one hip",
    ]
    matches = sum(1 for opt in pool_options if opt in sp)
    assert matches >= 4, f"only matched {matches} pose options in pool"


def _seed_couple_via_image_siblings() -> dict:
    """Seed a board where the target image has 2 image upstream siblings,
    each wrapping a different character grandparent. Mirrors the real-world
    couple-shot graph: char_male → img_male, char_female → img_female,
    img_male + img_female → target."""
    with get_session() as s:
        b = Board(name="couple")
        s.add(b); s.commit(); s.refresh(b)
        char_m = Node(
            board_id=b.id, short_id="cmal", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "Male", "aiBrief": "young Vietnamese man",
                  "mediaId": "uuuuuuuu-aaaa-1111-1111-111111111111"},
            status="done",
        )
        char_f = Node(
            board_id=b.id, short_id="cfem", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "Female", "aiBrief": "young Vietnamese woman",
                  "mediaId": "uuuuuuuu-bbbb-1111-1111-111111111111"},
            status="done",
        )
        img_m = Node(
            board_id=b.id, short_id="imgm", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "M shot", "mediaId": "uuuuuuuu-mmmm-1111-1111-111111111111"},
            status="done",
        )
        img_f = Node(
            board_id=b.id, short_id="imgf", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "F shot", "mediaId": "uuuuuuuu-ffff-1111-1111-111111111111"},
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="ctgt", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Couple shot"},
            status="idle",
        )
        s.add_all([char_m, char_f, img_m, img_f, target])
        s.commit()
        for n in (char_m, char_f, img_m, img_f, target):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=char_m.id, target_id=img_m.id))
        s.add(Edge(board_id=b.id, source_id=char_f.id, target_id=img_f.id))
        s.add(Edge(board_id=b.id, source_id=img_m.id, target_id=target.id))
        s.add(Edge(board_id=b.id, source_id=img_f.id, target_id=target.id))
        s.commit()
        return {
            "target_id": target.id,
            "char_m_short": char_m.short_id,
            "char_f_short": char_f.short_id,
        }


@pytest.mark.asyncio
async def test_auto_prompt_multi_subject_detects_couple_via_image_siblings(
    client, monkeypatch
):
    """When target has 2 image upstream each wrapping a different character
    grandparent, synth must switch to multi-subject mode: the user message
    surfaces both subjects (by `ref_image_N` position) and the system
    prompt enforces couple framing.

    Note: shortIds (`#abcd`) used to be embedded in the user message and
    the system prompt told Claude to bind subjects "by `#shortId`". Flow
    doesn't parse those — refs bind via the positional `imageInputs`
    array, and the @-handle-looking tokens correlated with false-positive
    `PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED` from Google's content
    classifier. The synth now uses `ref_image_N` labels matching the
    `ref_media_ids` slot order on the wire."""
    ids = _seed_couple_via_image_siblings()
    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return "Editorial couple shot of ref_image_1 and ref_image_2"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt(ids["target_id"])
    assert "ref_image_1" in out and "ref_image_2" in out

    # User message must declare 2 distinct subjects and address the two
    # image refs by their positional ref_image_N labels.
    user = captured["prompt"]
    assert "DISTINCT SUBJECTS DETECTED: 2 people" in user
    assert "ref_image_1:" in user
    assert "ref_image_2:" in user
    # No upstream-node shortIds should leak into the LLM prompt body.
    assert f"#{ids['char_m_short']}" not in user
    assert f"#{ids['char_f_short']}" not in user

    # System prompt must include the multi-subject clause.
    sp = captured["system_prompt"] or ""
    assert "MULTI-SUBJECT MODE" in sp
    assert "REFERENCE BY POSITION" in sp
    assert "ref_image_N" in sp
    assert "couple/group" in sp.lower() or "couple / group" in sp.lower()
    assert "complementary stance" in sp.lower()


@pytest.mark.asyncio
async def test_auto_prompt_single_subject_skips_multi_clause(client, monkeypatch):
    """A normal 1-character + 1-asset graph must NOT carry the multi-subject
    clause — only the single-subject base prompt."""
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        captured["prompt"] = prompt
        return "single subject prompt"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(ids["target_id"])
    sp = captured["system_prompt"] or ""
    assert "MULTI-SUBJECT MODE" not in sp
    assert "DISTINCT SUBJECTS DETECTED" not in (captured["prompt"] or "")


@pytest.mark.asyncio
async def test_auto_prompt_multi_subject_via_two_character_upstream(
    client, monkeypatch
):
    """Two character nodes connected directly to the target also count as
    multi-subject (no image-siblings indirection needed)."""
    with get_session() as s:
        b = Board(name="couple-direct")
        s.add(b); s.commit(); s.refresh(b)
        c1 = Node(
            board_id=b.id, short_id="cd01", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "P1", "aiBrief": "man",
                  "mediaId": "uuuuuuuu-cccc-1111-1111-111111111111"},
            status="done",
        )
        c2 = Node(
            board_id=b.id, short_id="cd02", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "P2", "aiBrief": "woman",
                  "mediaId": "uuuuuuuu-dddd-1111-1111-111111111111"},
            status="done",
        )
        tgt = Node(
            board_id=b.id, short_id="cdtg", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Couple"},
            status="idle",
        )
        s.add_all([c1, c2, tgt]); s.commit()
        for n in (c1, c2, tgt):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=c1.id, target_id=tgt.id))
        s.add(Edge(board_id=b.id, source_id=c2.id, target_id=tgt.id))
        s.commit()
        tgt_id = tgt.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        captured["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(tgt_id)
    assert "MULTI-SUBJECT MODE" in (captured["system_prompt"] or "")
    assert "DISTINCT SUBJECTS DETECTED: 2 people" in (captured["prompt"] or "")


@pytest.mark.asyncio
async def test_auto_prompt_image_with_location_reference_keeps_setting(
    client, monkeypatch
):
    """Regression: when target has 2 image upstream — one a garment/subject
    reference, the other a location/scene reference (no character grandparent
    on either) — the synthesiser must surface the ROLE INFERENCE hint and
    drop the hardcoded "studio default" so Claude places the subject INTO
    the location instead of silently dropping it.

    Scenario (the bug we're fixing): user attaches a pink-t-shirt photo +
    a jogging-path photo to a target image. Output came back as a plain
    studio shot of the t-shirt with the park completely missing — Claude
    was honouring the system prompt's 'neutral indoor or studio background'
    default rather than using the location upstream as the setting."""
    with get_session() as s:
        b = Board(name="loc-ref")
        s.add(b); s.commit(); s.refresh(b)
        garment = Node(
            board_id=b.id, short_id="zy6g", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "T-shirt",
                "aiBrief": "pink crewneck cotton t-shirt worn by a model, "
                           "plain white background, product reference",
                "mediaId": "uuuuuuuu-zy6g-1111-1111-111111111111",
            },
            status="done",
        )
        location = Node(
            board_id=b.id, short_id="vx3x", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Jogging path",
                "aiBrief": "outdoor jogging path in a public park, trees, "
                           "people running, bright daylight, urban park scene",
                "mediaId": "uuuuuuuu-vx3x-1111-1111-111111111111",
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="cgx0", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Composed shot"},
            status="idle",
        )
        s.add_all([garment, location, target]); s.commit()
        for n in (garment, location, target):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=garment.id, target_id=target.id))
        s.add(Edge(board_id=b.id, source_id=location.id, target_id=target.id))
        s.commit()
        tgt_id = target.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return "Editorial photo of a model wearing a pink crewneck on a "\
               "sunlit jogging path in a public park"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(tgt_id)

    user = captured["prompt"] or ""
    sp = captured["system_prompt"] or ""

    # Both briefs surface in the user message — context is intact.
    assert "pink crewneck" in user
    assert "jogging path" in user
    # Refs are addressed by positional `ref_image_N` labels (matches the
    # ref_media_ids slot Flow sees on the wire). Internal node shortIds
    # MUST NOT leak into the LLM prompt body — they look like @-handles
    # to Google's content classifier.
    assert "ref_image_1:" in user and "ref_image_2:" in user
    assert "#zy6g" not in user and "#vx3x" not in user

    # ROLE INFERENCE hint must be present whenever 2+ image refs feed in,
    # so Claude classifies which is subject vs setting from the briefs
    # rather than guessing.
    assert "ROLE INFERENCE" in user
    assert "SETTING reference" in user
    assert "places the subject INTO" in user

    # System prompt must include the new BACKGROUND PRIORITY rule directing
    # Claude to use any location reference as the shot's environment.
    assert "BACKGROUND PRIORITY" in sp
    assert "USE that environment" in sp
    # The old hardcoded "studio default unless notes override" wording must
    # be gone — that bias was the root cause of the location getting dropped.
    assert "studio background unless the notes override" not in sp.lower()
    # Studio is still the fallback when NO location ref exists.
    assert "fall back to a neutral indoor/studio background" in sp.lower() or \
           "fall back to studio" in sp.lower()


@pytest.mark.asyncio
async def test_auto_prompt_image_role_hint_skipped_when_single_image_ref(
    client, monkeypatch
):
    """The ROLE INFERENCE hint only kicks in when 2+ image refs are
    present. A single image upstream is unambiguous — no need to ask
    Claude to classify roles."""
    ids = _seed_board_with_chain()

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(ids["target_id"])
    # _seed_board_with_chain has 1 character + 1 visual_asset, no image
    # upstream → ROLE INFERENCE block must not appear.
    assert "ROLE INFERENCE" not in (captured["prompt"] or "")


@pytest.mark.asyncio
async def test_auto_prompt_surfaces_prompt_nodes_as_direction(
    client, monkeypatch
):
    """Prompt nodes carry reusable style/scene direction. Connecting one
    upstream of an image must inject its text into the user message under
    the 'Direction / style notes' group so Claude weaves it into the
    output. Note nodes by contrast stay decorative and must NOT surface."""
    with get_session() as s:
        b = Board(name="prompt-feed")
        s.add(b); s.commit(); s.refresh(b)
        ch = Node(
            board_id=b.id, short_id="pfch", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "P", "aiBrief": "young Vietnamese woman",
                  "mediaId": "uuuuuuuu-pfch-1111-1111-111111111111"},
            status="done",
        )
        direction = Node(
            board_id=b.id, short_id="pfdr", type="prompt",
            x=0, y=0, w=240, h=180,
            data={"title": "Brand tone",
                  "prompt": "magazine editorial mood, cinematic warm tone, "
                            "Old Money palette"},
            status="idle",
        )
        sticky = Node(
            board_id=b.id, short_id="pfnt", type="note",
            x=0, y=0, w=240, h=180,
            data={"title": "TODO",
                  "prompt": "remember to ask Tuan about the deadline"},
            status="idle",
        )
        tgt = Node(
            board_id=b.id, short_id="pftg", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Hero shot"},
            status="idle",
        )
        s.add_all([ch, direction, sticky, tgt]); s.commit()
        for n in (ch, direction, sticky, tgt):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=ch.id, target_id=tgt.id))
        s.add(Edge(board_id=b.id, source_id=direction.id, target_id=tgt.id))
        s.add(Edge(board_id=b.id, source_id=sticky.id, target_id=tgt.id))
        s.commit()
        tgt_id = tgt.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        return "Editorial portrait with Old Money mood and warm tone"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(tgt_id)
    user = captured["prompt"] or ""

    # Prompt node text must surface under the styling-direction group.
    assert "Direction / style notes" in user
    assert "magazine editorial mood" in user
    assert "Old Money palette" in user
    # Prompt nodes carry no image, so they get NO `ref_image_N` label —
    # the LLM doesn't need to bind them positionally, just weave them in.
    assert "#pfdr" not in user

    # Note node text must NOT leak into the synth context — the sticky is
    # human-only commentary and would just dilute the prompt.
    assert "remember to ask Tuan" not in user
    assert "#pfnt" not in user


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

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return "Slow camera dolly-in, gentle smile, fabric softly catching the light."

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt(vid_id)
    assert "dolly-in" in out
    assert "motion" in (captured["system_prompt"] or "").lower()
    assert "Korean woman" in captured["prompt"]
    # Audio guard — must direct silent / no-dialogue by default.
    # Veo's audio path triggers PUBLIC_MIRROR_AUDIO_FILTER on portraits
    # the moment speech is generated, killing the entire request, so
    # the synth has to instruct silent unless the user explicitly
    # asked for dialogue.
    sp = captured["system_prompt"] or ""
    assert "AUDIO" in sp
    assert "SILENT BY DEFAULT" in sp
    assert "PUBLIC_MIRROR_AUDIO_FILTER" in sp
    # SFX + music guidance present so the user's clip isn't completely
    # bare when default-silent fires.
    assert "SFX" in sp
    assert "MUSIC" in sp


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

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return "blink, faint smile, fabric breathing softly"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt(vid_id, camera="static")
    assert "fabric" in out
    sp = (captured["system_prompt"] or "").lower()
    # Camera lock — strict
    assert "static" in sp
    assert "no zoom" in sp or "no zoom / pan" in sp
    # Anti-freeze stays as a safety floor — Veo locks frame 0 without it.
    assert "anti-freeze" in sp
    # Intent-first philosophy must replace the old prescriptive vocab:
    # the synth should be told to read the source and let intent drive
    # motion, not pick gestures from a pre-canned scene→action menu.
    assert "intent first" in sp
    assert "interiority" in sp or "person with" in sp
    # Stillness must be allowed — older versions forced 2-3 pose changes
    # which made every clip feel theatrical.
    assert "stillness is valid" in sp
    # Beat structure remains as an OPTION, not a requirement.
    assert "structure is free" in sp


@pytest.mark.asyncio
async def test_auto_prompt_video_default_drops_canned_scene_vocab(client, monkeypatch):
    """Older system prompt prescribed a scene→action menu (studio = "hand
    on hip", café = "sip from a cup", etc.) which made every same-scene
    clip identical. Verify those canned mappings are gone — Claude is
    trusted to pick natural motion from the source brief instead."""
    with get_session() as s:
        b = Board(name="t")
        s.add(b); s.commit(); s.refresh(b)
        src = Node(
            board_id=b.id, short_id="srcd", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "x", "aiBrief": "scene", "mediaId": "uuuuuuuu-bbbb-3333-3333-444444444444"},
            status="done",
        )
        vid = Node(
            board_id=b.id, short_id="vidd", type="video",
            x=0, y=0, w=240, h=180,
            data={"title": "v"},
            status="idle",
        )
        s.add_all([src, vid]); s.commit(); s.refresh(src); s.refresh(vid)
        s.add(Edge(board_id=b.id, source_id=src.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return "out"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(vid_id)  # Dynamic
    sp = (captured["system_prompt"] or "").lower()
    # Anti-freeze + intent-first guidance still present.
    assert "anti-freeze" in sp
    assert "intent first" in sp
    # Dynamic camera clause allows subtle movement.
    assert "subtle dolly" in sp or "pan is allowed" in sp
    # Static-only constraint must NOT be in the dynamic variant.
    assert "no zoom / pan / dolly" not in sp
    # Old canned scene→action mappings must be gone — those forced every
    # café shot to "sip from a cup", every studio shot to "hand-on-hip",
    # which is exactly the over-prescription this refactor removes.
    assert "sip from a cup" not in sp
    assert "hair tuck behind ear" not in sp
    assert "hand slides to hip" not in sp


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

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return "subtle motion"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(vid_id)  # no camera arg
    sp = captured["system_prompt"] or ""
    # default variant should NOT enforce no-zoom/no-pan rule
    assert "no zoom, no pan" not in sp.lower()


@pytest.mark.asyncio
async def test_auto_prompt_video_multi_subject_when_source_has_two_chars(
    client, monkeypatch
):
    """Video targets must switch to multi-subject mode when the source
    image was generated from 2+ character upstream (couple shot). Without
    this, Veo gets a singular 'the model' direction and typically freezes
    one person while animating the other."""
    with get_session() as s:
        b = Board(name="couple-vid")
        s.add(b); s.commit(); s.refresh(b)
        cm = Node(
            board_id=b.id, short_id="cvm1", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "M", "aiBrief": "man",
                  "mediaId": "uuuuuuuu-mmm1-1111-1111-111111111111"},
            status="done",
        )
        cf = Node(
            board_id=b.id, short_id="cvf1", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "F", "aiBrief": "woman",
                  "mediaId": "uuuuuuuu-fff1-1111-1111-111111111111"},
            status="done",
        )
        couple_img = Node(
            board_id=b.id, short_id="cvi1", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Couple still",
                  "aiBrief": "two people side-by-side in studio",
                  "mediaId": "uuuuuuuu-cci1-1111-1111-111111111111"},
            status="done",
        )
        vid = Node(
            board_id=b.id, short_id="cvv1", type="video",
            x=0, y=0, w=240, h=180,
            data={"title": "Couple clip"},
            status="idle",
        )
        s.add_all([cm, cf, couple_img, vid]); s.commit()
        for n in (cm, cf, couple_img, vid):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=cm.id, target_id=couple_img.id))
        s.add(Edge(board_id=b.id, source_id=cf.id, target_id=couple_img.id))
        s.add(Edge(board_id=b.id, source_id=couple_img.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        captured["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(vid_id)
    sp = captured["system_prompt"] or ""
    user = captured["prompt"] or ""
    # Multi-subject video clause must be active: per-subject anti-freeze,
    # natural co-presence over synchronized choreography.
    assert "MULTI-SUBJECT MODE" in sp
    assert "PER SUBJECT" in sp
    assert "synchronized choreography" in sp
    # Subjects are addressed positionally now (`ref_image_N`), not by
    # internal shortId.
    assert "REFERENCE BY POSITION" in sp
    assert "ref_image_N" in sp
    # User message reports the count detected; the `ref_image_N` labels
    # already on the records above carry the binding.
    assert "DISTINCT SUBJECTS DETECTED: 2 people" in user
    # Internal shortIds must NOT leak — they look like @-handles to
    # Google's content classifier.
    assert "#cvm1" not in user and "#cvf1" not in user


@pytest.mark.asyncio
async def test_auto_prompt_video_solo_skips_multi_subject_clause(
    client, monkeypatch
):
    """Regression: a solo source (1 character → image → video) must NOT
    pick up the multi-subject clause."""
    with get_session() as s:
        b = Board(name="solo-vid")
        s.add(b); s.commit(); s.refresh(b)
        ch = Node(
            board_id=b.id, short_id="svch", type="character",
            x=0, y=0, w=240, h=180,
            data={"title": "P", "aiBrief": "person",
                  "mediaId": "uuuuuuuu-svch-1111-1111-111111111111"},
            status="done",
        )
        img = Node(
            board_id=b.id, short_id="svim", type="image",
            x=0, y=0, w=240, h=180,
            data={"title": "Shot", "aiBrief": "studio portrait",
                  "mediaId": "uuuuuuuu-svim-1111-1111-111111111111"},
            status="done",
        )
        vid = Node(
            board_id=b.id, short_id="svvi", type="video",
            x=0, y=0, w=240, h=180,
            data={"title": "Clip"},
            status="idle",
        )
        s.add_all([ch, img, vid]); s.commit()
        for n in (ch, img, vid):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=ch.id, target_id=img.id))
        s.add(Edge(board_id=b.id, source_id=img.id, target_id=vid.id))
        s.commit()
        vid_id = vid.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        captured["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(vid_id)
    sp = captured["system_prompt"] or ""
    assert "MULTI-SUBJECT MODE" not in sp
    assert "DISTINCT SUBJECTS DETECTED" not in (captured["prompt"] or "")


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

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        # Verify the prompt mentions the title even with no upstream.
        assert "red sneaker" in prompt.lower()
        return "studio photo of a red sneaker on white background"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
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

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
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


@pytest.mark.asyncio
async def test_auto_prompt_batch_returns_distinct_prompts(client, monkeypatch):
    """Batch mode asks Claude for a JSON array of N pose-distinct prompts
    so each variant renders a different stance instead of N seeds of one."""
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system_prompt"] = system_prompt
        return (
            '[\n'
            '  "Editorial photo, Korean woman, both hands in pockets, hip pop",\n'
            '  "Editorial photo, Korean woman, hand-on-hip three-quarter angle",\n'
            '  "Editorial photo, Korean woman, arms casually crossed, head tilt",\n'
            '  "Editorial photo, Korean woman, walking towards camera mid-stride"\n'
            ']'
        )

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt_batch(ids["target_id"], 4)
    assert isinstance(out, list)
    assert len(out) == 4
    assert all("Korean woman" in p for p in out)
    # All four poses must be distinct.
    assert len(set(out)) == 4
    # System prompt should mention batch + JSON array
    sp = (captured["system_prompt"] or "").lower()
    assert "json array" in sp
    assert "batch mode" in sp
    assert "exactly 4" in sp


@pytest.mark.asyncio
async def test_auto_prompt_batch_count_1_falls_through_to_single(client, monkeypatch):
    """count=1 should reuse the single-prompt path for efficiency."""
    ids = _seed_board_with_chain()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        # Single auto_prompt path returns a plain string, not JSON
        return "single prompt result"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt_batch(ids["target_id"], 1)
    assert out == ["single prompt result"]


@pytest.mark.asyncio
async def test_auto_prompt_batch_strips_markdown_fences(client, monkeypatch):
    """Claude sometimes wraps JSON in ```json fences despite instructions."""
    ids = _seed_board_with_chain()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        return '```json\n["a", "b"]\n```'

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt_batch(ids["target_id"], 2)
    assert out == ["a", "b"]


@pytest.mark.asyncio
async def test_auto_prompt_batch_pads_short_response(client, monkeypatch):
    """If Claude returns fewer prompts than requested, pad by repeating
    the last so the dispatch still has count items."""
    ids = _seed_board_with_chain()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        return '["only-one"]'

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt_batch(ids["target_id"], 3)
    assert out == ["only-one", "only-one", "only-one"]


def test_route_auto_batch_passes_through(client, monkeypatch):
    """POST /api/prompt/auto-batch returns the array unchanged."""
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub(node_id, count, *, camera=None):
        captured["count"] = count
        return [f"prompt-{i}" for i in range(count)]

    monkeypatch.setattr(prompt_synth, "auto_prompt_batch", stub)
    r = client.post(
        "/api/prompt/auto-batch",
        json={"node_id": ids["target_id"], "count": 4},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["prompts"]) == 4
    assert captured["count"] == 4


def test_route_auto_batch_rejects_bad_count(client):
    r = client.post(
        "/api/prompt/auto-batch",
        json={"node_id": 1, "count": 0},
    )
    assert r.status_code == 400


def test_route_502_on_synth_failure(client, monkeypatch):
    async def stub(node_id, *, camera=None):
        raise prompt_synth.PromptSynthError("auto-prompt provider failed: timeout")

    monkeypatch.setattr(prompt_synth, "auto_prompt", stub)
    r = client.post("/api/prompt/auto", json={"node_id": 1})
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_prompt_wins_over_aibrief(client, monkeypatch):
    """Prompt-first rule: when an upstream node carries BOTH a typed
    `prompt` and a vision-derived `aiBrief`, the synthesiser must use
    `prompt`. Vision becomes redundant once the user (or auto-prompt)
    has stamped a prompt onto the node — that text is the source of
    truth for downstream synth, regardless of what vision wrote."""
    with get_session() as s:
        b = Board(name="prompt-wins")
        s.add(b); s.commit(); s.refresh(b)
        upstream = Node(
            board_id=b.id, short_id="pwup", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Hero",
                "prompt": "AUTHORITATIVE-PROMPT-TEXT detail walking on Tokyo street",
                "aiBrief": "STALE-VISION-DESCRIPTION studio backdrop with cardboard",
                "mediaId": "uuuuuuuu-pwup-1111-1111-111111111111",
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="pwtg", type="video",
            x=0, y=0, w=240, h=180, data={"title": "Motion"},
            status="idle",
        )
        s.add_all([upstream, target]); s.commit()
        s.refresh(upstream); s.refresh(target)
        s.add(Edge(board_id=b.id, source_id=upstream.id, target_id=target.id))
        s.commit()
        tgt_id = target.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        return "Hold the gaze, slight weight shift"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(tgt_id)
    user = captured["prompt"] or ""

    assert "AUTHORITATIVE-PROMPT-TEXT" in user
    assert "STALE-VISION-DESCRIPTION" not in user


@pytest.mark.asyncio
async def test_aibrief_used_when_no_prompt(client, monkeypatch):
    """Upload-only fallback: a node that has media + aiBrief but NO
    prompt (e.g. raw uploaded photo with vision auto-described it) must
    still surface aiBrief into the synth context. Otherwise upload-only
    nodes contribute nothing and downstream prompts go generic."""
    with get_session() as s:
        b = Board(name="brief-fallback")
        s.add(b); s.commit(); s.refresh(b)
        upstream = Node(
            board_id=b.id, short_id="bfup", type="visual_asset",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Uploaded jacket",
                "aiBrief": "BRIEF-FALLBACK navy tweed double-breasted blazer",
                "mediaId": "uuuuuuuu-bfup-1111-1111-111111111111",
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="bftg", type="image",
            x=0, y=0, w=240, h=180, data={"title": "Hero shot"},
            status="idle",
        )
        s.add_all([upstream, target]); s.commit()
        s.refresh(upstream); s.refresh(target)
        s.add(Edge(board_id=b.id, source_id=upstream.id, target_id=target.id))
        s.commit()
        tgt_id = target.id

    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        return "Editorial portrait in navy blazer"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt(tgt_id)
    user = captured["prompt"] or ""

    assert "BRIEF-FALLBACK" in user


# ── Storyboard planner ────────────────────────────────────────────────────
# Plan: .omc/plans/storyboard-image-node.md §6.2.
# auto_prompt_storyboard() composes a continuity tree in ONE LLM call,
# returning {"prompts": [str * count], "parents": [int|None * count]}.

import json as _json  # noqa: E402  (local alias to avoid clashing with module-scope)


def _seed_storyboard_target(narrative_seed: str = "") -> int:
    """Create a Board with one upstream character + one Storyboard target.
    Returns the storyboard target node id."""
    with get_session() as s:
        b = Board(name="sb")
        s.add(b); s.commit(); s.refresh(b)
        char = Node(
            board_id=b.id, short_id="sbch", type="character",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Model",
                "aiBrief": "young Vietnamese woman, neutral expression, dark hair",
                "mediaId": "uuuuuuuu-sbch-1111-2222-333333333333",
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="sbtg", type="Storyboard",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Story",
                "narrativeSeed": narrative_seed,
            },
            status="idle",
        )
        s.add_all([char, target]); s.commit()
        for n in (char, target):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=char.id, target_id=target.id))
        s.commit()
        return target.id


@pytest.mark.asyncio
async def test_storyboard_addendum_present_batch_suffix_absent(
    client, monkeypatch
):
    """The storyboard call must use _STORYBOARD_SUFFIX, NOT _BATCH_SUFFIX
    — the variant pose-distinct addendum is the wrong objective for a
    narrative sequence."""
    tgt = _seed_storyboard_target(narrative_seed="unbox + try-on at home")
    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["system"] = system_prompt or ""
        return _json.dumps({
            "prompts": ["a", "b", "c", "d"],
            "parents": [None, 0, 1, 2],
        })

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    await prompt_synth.auto_prompt_storyboard(
        tgt, count=4, narrative_seed="unbox + try-on at home"
    )

    sysp = captured["system"]
    assert "STORYBOARD MODE" in sysp
    assert "BATCH MODE" not in sysp
    # Narrative seed gets injected into the suffix as a hint.
    assert "unbox + try-on at home" in sysp


@pytest.mark.asyncio
async def test_storyboard_returns_object_with_prompts_and_parents(
    client, monkeypatch
):
    tgt = _seed_storyboard_target()
    payload = {
        "prompts": [
            "Beat 1 — establishing shot",
            "Beat 2 — package appears",
            "Beat 3 — opens package",
            "Beat 4 — tries on jacket",
            "Beat 5 — selfie",
            "Beat 6 — exterior wide",
            "Beat 7 — café window",
            "Beat 8 — crosswalk",
        ],
        "parents": [None, 0, 1, 2, 3, None, 5, 6],
    }

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        return _json.dumps(payload)

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt_storyboard(tgt, count=8)

    assert isinstance(out, dict)
    assert out["prompts"] == payload["prompts"]
    assert out["parents"] == payload["parents"]


@pytest.mark.asyncio
async def test_storyboard_strips_markdown_fences(client, monkeypatch):
    """Some providers wrap JSON in ```json fences despite the instruction
    to skip preamble — the parser must strip them like auto_prompt_batch."""
    tgt = _seed_storyboard_target()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        return (
            "```json\n"
            + _json.dumps({"prompts": ["a", "b"], "parents": [None, 0]})
            + "\n```"
        )

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt_storyboard(tgt, count=2)
    assert out == {"prompts": ["a", "b"], "parents": [None, 0]}


@pytest.mark.asyncio
async def test_storyboard_rejects_parents_zero_non_null(client, monkeypatch):
    tgt = _seed_storyboard_target()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        return _json.dumps({"prompts": ["a", "b"], "parents": [0, 0]})

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    with pytest.raises(prompt_synth.PromptSynthError, match="parents\\[0\\]"):
        await prompt_synth.auto_prompt_storyboard(tgt, count=2)


@pytest.mark.asyncio
async def test_storyboard_rejects_parent_out_of_range(client, monkeypatch):
    tgt = _seed_storyboard_target()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        # parents[2] = 5 violates parents[k] < k
        return _json.dumps({"prompts": ["a", "b", "c"], "parents": [None, 0, 5]})

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    with pytest.raises(prompt_synth.PromptSynthError, match="parents\\[2\\]"):
        await prompt_synth.auto_prompt_storyboard(tgt, count=3)


@pytest.mark.asyncio
async def test_storyboard_rejects_length_mismatch(client, monkeypatch):
    tgt = _seed_storyboard_target()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        # len(prompts)=4 but len(parents)=3 — mismatch
        return _json.dumps({
            "prompts": ["a", "b", "c", "d"],
            "parents": [None, 0, 1],
        })

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    with pytest.raises(prompt_synth.PromptSynthError, match="length mismatch"):
        await prompt_synth.auto_prompt_storyboard(tgt, count=4)


@pytest.mark.asyncio
async def test_storyboard_rejects_count_out_of_range(client, monkeypatch):
    tgt = _seed_storyboard_target()
    # No need to stub — count check fires before any LLM call
    with pytest.raises(prompt_synth.PromptSynthError, match="1\\.\\.8"):
        await prompt_synth.auto_prompt_storyboard(tgt, count=0)
    with pytest.raises(prompt_synth.PromptSynthError, match="1\\.\\.8"):
        await prompt_synth.auto_prompt_storyboard(tgt, count=9)


@pytest.mark.asyncio
async def test_storyboard_rejects_non_object_response(client, monkeypatch):
    tgt = _seed_storyboard_target()

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        # Returns an array (the BATCH shape) instead of an object.
        return _json.dumps(["a", "b"])

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    with pytest.raises(prompt_synth.PromptSynthError, match="not a JSON object"):
        await prompt_synth.auto_prompt_storyboard(tgt, count=2)

# === I2I structured command builder (Omni agent flow) ===
# Validates the per-refType action-clause templates and the conditional
# [NEGATIVE DIRECTIVE] block appended for pose / material / texture refs.

BASE_PREFIX = (
    "Based on the provided input images, perform a precise attribute "
    "synthesis onto the primary subject from the main upload node "
    "(defined as ref_image_1). You must strictly isolate attributes "
    "and enforce the following rules:"
)
NEGATIVE_DIRECTIVE = "[NEGATIVE DIRECTIVE]:"


def _seed_i2i_board(*, ref_type: str, ref_brief: str) -> dict:
    """Build base image + single add_reference upstream into a target
    image node. ref_type controls the add_reference refType.
    """
    with get_session() as s:
        b = Board(name="i2i")
        s.add(b); s.commit(); s.refresh(b)
        base = Node(
            board_id=b.id, short_id="base", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Base subject",
                "aiBrief": "anime girl with crop top and arm markings",
                "mediaId": "uuuuuuuu-base-0001-0001-000000000001",
            },
            status="done",
        )
        ref = Node(
            board_id=b.id, short_id="refr", type="add_reference",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Reference",
                "refType": ref_type,
                "aiBrief": ref_brief,
                "mediaId": "uuuuuuuu-refr-0002-0002-000000000002",
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="trgt", type="image",
            x=0, y=0, w=240, h=180, data={"title": "Output"},
            status="idle",
        )
        s.add_all([base, ref, target]); s.commit()
        for n in (base, ref, target):
            s.refresh(n)
        s.add(Edge(board_id=b.id, source_id=base.id, target_id=target.id))
        s.add(Edge(board_id=b.id, source_id=ref.id, target_id=target.id))
        s.commit()
        return {"target_id": target.id}


async def _run_i2i(target_id: int, monkeypatch) -> str:
    async def stub_run(*args, **kwargs):
        raise AssertionError("run_llm must not be called on I2I path")
    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    return await prompt_synth.auto_prompt(target_id)


@pytest.mark.asyncio
async def test_i2i_pose_injects_camera_rule_with_brief(client, monkeypatch):
    """Pose clause must inject the brief behind the CRITICAL CAMERA RULE
    so Omni inherits the framing (low angle, full-body, ...). The FILTER
    sentence still keeps it from drawing peripheral props, and the
    [NEGATIVE DIRECTIVE] block remains the second guardrail."""
    ids = _seed_i2i_board(
        ref_type="pose",
        ref_brief="low-angle hero shot, full-body, contrapposto stance",
    )
    out = await _run_i2i(ids["target_id"], monkeypatch)
    assert out.startswith(BASE_PREFIX)
    assert "- Adopt ONLY the underlying skeletal pose, posture, body mechanics, and weight distribution from ref_image_2" in out
    # Camera rule + brief must appear in the clause (not just the
    # negative directive block).
    clauses_section = out.split("[NEGATIVE DIRECTIVE]")[0]
    assert "CRITICAL CAMERA RULE" in clauses_section
    assert "low angle" in clauses_section  # examples list mentions "low angle"
    assert "low-angle hero shot, full-body, contrapposto stance" in clauses_section
    # Per-clause FILTER (not the multi-line CRITICAL FILTER from earlier
    # revisions) keeps prop-stripping in place.
    assert "FILTER: Ignore all characters, clothing, weapons, hats" in clauses_section
    # Negative directive must still be appended for pose refs.
    assert NEGATIVE_DIRECTIVE in out
    # Old "transform the material" wording must be gone.
    assert "transform the material" not in out


def test_i2i_pose_without_brief_uses_fallback_clause():
    """When the pose ref has no brief / prompt / title, the fallback
    clause kicks in (camera+framing language, no "CRITICAL CAMERA RULE"
    block). Tested via the helper directly so we do not have to fight
    the DB-seed fixture default title."""
    class _T:
        data = {}

    records = [
        {"type": "image", "has_media": True, "ref_index": 1, "brief": "base subject"},
        {"type": "add_reference", "refType": "pose", "ref_index": 2,
         "brief": None, "prompt": None, "title": None},
    ]
    out = prompt_synth._try_i2i_direct_concat(records, _T())
    assert out is not None
    assert out.startswith(BASE_PREFIX)
    assert (
        "- Adopt ONLY the underlying skeletal pose, posture, and weight "
        "distribution from ref_image_2, while matching its exact camera "
        "perspective and framing."
    ) in out
    # No brief -> fallback clause must NOT contain the verbose
    # CRITICAL CAMERA RULE wording.
    assert "CRITICAL CAMERA RULE" not in out
    assert NEGATIVE_DIRECTIVE in out


@pytest.mark.asyncio
async def test_i2i_lighting_uses_slot_and_brief_no_negative(client, monkeypatch):
    """Lighting clause must reference the slot and include the brief.
    Negative directive must NOT be appended for lighting-only upstream."""
    ids = _seed_i2i_board(
        ref_type="lighting",
        ref_brief="upper-right rim, somber high-contrast, charcoal vignette",
    )
    out = await _run_i2i(ids["target_id"], monkeypatch)
    assert out.startswith(BASE_PREFIX)
    assert "- Apply the exact 3D lighting direction, key-light setup, shadow falloff, and studio atmosphere from ref_image_2" in out
    assert "upper-right rim, somber high-contrast, charcoal vignette" in out
    # Lighting-only: no negative directive needed.
    assert NEGATIVE_DIRECTIVE not in out


@pytest.mark.asyncio
async def test_i2i_texture_uses_slot_and_maintains_identity(client, monkeypatch):
    """Texture clause must reference the slot, include the brief, and
    contain the identity-preservation phrase. Negative directive must
    be appended for texture/material refs."""
    ids = _seed_i2i_board(
        ref_type="texture",
        ref_brief="translucent cyan-blue crystal, glassy finish, glowing sub-surface light",
    )
    out = await _run_i2i(ids["target_id"], monkeypatch)
    assert out.startswith(BASE_PREFIX)
    assert "- Completely transform and re-render its surface material using the texture definition from ref_image_2" in out
    assert "while strictly maintaining the underlying shapes and identity of ref_image_1" in out
    assert "translucent cyan-blue crystal" in out
    assert NEGATIVE_DIRECTIVE in out


@pytest.mark.asyncio
async def test_i2i_multi_ref_pose_lighting_texture(client, monkeypatch):
    """Full 3-ref case: pose (ref_image_2) + lighting (ref_image_3) +
    texture (ref_image_4). Each clause must use its own slot label and
    verb. Negative directive must appear exactly once at the end."""
    with get_session() as s:
        b = Board(name="i2i-multi"); s.add(b); s.commit(); s.refresh(b)
        base = Node(
            board_id=b.id, short_id="base", type="image",
            x=0, y=0, w=240, h=180,
            data={
                "title": "Base",
                "aiBrief": "anime girl with crop top",
                "mediaId": "uuuuuuuu-base-0001-0001-000000000001",
            },
            status="done",
        )
        pose_node = Node(
            board_id=b.id, short_id="pose", type="add_reference",
            x=0, y=0, w=240, h=180,
            data={
                "refType": "pose",
                "aiBrief": "contrapposto with sword overhead",
                "mediaId": "uuuuuuuu-pose-0002-0002-000000000002",
            },
            status="done",
        )
        light_node = Node(
            board_id=b.id, short_id="lit_", type="add_reference",
            x=0, y=0, w=240, h=180,
            data={
                "refType": "lighting",
                "aiBrief": "upper-right rim, amber fill, deep shadows",
                "mediaId": "uuuuuuuu-lit_-0003-0003-000000000003",
            },
            status="done",
        )
        tex_node = Node(
            board_id=b.id, short_id="tex_", type="add_reference",
            x=0, y=0, w=240, h=180,
            data={
                "refType": "texture",
                "aiBrief": "desaturated steel-and-bone tones, crisp specular",
                "mediaId": "uuuuuuuu-tex_-0004-0004-000000000004",
            },
            status="done",
        )
        target = Node(
            board_id=b.id, short_id="trgt", type="image",
            x=0, y=0, w=240, h=180, data={"title": "Output"},
            status="idle",
        )
        s.add_all([base, pose_node, light_node, tex_node, target]); s.commit()
        for n in (base, pose_node, light_node, tex_node, target):
            s.refresh(n)
        for src_node in (base, pose_node, light_node, tex_node):
            s.add(Edge(board_id=b.id, source_id=src_node.id, target_id=target.id))
        s.commit()
        target_id = target.id

    out = await _run_i2i(target_id, monkeypatch)
    assert out.startswith(BASE_PREFIX)
    assert "ref_image_2" in out
    assert "ref_image_3" in out
    assert "ref_image_4" in out
    # Pose clause now uses CRITICAL CAMERA RULE + FILTER (split into
    # two sentences) so we assert both pieces.
    assert "CRITICAL CAMERA RULE" in out
    assert "FILTER: Ignore all characters, clothing, weapons, hats" in out
    assert "upper-right rim" in out
    assert "desaturated steel-and-bone" in out
    assert out.count(NEGATIVE_DIRECTIVE) == 1
    assert out.endswith("isolated mechanics of references.")


@pytest.mark.asyncio
async def test_i2i_skipped_when_no_add_reference(client, monkeypatch):
    """Pure character + visual_asset upstream (no add_reference) keeps
    going through the regular Claude prose-synthesis path."""
    ids = _seed_board_with_chain()
    captured: dict = {}

    async def stub_run(feature, prompt, *, system_prompt=None, timeout=0):
        captured["prompt"] = prompt
        return "Photoreal studio shot of a Korean woman wearing a white t-shirt"

    monkeypatch.setattr(prompt_synth, "run_llm", stub_run)
    out = await prompt_synth.auto_prompt(ids["target_id"])
    assert "prompt" in captured, "non-I2I path must call run_llm"
    assert "Korean woman" in out
