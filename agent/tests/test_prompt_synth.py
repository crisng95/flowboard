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
