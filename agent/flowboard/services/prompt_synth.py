"""Auto-prompt synthesizer.

Given a target node, walks the immediate-upstream graph, collects
``aiBrief`` text from each parent node, and asks the configured
Auto-Prompt provider to compose a single image-generation prompt that
combines them. Used when the user clicks Generate without typing a
prompt.

Provider routing goes through ``run_llm("auto_prompt", ...)``. User picks
which one in Settings → AI Providers; default is Claude.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Edge, Node
from flowboard.services.activity import record_activity
from flowboard.services.llm import run_llm
from flowboard.services.llm.base import LLMError

logger = logging.getLogger(__name__)


_SYNTH_SYSTEM_IMAGE = (
    "You are an image-generation prompt builder for a fashion / e-commerce "
    "media pipeline. Output ONE concise sentence (max 280 chars) for a "
    "photoreal shot combining the input briefs.\n\n"
    "POSE — every shot must look like a real editorial / lookbook photo:\n"
    "  • GAZE: the model's eyes MUST ENGAGE THE CAMERA — direct eye "
    "contact with the lens. No looking-away, no eyes-closed, no "
    "over-the-shoulder backshots, no profile-only poses. The face is "
    "always turned to camera.\n"
    "  • EXPRESSION — CRITICAL: NEUTRAL CLOSED-MOUTH expression at all "
    "times. NO smiling, NO teeth visible, NO laughing, NO open mouth. A "
    "very soft, almost-imperceptible curl of the lips is the maximum. "
    "This is non-negotiable — open-mouth smiles get warped by Veo i2v "
    "downstream and cause face-identity drift across the clip. Use "
    "phrases like 'composed neutral expression', 'closed-mouth confident "
    "look', 'lips together'.\n"
    "  • STANCE — pick ONE from this pool (rotate so generations stay "
    "diverse, do not repeat the same stance):\n"
    "    · both hands in pockets, weight on one leg, slight hip pop\n"
    "    · one hand brushing the collar / sleeve / hem of the garment\n"
    "    · hand-on-hip, body angled three-quarters to camera\n"
    "    · arms casually crossed at the chest, head tilted slightly\n"
    "    · hand running through hair, head turned slightly to the side\n"
    "    · one hand resting at the side of the face, playful or pensive\n"
    "    · walking towards camera mid-stride, casual confidence\n"
    "    · leaning weight on one hip with thumbs hooked into pockets\n"
    "  • BODY ANGLE: pick straight-on, three-quarter, or slight side — "
    "as long as the face stays toward camera.\n"
    "  • ATTITUDE: confident, charismatic, distinctive personality and "
    "presence (model 'aura'). Never stiff or generic.\n\n"
    "When a product / wardrobe asset is in the inputs AND no location "
    "reference is present, the chosen pose must make the GARMENT the "
    "visual hero — knees-up or full upper-body framing. When a location "
    "reference IS present, balance the framing: the garment stays "
    "readable but the environment must be visible in frame (wider shot, "
    "knees-up to full-body so the setting reads).\n\n"
    "Style: photoreal editorial fashion photography, sharp focus, soft "
    "even key light. BACKGROUND PRIORITY — if any reference image's "
    "brief describes an environment, location, or scene (e.g. 'park', "
    "'street', 'café', 'jogging path', 'interior room', 'beach'), USE "
    "that environment as the background of the shot: place the subject "
    "INTO that scene with matching natural light, perspective, and depth "
    "of field. Do NOT default to studio when a location reference exists "
    "in the inputs. Only fall back to a neutral indoor/studio background "
    "when zero location/scene references exist upstream. No marketing "
    "language, no preamble — output the prompt only."
)

# Appended to the image system prompt when the upstream graph contains
# 2+ distinct people (multiple character nodes, or image siblings each
# wrapping a different character grandparent — e.g. couple shots, group
# look-books). Without this clause the synthesiser writes a single-subject
# prompt and Flow can only honour one of the N reference images.
_MULTI_SUBJECT_CLAUSE = (
    "\n\nMULTI-SUBJECT MODE — CRITICAL: This shot contains MULTIPLE "
    "distinct people. The upstream context lists every reference image "
    "with a `ref_image_N` label. Compose ALL subjects into a single "
    "couple/group scene where every person appears in frame:\n"
    "  • REFERENCE BY POSITION: name each subject by their `ref_image_N` "
    "label (e.g. 'ref_image_1 standing on the left, ref_image_2 on the "
    "right') so Flow can bind each person to the correct input image. "
    "NEVER replace `ref_image_N` with generic descriptors like 'an East "
    "Asian man'.\n"
    "  • ARRANGEMENT: side-by-side, slightly turned toward each other, or "
    "natural couple/group composition. Every subject must be fully "
    "visible — no one cropped or hidden behind another.\n"
    "  • POSE & GAZE rules apply to EACH subject — every face engages the "
    "camera; every expression neutral closed-mouth.\n"
    "  • COMPLEMENTARY STANCES: each subject picks a DIFFERENT gesture "
    "from the stance pool — never repeat the same stance across subjects.\n"
    "  • CONTACT: light natural couple-style contact is allowed (a hand "
    "on the other's shoulder, leaning slightly toward each other) but "
    "never invasive.\n"
    "  • FRAMING: full upper-body or knees-up framing — wider than a "
    "single-subject shot — so all faces and any product stay in frame.\n"
    "  • CHAR LIMIT: up to 400 chars for multi-subject scenes (overrides "
    "the 280 cap) since each subject needs description."
)

# Intent-first motion direction. The earlier version prescribed scene→
# action vocab + mandatory 3-beat structure + action-verb-only language,
# which made every clip feel theatrical and "model executing a pose pool".
# This rewrite gives Claude the safety floor (Veo's anti-freeze need) and
# trusts it to pick natural, character-driven motion that fits the scene
# instead of rotating through canned gestures.
_SYNTH_VIDEO_CORE = (
    "You are a video-motion prompt builder for an i2v pipeline (8-second "
    "clip, Veo-style). The source still is the first frame — describe "
    "what unfolds across the next 8 seconds.\n\n"
    "INTENT FIRST. Look at the source: who is this person, what are "
    "they feeling, what would they naturally do in this moment? Let "
    "that drive the motion. The subject is a person with interiority, "
    "not a fashion model executing a pose pool.\n\n"
    "ANTI-FREEZE (safety floor only): Veo locks onto frame 0 if the "
    "prompt is too passive. SOMETHING visible must change between "
    "frame 0 and frame 8 — but it can be as small as a half-blink, a "
    "weight shift, a gaze drifting to the lens and back, or fabric "
    "catching a breeze. What fails is adjective-only direction "
    "without a concrete change attached: 'gentle softness' alone "
    "freezes; 'a slight weight shift, eyes settling on the lens' "
    "doesn't.\n\n"
    "PERFORMANCE notes — apply when they fit, ignore when they don't:\n"
    "  • Match the energy of the source. A poised studio portrait "
    "wants a held gaze with a tiny weight shift, not a runway pose "
    "change. A walking street shot wants forward momentum.\n"
    "  • Stillness is valid. A 6-second held moment with one small "
    "shift at the end can read more powerful than three beats of "
    "action stacked.\n"
    "  • Don't pile gestures. One real motion that carries weight "
    "beats three checklist gestures.\n"
    "  • Body language must read as in-character. The choice 'what "
    "does this person do next' should feel like THEIR choice, not the "
    "prompt-writer's.\n\n"
    "STRUCTURE is free. Use time-coded beats (e.g. 0-3s / 3-6s / 6-8s) "
    "when the scene calls for sequenced action. Use a single continuous "
    "direction when the scene calls for sustained presence. Pick what "
    "fits — don't default to either.\n\n"
    "ALWAYS include: natural blinks throughout, soft fabric and hair "
    "drift. These ground the clip without adding theatrical motion.\n\n"
    "AUDIO — Veo generates sound, and that audio passes a content "
    "filter (`PUBLIC_MIRROR_AUDIO_FILTER`) that REJECTS the entire "
    "request when speech is generated over faces resembling real "
    "people. Most Flowboard scenes are portraits, so default hard to "
    "silent:\n"
    "  • SILENT BY DEFAULT: no spoken dialogue, no voice-over, no "
    "lip-sync, no singing, no humming, no whispering. Mouths stay "
    "neutral closed-mouth.\n"
    "  • SFX: only generic low-volume ambient cues that match the "
    "setting (room tone, fabric rustle, light footsteps, soft "
    "breeze). Keep it minimal — no effects-heavy soundscape.\n"
    "  • MUSIC: optional soft restrained background — lo-fi, ambient "
    "pad, gentle piano — at low volume. Never lyrical, never a "
    "recognisable melody, never high-energy.\n"
    "  • EXCEPTION: only when the user prompt EXPLICITLY asks for "
    "dialogue or singing should the clip include speech, and even "
    "then keep the audio direction generic (no specific accent / "
    "voice characteristic / impersonation) to keep filter risk low.\n\n"
    "No scene cuts, no text overlays. Max 400 chars. Output the "
    "motion prompt only — no preamble."
)

# Appended to the video system prompt when the source frame contains
# 2+ distinct people (couple/group shots). Without this, the synth
# directs "the subject" singular and Veo typically freezes one person
# while animating the other.
_MULTI_SUBJECT_VIDEO_CLAUSE = (
    "\n\nMULTI-SUBJECT MODE: The source frame contains MULTIPLE distinct "
    "people. Direct each subject independently — natural co-presence "
    "beats synchronized choreography:\n"
    "  • Each subject performs their own motion. Don't force both/all "
    "to lean / turn / glance at the same time — that reads staged.\n"
    "  • Subjects may acknowledge each other: a glance, a soft micro-"
    "smile (still closed-mouth), light contact (a hand drifting toward "
    "the other's shoulder, a slight lean toward each other). Or they "
    "may simply co-exist, each in their own moment. Both are valid.\n"
    "  • ANTI-FREEZE applies PER SUBJECT: at minimum a blink or subtle "
    "shift for every person between frame 0 and frame 8. No one frozen "
    "while another moves.\n"
    "  • REFERENCE BY POSITION: when directing actions, name each "
    "subject by their `ref_image_N` label (e.g. 'ref_image_1 turns "
    "slightly toward ref_image_2; ref_image_2 holds her gaze on the "
    "lens'). Never replace `ref_image_N` with generic descriptors.\n"
    "  • Char limit bumps to 540 for multi-subject — each person needs "
    "their own direction."
)

_SYNTH_SYSTEM_VIDEO_DEFAULT = (
    _SYNTH_VIDEO_CORE
    + "\n\nCamera: subtle dolly or pan is allowed if it fits the scene, "
    "but subject motion is the main story."
)

# Camera-aware variant. When the user picked `static` (e.g. for e-commerce
# product shots) the synthesiser MUST NOT propose dolly/zoom/pan moves —
# only subject-side motion. The model is still expected to perform a
# multi-beat pose sequence; static refers to the CAMERA only, not the
# subject.
_SYNTH_SYSTEM_VIDEO_STATIC = (
    _SYNTH_VIDEO_CORE
    + "\n\nCamera: STATIC, locked-off, no zoom / pan / dolly. Keep the "
    "entire subject and product framed for the full clip."
)


def _video_system_prompt(camera: Optional[str], subject_count: int = 1) -> str:
    base = (
        _SYNTH_SYSTEM_VIDEO_STATIC if camera == "static"
        else _SYNTH_SYSTEM_VIDEO_DEFAULT
    )
    if subject_count >= 2:
        return base + _MULTI_SUBJECT_VIDEO_CLAUSE
    return base


class PromptSynthError(RuntimeError):
    pass


# Ref-source node types — the ones whose mediaId becomes a position
# entry in the request's ``imageInputs`` array. MUST match the
# frontend's ``REF_SOURCE_TYPES`` set in ``store/generation.ts`` so the
# ``ref_image_N`` numbering we hand the LLM aligns with the actual
# positional slot Flow sees on the wire.
_REF_SOURCE_TYPES = {"character", "image", "visual_asset"}


def _collect_upstream(node_id: int) -> tuple[list[dict], Optional[Node]]:
    """Return (upstream_brief_records, target_node).

    Each record carries:
      - ``type``         — node type (character / image / visual_asset / prompt / …)
      - ``shortId``      — internal node identifier (used by multi-subject
        detection; never surfaced to the LLM in the prompt body)
      - ``ref_index``    — 1-based position in the dispatched
        ``ref_media_ids`` array, or ``None`` when this record isn't a
        ref-source (prompt / note nodes) or has no media. Drives the
        ``ref_image_N`` labels in ``_format_user_message`` so the LLM
        binds subjects to the correct input image positionally.
      - ``brief / prompt / title / has_media`` — display fields
      - ``subject_chars`` — shortIds of any character one hop further up
        an ``image`` chain. Used to detect when two image siblings wrap
        different people (couple/group scenes); translated to
        ref_image labels at format time.

    Ordering: records are produced in the same edge-iteration order the
    frontend uses to build ``ref_media_ids``, so ``ref_index = 1``
    points at the first item in that array.
    """
    # Source-of-truth rule: a node's `prompt` (typed by the user OR
    # auto-generated by Claude) ALWAYS wins over its vision-derived
    # `aiBrief`. Vision is only the fallback for upload-only nodes
    # that have no prompt at all (e.g. user dropped a raw photo onto a
    # visual_asset node and never typed anything).

    with get_session() as s:
        target = s.get(Node, node_id)
        if target is None:
            return [], None
        # Order by Edge.id to match the frontend's natural insertion-
        # order walk — without this the SQLite query plan could shuffle
        # rows and break ref_index alignment with ref_media_ids.
        edges = s.exec(
            select(Edge).where(Edge.target_id == node_id).order_by(Edge.id)
        ).all()
        upstream_ids = [e.source_id for e in edges]
        records: list[dict] = []
        next_ref_index = 1  # 1-based to match user-facing "ref_image_1"
        for uid in upstream_ids:
            n = s.get(Node, uid)
            if n is None:
                continue
            data = n.data or {}
            ai_brief = data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None
            user_prompt = data.get("prompt") if isinstance(data.get("prompt"), str) else None
            # Prompt-first resolution. If the node carries a prompt, that
            # prompt is the description; aiBrief is ignored even when
            # present. Only fall back to aiBrief for upload-only nodes
            # that never received a prompt.
            brief = user_prompt or ai_brief
            subject_chars: list[str] = []
            if n.type == "image":
                gp_edges = s.exec(
                    select(Edge).where(Edge.target_id == uid).order_by(Edge.id)
                ).all()
                for ge in gp_edges:
                    gp = s.get(Node, ge.source_id)
                    if gp is not None and gp.type == "character":
                        subject_chars.append(gp.short_id)
            # Accept either the singular `mediaId` (single-variant node)
            # or the variant list `mediaIds` (multi-variant). The
            # frontend's `collectUpstreamRefMediaIds` already expands
            # `mediaIds` into the wire payload — we mirror the same
            # acceptance here so multi-variant nodes still get a
            # `ref_image_N` label even if `mediaId` happens to be unset.
            mids = data.get("mediaIds")
            has_media = bool(
                (isinstance(data.get("mediaId"), str) and data.get("mediaId"))
                or (isinstance(mids, list) and any(isinstance(m, str) and m for m in mids))
            )
            ref_index: Optional[int] = None
            if n.type in _REF_SOURCE_TYPES and has_media:
                ref_index = next_ref_index
                next_ref_index += 1
            records.append(
                {
                    "type": n.type,
                    "shortId": n.short_id,
                    "ref_index": ref_index,
                    "brief": brief if isinstance(brief, str) else None,
                    "prompt": user_prompt,
                    "title": data.get("title") if isinstance(data.get("title"), str) else None,
                    "has_media": has_media,
                    "subject_chars": subject_chars,
                }
            )
        return records, target


def _distinct_subjects(records: list[dict]) -> list[str]:
    """Ordered list of distinct character shortIds across upstream.

    Counts ``character`` nodes by their own shortId, and ``image`` nodes
    by the shortIds of their character grandparents. Order is preserved
    for deterministic prompts.
    """
    seen_set: set[str] = set()
    ordered: list[str] = []
    for r in records:
        ids: list[str] = []
        if r["type"] == "character":
            ids = [r["shortId"]]
        elif r["type"] == "image":
            ids = list(r.get("subject_chars") or [])
        for sid in ids:
            if sid and sid not in seen_set:
                seen_set.add(sid)
                ordered.append(sid)
    return ordered


def _image_system_prompt(subject_count: int) -> str:
    """Branch the image system prompt on subject count.

    1 subject → standard editorial single-model prompt.
    2+ subjects → append the multi-subject clause so Claude composes a
    couple/group shot referencing every subject by their positional
    `ref_image_N` label.
    """
    if subject_count >= 2:
        return _SYNTH_SYSTEM_IMAGE + _MULTI_SUBJECT_CLAUSE
    return _SYNTH_SYSTEM_IMAGE


def _format_user_message(records: list[dict], target: Node) -> str:
    """Render the upstream context into a compact prompt for the LLM.

    Reference images are labeled by their POSITIONAL slot
    (``ref_image_1``, ``ref_image_2``, …) instead of by internal node
    shortIds. The labels match the order of ``ref_media_ids`` Flow
    receives on the wire, so when the LLM writes "ref_image_1 stands
    on the left, ref_image_2 on the right" the model resolves each to
    the correct input image. Earlier versions emitted ``#shortId``
    tokens directly into the prompt — Flow doesn't parse them, and
    they correlated with false-positive
    ``PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED`` rejections from
    Google's content classifier (the tokens look like @-handles).
    """
    # Translation map: shortId → "ref_image_N" label, for any node that
    # has been assigned a ref position. Used to rewrite the
    # `subject_chars` annotation on image records ("same subject as
    # ref_image_1" instead of "embodies character: #abcd").
    label_for_short_id: dict[str, str] = {}
    for r in records:
        if r.get("ref_index"):
            label_for_short_id[r["shortId"]] = f"ref_image_{r['ref_index']}"

    by_type: dict[str, list[str]] = {}
    for r in records:
        # Prefer the AI-generated brief; fall back to the user-typed prompt
        # or title so a node with no brief still contributes something.
        text = r["brief"] or r["prompt"] or r["title"] or "(no description)"

        # Cross-reference an image record to the character it embodies,
        # if that character is also upstream as a ref. Translates each
        # grandparent shortId to its ref_image label; characters not in
        # the current ref set are silently dropped (they're context-only,
        # not bindable).
        suffix = ""
        if r["type"] == "image" and r.get("subject_chars"):
            translated = [
                label_for_short_id[c]
                for c in r["subject_chars"]
                if c in label_for_short_id
            ]
            if translated:
                suffix = f"  [same subject as {', '.join(translated)}]"

        ref_index = r.get("ref_index")
        if ref_index is not None:
            line = f"ref_image_{ref_index}: {text}{suffix}"
        else:
            # Non-ref records (prompt / note nodes — no media to bind).
            # Render without a label since there's no positional slot
            # for the LLM to reference.
            line = f"- {text}"
        by_type.setdefault(r["type"], []).append(line)

    parts: list[str] = []
    if by_type.get("character"):
        parts.append("Subject(s) (character):\n  - " + "\n  - ".join(by_type["character"]))
    if by_type.get("visual_asset"):
        parts.append(
            "Product / wardrobe / object (visual_asset):\n  - "
            + "\n  - ".join(by_type["visual_asset"])
        )
    if by_type.get("image"):
        parts.append("Reference image(s):\n  - " + "\n  - ".join(by_type["image"]))
        # Without this hint, the synthesiser defaults to "studio" even when
        # one of the upstream images is clearly a location/scene reference
        # (e.g. user attaches an outdoor jogging-path photo as the setting).
        # Telling Claude to infer the role from the brief lets it place the
        # subject INTO the scene instead of dropping the location entirely.
        if len(by_type["image"]) >= 2:
            parts.append(
                "ROLE INFERENCE: For each reference image above, infer its "
                "role from the brief. Briefs describing people / garments / "
                "products → subject or wardrobe reference. Briefs describing "
                "places / environments / outdoor or indoor scenes → SETTING "
                "reference (use as the shot's background). Compose a single "
                "scene that places the subject INTO any setting reference "
                "present — never silently drop a location reference."
            )
    if by_type.get("prompt"):
        # Prompt nodes carry reusable style/scene direction (e.g. brand
        # tone, mood reference). Treat as authoritative styling guidance —
        # weave the direction into the output prompt rather than treating
        # it as just "more context". Note nodes stay decorative and are
        # intentionally NOT surfaced here.
        parts.append(
            "Direction / style notes (prompt nodes — apply as styling "
            "guidance):\n  - " + "\n  - ".join(by_type["prompt"])
        )

    # Surface multi-subject scenes (couple, group) so Claude switches to
    # the multi-subject system clause and composes a shared frame. The
    # count matters; the LLM uses the `ref_image_N` labels already on
    # the records above to bind each subject to its positional slot.
    subjects = _distinct_subjects(records)
    if len(subjects) >= 2:
        parts.append(
            f"DISTINCT SUBJECTS DETECTED: {len(subjects)} people. Treat "
            "as a single multi-subject scene; describe each subject's "
            "placement using the `ref_image_N` labels above."
        )

    target_data = target.data or {}
    target_title = target_data.get("title") if isinstance(target_data.get("title"), str) else None
    if target_title:
        parts.append(f"Target node title (hint): {target_title}")

    if not parts:
        # No upstream context — fall back to the node title alone.
        return f"Target: {target_title or 'image'}\n\nWrite a generic photoreal product or scene prompt."
    return "\n\n".join(parts) + "\n\nReturn only the prompt sentence."


_BATCH_SUFFIX = (
    "\n\nBATCH MODE: Output a JSON ARRAY of EXACTLY {count} distinct "
    "prompts. Each prompt MUST pick a DIFFERENT stance from the pool — "
    "no two variants may share the same gesture. Output ONLY the JSON "
    "array, no preamble, no markdown fences. Each prompt still respects "
    "the GAZE rule (face engages camera) and the char cap. Example:\n"
    "[\n"
    "  \"Editorial photo, …, both hands in pockets, …\",\n"
    "  \"Editorial photo, …, hand-on-hip three-quarter, …\",\n"
    "  …\n"
    "]"
)


async def auto_prompt_batch(
    node_id: int, count: int, *, camera: Optional[str] = None
) -> list[str]:
    """Compose N pose-distinct prompts in a single Claude call.

    Used when the user wants multiple variants of an image — a single
    prompt × N seeds produces near-identical poses. Each item in the
    returned list picks a different stance from the pool so the variants
    actually look like different shots.
    """
    if count < 1:
        raise PromptSynthError("count must be >= 1")
    if count == 1:
        single = await auto_prompt(node_id, camera=camera)
        return [single]

    records, target = _collect_upstream(node_id)
    if target is None:
        raise PromptSynthError(f"node {node_id} not found")

    is_video = target.type == "video"
    subject_count = len(_distinct_subjects(records))
    if is_video:
        base_system = _video_system_prompt(camera, subject_count)
    else:
        base_system = _image_system_prompt(subject_count)
    system_prompt = base_system + _BATCH_SUFFIX.format(count=count)
    user_msg = _format_user_message(records, target)

    async with record_activity(
        "auto_prompt_batch",
        params={"node_id": node_id, "count": count, "camera": camera},
        node_id=node_id,
    ) as activity:
        try:
            # 120s for the batch path — Gemini CLI's `-p` invocation
            # pays ~15s of subprocess + auth cold-start, then a heavy
            # multi-variant batch composition can run another 60-90s of
            # inference. The single-variant path (auto_prompt below) is
            # lighter and uses a tighter 90s ceiling. Claude Code
            # finishes the same call in 5-15s; we err on Gemini's side
            # so feature parity holds across providers.
            text = await run_llm(
                "auto_prompt", user_msg, system_prompt=system_prompt, timeout=120.0
            )
        except LLMError as exc:
            raise PromptSynthError(f"auto-prompt provider failed: {exc}") from exc

        text = (text or "").strip()
        # Strip markdown fences if the provider added them despite instructions.
        if text.startswith("```"):
            text = text.lstrip("`")
            # "json\n[...]\n```" → "[...]\n"
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.rsplit("```", 1)[0].strip()

        try:
            arr = json.loads(text)
        except json.JSONDecodeError as exc:
            raise PromptSynthError(
                f"auto-prompt provider returned non-JSON for batch: {text[:200]!r}"
            ) from exc
        if not isinstance(arr, list):
            raise PromptSynthError("auto-prompt batch response is not a JSON array")
        prompts = [str(p).strip() for p in arr if isinstance(p, str) and p.strip()]
        if not prompts:
            raise PromptSynthError("auto-prompt batch returned no valid prompts")
        # Pad / trim to requested count. If the provider returned fewer, repeat
        # the last one — better to have N items than fail the dispatch.
        while len(prompts) < count:
            prompts.append(prompts[-1])
        prompts = prompts[:count]
        activity.set_result({"prompts": prompts})
        return prompts


async def auto_prompt(node_id: int, *, camera: Optional[str] = None) -> str:
    """Compose a generation prompt by walking upstream + asking the
    configured Auto-Prompt provider.

    Branch by target type:
    - ``image`` (or anything else default) → photorealistic composition prompt
      that combines all upstream briefs.
    - ``video`` → motion/camera prompt for the single source image brief
      (i2v has exactly one upstream image — multi-ref isn't a thing). The
      ``camera`` arg (e.g. ``"static"``) selects a system-prompt variant so
      the synthesiser respects the user's framing constraint.
    """
    records, target = _collect_upstream(node_id)
    if target is None:
        raise PromptSynthError(f"node {node_id} not found")

    is_video = target.type == "video"
    subject_count = len(_distinct_subjects(records))
    if is_video:
        system_prompt = _video_system_prompt(camera, subject_count)
    else:
        system_prompt = _image_system_prompt(subject_count)
    user_msg = _format_user_message(records, target)

    async with record_activity(
        "auto_prompt",
        params={"node_id": node_id, "camera": camera},
        node_id=node_id,
    ) as activity:
        try:
            # 90s — same Gemini cold-start rationale as the batch path
            # (~15s spawn + 30-60s inference for a complex composition).
            # Single-variant is lighter than batch so a slightly tighter
            # ceiling is fine, but 30s was too aggressive.
            text = await run_llm(
                "auto_prompt",
                user_msg,
                system_prompt=system_prompt,
                timeout=90.0,
            )
        except LLMError as exc:
            raise PromptSynthError(f"auto-prompt provider failed: {exc}") from exc

        text = (text or "").strip().strip('"').strip("'")
        if not text:
            raise PromptSynthError("empty response from auto-prompt provider")
        if len(text) > 500:
            text = text[:500].rstrip() + "…"
        activity.set_result({"prompt": text})
        return text
