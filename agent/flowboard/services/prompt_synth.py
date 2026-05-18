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
# Ref-source node types — the ones whose mediaId becomes a position
# entry in the request's ``imageInputs`` array. Includes both legacy
# (character / visual_asset / image / Storyboard) and the Concepta
# fork's new types (reference / concept / multiview / part / variant
# / pose) so all of them can feed downstream concept/multiview/part
# nodes as positional refs.
_REF_SOURCE_TYPES = {
    # legacy
    "character", "image", "visual_asset", "Storyboard",
    # Concepta
    "reference", "concept", "multiview", "part", "variant", "pose",
}


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


def _format_concept_user_message(records: list[dict], target: Node) -> str:
    """Concepta-specific user message builder.

    The default `_format_user_message` is fashion-oriented: its empty
    fallback says "Write a generic photoreal product or scene prompt"
    which is exactly the wrong direction for a concept-art asset
    pipeline. The empty-upstream case here instead nudges the LLM to
    fall back on the user's `styleKey` + `typeKey` choices, which
    `subject.py` has already injected into the system prompt's
    TYPE/STYLE blocks — so the output stays a canonical asset sheet
    even when nothing is connected to the node yet.
    """
    target_data = target.data or {}
    target_title = (
        target_data.get("title") if isinstance(target_data.get("title"), str) else None
    )
    user_prompt = target_data.get("prompt")
    style_key = target_data.get("styleKey") if isinstance(target_data.get("styleKey"), str) else None
    type_key = target_data.get("typeKey") if isinstance(target_data.get("typeKey"), str) else None

    parts: list[str] = []

    # User's free-text intent (typed into the dialog or persisted on
    # the node) is the most authoritative signal. Surface it first so
    # Claude treats it as the subject brief, not "extra context".
    # Reinforce the anti-environment rule because user briefs often
    # mention habitats ("forest elf", "desert warrior") which the LLM
    # can misinterpret as a scene to render.
    if isinstance(user_prompt, str) and user_prompt.strip():
        parts.append(
            f"Subject brief (user intent):\n  {user_prompt.strip()}\n\n"
            "IMPORTANT: If the brief above mentions an environment, "
            "habitat, or setting (forest, desert, underwater, city, etc.), "
            "treat it as FLAVOUR for the character's design language — NOT "
            "as a backdrop to render. The output background MUST remain "
            "plain neutral grey (#808080). The subject stands isolated."
        )

    # Reference images, if any, are positional ref_image_N inputs that
    # Flow will bind. Same rendering logic as the legacy formatter so
    # the LLM gets familiar labels.
    if records:
        by_type: dict[str, list[str]] = {}
        for r in records:
            text = r["brief"] or r["prompt"] or r["title"] or "(no description)"
            ref_index = r.get("ref_index")
            line = (
                f"ref_image_{ref_index}: {text}"
                if ref_index is not None
                else f"- {text}"
            )
            by_type.setdefault(r["type"], []).append(line)
        if by_type.get("reference"):
            parts.append(
                "Reference inputs (textures / sketches / photos):\n  - "
                + "\n  - ".join(by_type["reference"])
            )
        # Style pack nodes carry `styleKey` only — surface as direction
        # rather than visual ref since they have no media payload.
        if by_type.get("style_pack"):
            parts.append("Style anchors:\n  - " + "\n  - ".join(by_type["style_pack"]))
        # A concept upstream means a previously-generated sheet; treat
        # it as identity reference for variants.
        if by_type.get("concept"):
            parts.append(
                "Existing concept reference(s):\n  - "
                + "\n  - ".join(by_type["concept"])
            )

    # Empty upstream + no user prompt — explicit fallback: tell the
    # LLM to lean on the system prompt's TYPE/STYLE blocks. The
    # default formatter would say "photoreal product / scene" here,
    # which is the wrong frame for asset concept art.
    if not parts:
        bits = []
        if target_title and target_title.lower() not in {"concept", "untitled"}:
            bits.append(f"the node title '{target_title}'")
        if type_key:
            bits.append(f"a {type_key} subject")
        if style_key:
            bits.append(f"in the {style_key} style")
        seed = " and ".join(bits) if bits else "a generic asset concept"
        parts.append(
            f"Subject: {seed}.\n\n"
            "There are no reference images upstream — invent a SPECIFIC "
            "subject design that fits the TYPE and STYLE blocks in the "
            "system prompt. Output a concept-sheet prompt: canonical "
            "pose, PLAIN NEUTRAL BACKGROUND (solid grey or white, NO "
            "environment, NO scene, NO ground texture, NO foliage, NO "
            "sky), design clarity. The subject stands isolated on the "
            "neutral backdrop — even if the subject is a 'forest elf' "
            "or 'desert warrior', the background is PLAIN GREY. Do NOT "
            "default to environmental scenes, matte paintings, or any "
            "scenic backdrop."
        )

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


# Storyboard mode — see .omc/plans/storyboard-image-node.md §6.2.
# Distinct from BATCH MODE: storyboard emits an OBJECT with prompts[] AND
# parents[]. parents[k] = null → root (will be gen_image'd); parents[k] = j
# (j<k) → continuation (will be edit_image'd from shots[j].mediaId), so the
# k-th prompt should describe ONLY the delta from beat j.
_STORYBOARD_SUFFIX = (
    "\n\nSTORYBOARD MODE: Output ONE JSON OBJECT with exactly these keys:\n"
    "  \"prompts\": array of EXACTLY {count} strings (≤280 chars each),\n"
    "                each describing one beat of a continuous narrative —\n"
    "                index 0 is the first beat, index {count}-1 the last.\n"
    "  \"parents\": array of EXACTLY {count} entries, each null OR an integer.\n"
    "                parents[k] = null  → beat k is a NEW SCENE/ROOT (will be\n"
    "                  generated fresh — use ONLY when location/subject/visual\n"
    "                  context legitimately changes from the prior beat).\n"
    "                parents[k] = j (0 ≤ j < k) → beat k VISUALLY CONTINUES\n"
    "                  from beat j — same room, same wardrobe, same framing\n"
    "                  carry-over. The image will be EDITED from beat j's\n"
    "                  output, so beat k's prompt MUST describe ONLY THE DELTA\n"
    "                  (e.g. \"now opens the package\", \"now wearing the shirt\")\n"
    "                  — DO NOT re-describe identity, room, lighting.\n"
    "                Constraints: parents[0] MUST be null; parents[k] < k.\n"
    "Coherence rules (every beat):\n"
    "  • SAME subject identity across the whole sequence — anchor on\n"
    "    `ref_image_1` if a person reference exists.\n"
    "  • SAME products/wardrobe wherever the narrative places them.\n"
    "  • Consistent lighting + colour palette within a continuity chain.\n"
    "Per-beat:\n"
    "  • photoreal editorial shot, GAZE engages camera, neutral closed-mouth.\n"
    "  • each beat advances the story; no two beats interchangeable.\n"
    "{narrative_seed_block}"
    "Output ONLY the JSON object — no preamble, no markdown fences. Example:\n"
    "{\n"
    "  \"prompts\": [\n"
    "    \"Editorial photo, woman in living room, hands empty, neutral pose, …\",\n"
    "    \"Same scene, woman now holds sealed brown package on lap…\",\n"
    "    \"Same scene, woman opens package, blue jacket emerging from tissue…\",\n"
    "    \"Same scene, woman tries on the blue jacket…\"\n"
    "  ],\n"
    "  \"parents\": [null, 0, 1, 2]\n"
    "}"
)


async def auto_prompt_storyboard(
    node_id: int,
    count: int,
    *,
    narrative_seed: str = "",
) -> dict:
    """Compose N narrative beats with a continuity tree in one LLM call.

    Returns ``{"prompts": [str * count], "parents": [int|None * count]}``.
    The planner LLM decides which beats are roots (fresh scene → gen_image)
    and which are continuations (edit_image from a parent beat). See
    `.omc/plans/storyboard-image-node.md` §4 + §6.2 for the full contract.
    """
    if not 1 <= count <= 8:
        raise PromptSynthError(f"storyboard count must be 1..8, got {count}")

    records, target = _collect_upstream(node_id)
    if target is None:
        raise PromptSynthError(f"node {node_id} not found")

    subject_count = len(_distinct_subjects(records))
    base_system = _image_system_prompt(subject_count)
    seed = (narrative_seed or "").strip()
    seed_block = (
        f"\nNarrative seed (user intent — beats MUST follow this arc):\n"
        f"  {seed}\n\n"
        if seed
        else ""
    )
    # Use .replace() rather than .format() because the suffix contains a
    # literal JSON example with `{` and `}` that .format() would mis-parse.
    suffix = (
        _STORYBOARD_SUFFIX
        .replace("{count}", str(count))
        .replace("{narrative_seed_block}", seed_block)
    )
    system_prompt = base_system + suffix
    user_msg = _format_user_message(records, target)

    async with record_activity(
        "auto_prompt_storyboard",
        params={
            "node_id": node_id,
            "count": count,
            "narrative_seed": seed[:200],
        },
        node_id=node_id,
    ) as activity:
        try:
            text = await run_llm(
                "auto_prompt", user_msg, system_prompt=system_prompt, timeout=120.0
            )
        except LLMError as exc:
            raise PromptSynthError(
                f"auto-prompt provider failed: {exc}"
            ) from exc

        text = (text or "").strip()
        if text.startswith("```"):
            text = text.lstrip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.rsplit("```", 1)[0].strip()

        try:
            obj = json.loads(text)
        except json.JSONDecodeError as exc:
            raise PromptSynthError(
                f"storyboard provider returned non-JSON: {text[:200]!r}"
            ) from exc
        if not isinstance(obj, dict):
            raise PromptSynthError(
                "storyboard response is not a JSON object"
            )

        raw_prompts = obj.get("prompts")
        raw_parents = obj.get("parents")
        if not isinstance(raw_prompts, list) or not isinstance(raw_parents, list):
            raise PromptSynthError(
                "storyboard response missing prompts[] / parents[]"
            )
        if len(raw_prompts) != count or len(raw_parents) != count:
            raise PromptSynthError(
                f"storyboard length mismatch: prompts={len(raw_prompts)} "
                f"parents={len(raw_parents)} expected={count}"
            )

        prompts: list[str] = []
        for i, p in enumerate(raw_prompts):
            if not isinstance(p, str) or not p.strip():
                raise PromptSynthError(f"storyboard prompts[{i}] empty/non-str")
            prompts.append(p.strip())

        parents: list[Optional[int]] = []
        for k, v in enumerate(raw_parents):
            if v is None:
                parents.append(None)
                continue
            if isinstance(v, bool) or not isinstance(v, int):
                raise PromptSynthError(
                    f"storyboard parents[{k}]={v!r} must be int or null"
                )
            if not 0 <= v < k:
                raise PromptSynthError(
                    f"storyboard parents[{k}]={v} out of range [0, {k})"
                )
            parents.append(v)

        if parents[0] is not None:
            raise PromptSynthError("storyboard parents[0] must be null (root)")

        result = {"prompts": prompts, "parents": parents}
        activity.set_result(result)
        return result


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
    - ``concept`` → Concepta fork: canonical asset-sheet prompt
      (T-pose / orthographic, neutral lighting, design clarity).
    - ``image`` (legacy + default fallback) → photorealistic composition
      prompt combining upstream briefs in fashion-editorial style.
    - ``video`` → motion/camera prompt for the single source image brief
      (i2v has exactly one upstream image — multi-ref isn't a thing). The
      ``camera`` arg (e.g. ``"static"``) selects a system-prompt variant so
      the synthesiser respects the user's framing constraint.
    """
    records, target = _collect_upstream(node_id)
    if target is None:
        raise PromptSynthError(f"node {node_id} not found")

    is_video = target.type == "video"
    is_concept = target.type == "concept"
    subject_count = len(_distinct_subjects(records))
    if is_video:
        system_prompt = _video_system_prompt(camera, subject_count)
        user_msg = _format_user_message(records, target)
    elif is_concept:
        # Lazy import to avoid circular: services.concept imports from
        # .presets which is fine, but pulling at module top would mean
        # editing the file's import block every time we add a Concepta
        # node type. Local import keeps the surface localised.
        from flowboard.services.concept import build_concept_system_prompt

        target_data = target.data or {}
        style_key = target_data.get("styleKey") if isinstance(target_data.get("styleKey"), str) else None
        type_key = target_data.get("typeKey") if isinstance(target_data.get("typeKey"), str) else None
        system_prompt = build_concept_system_prompt(
            style_key=style_key, type_key=type_key,
        )
        # Concept-specific user-message builder. The legacy formatter
        # (used for fashion `image` targets) defaults to "photoreal
        # product / scene" prose when upstream is empty — wrong frame
        # for an asset-pipeline concept sheet.
        user_msg = _format_concept_user_message(records, target)
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
