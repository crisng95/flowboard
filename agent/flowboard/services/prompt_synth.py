"""Auto-prompt synthesizer.

Given a target node, walks the immediate-upstream graph, collects
``aiBrief`` text from each parent node, and asks Claude to compose a single
image-generation prompt that combines them. Used when the user clicks
Generate without typing a prompt.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Edge, Node
from flowboard.services import claude_cli

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
    "When a product / wardrobe asset is in the inputs, the chosen pose "
    "must make the GARMENT the visual hero — knees-up or full upper-body "
    "framing.\n\n"
    "Style: photoreal editorial fashion photography, sharp focus, soft "
    "even key light, neutral indoor or studio background unless the "
    "notes override it. No marketing language, no preamble — output the "
    "prompt only."
)

# Shared core: scene-aware vocabulary, anti-freeze anchor, beat structure.
# Composed into both DEFAULT and STATIC variants below — only the camera
# clause differs.
_SYNTH_VIDEO_CORE = (
    "You are a video-motion prompt builder for an image-to-video pipeline "
    "(8-second clip, Veo-style). The subject is a fashion model "
    "showcasing a product. The source still is the first frame — you "
    "must describe what happens AFTER it.\n\n"
    "ANTI-FREEZE — CRITICAL: Veo i2v tends to lock onto the source pose. "
    "The subject MUST visibly leave the initial pose by 1-2 seconds — "
    "posture, hand position, or head angle must clearly differ from "
    "frame 0. Use ACTION VERBS (steps, turns, glances, tucks, sips), "
    "NOT adjectives (gentle, subtle, soft).\n\n"
    "DETECT SCENE from the source still's brief and match motion "
    "vocabulary to the environment:\n"
    "  • studio / plain backdrop / neutral bg → editorial poses: turn "
    "to three-quarter, hand slides to hip, fingers brush the sleeve / "
    "collar / hem, slow head tilt, engage camera with confident gaze.\n"
    "  • street / city / sidewalk / urban outdoor → casual lifestyle: "
    "half-step forward into frame, hair tuck behind ear, glance over "
    "the shoulder at passing traffic, hand in pocket, confident smirk "
    "back at camera. NO studio-style hand-on-hip gestures here.\n"
    "  • café / restaurant / interior → seated motion: lean back, sip "
    "from a cup, glance toward the window, small wave or hand gesture.\n"
    "  • beach / park / nature / scenic → ambient motion: hair flutter "
    "in the breeze, slow exhale, look toward horizon, soft step forward, "
    "hand brushes fabric.\n\n"
    "The model MUST perform a SEQUENCE of 2-3 distinct pose changes "
    "across the 8 seconds. Structure as time-coded beats:\n"
    "  0-3s: <verb-led action 1>\n"
    "  3-6s: <verb-led action 2>\n"
    "  6-8s: <verb-led action 3>\n"
    "Smooth transitions — no teleports. Match the mood and lighting of "
    "the source. Add natural blinks and soft fabric breathing "
    "throughout. Max 360 chars. No scene cuts, no dialogue, no text "
    "overlays. Output the motion prompt only — no preamble."
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


def _video_system_prompt(camera: Optional[str]) -> str:
    if camera == "static":
        return _SYNTH_SYSTEM_VIDEO_STATIC
    return _SYNTH_SYSTEM_VIDEO_DEFAULT


class PromptSynthError(RuntimeError):
    pass


def _collect_upstream(node_id: int) -> tuple[list[dict], Optional[Node]]:
    """Return (upstream_brief_records, target_node).

    Each record: {type, brief, prompt, has_media}.
    """
    with get_session() as s:
        target = s.get(Node, node_id)
        if target is None:
            return [], None
        edges = s.exec(select(Edge).where(Edge.target_id == node_id)).all()
        upstream_ids = [e.source_id for e in edges]
        records: list[dict] = []
        for uid in upstream_ids:
            n = s.get(Node, uid)
            if n is None:
                continue
            data = n.data or {}
            brief = data.get("aiBrief")
            records.append(
                {
                    "type": n.type,
                    "shortId": n.short_id,
                    "brief": brief if isinstance(brief, str) else None,
                    "prompt": data.get("prompt") if isinstance(data.get("prompt"), str) else None,
                    "title": data.get("title") if isinstance(data.get("title"), str) else None,
                    "has_media": bool(isinstance(data.get("mediaId"), str) and data.get("mediaId")),
                }
            )
        return records, target


def _format_user_message(records: list[dict], target: Node) -> str:
    """Render the upstream context into a compact prompt for the LLM."""
    by_type: dict[str, list[str]] = {}
    for r in records:
        # Prefer the AI-generated brief; fall back to the user-typed prompt
        # or title so a node with no brief still contributes something.
        text = r["brief"] or r["prompt"] or r["title"] or "(no description)"
        by_type.setdefault(r["type"], []).append(f"#{r['shortId']}: {text}")

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
    base_system = (
        _video_system_prompt(camera) if is_video else _SYNTH_SYSTEM_IMAGE
    )
    system_prompt = base_system + _BATCH_SUFFIX.format(count=count)
    user_msg = _format_user_message(records, target)

    try:
        text = await claude_cli.run_claude(
            user_msg, system_prompt=system_prompt, timeout=45.0
        )
    except claude_cli.ClaudeCliError as exc:
        raise PromptSynthError(f"claude CLI failed: {exc}") from exc

    text = (text or "").strip()
    # Strip markdown fences if Claude added them despite instructions.
    if text.startswith("```"):
        text = text.lstrip("`")
        # "json\n[...]\n```" → "[...]\n"
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.rsplit("```", 1)[0].strip()

    import json
    try:
        arr = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PromptSynthError(
            f"claude returned non-JSON for batch: {text[:200]!r}"
        ) from exc
    if not isinstance(arr, list):
        raise PromptSynthError("claude batch response is not a JSON array")
    prompts = [str(p).strip() for p in arr if isinstance(p, str) and p.strip()]
    if not prompts:
        raise PromptSynthError("claude batch returned no valid prompts")
    # Pad / trim to requested count. If Claude returned fewer, repeat the
    # last one — better to have N items than fail the dispatch.
    while len(prompts) < count:
        prompts.append(prompts[-1])
    prompts = prompts[:count]
    return prompts


async def auto_prompt(node_id: int, *, camera: Optional[str] = None) -> str:
    """Compose a generation prompt by walking upstream + asking Claude.

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
    system_prompt = (
        _video_system_prompt(camera) if is_video else _SYNTH_SYSTEM_IMAGE
    )
    user_msg = _format_user_message(records, target)

    try:
        text = await claude_cli.run_claude(
            user_msg,
            system_prompt=system_prompt,
            timeout=30.0,
        )
    except claude_cli.ClaudeCliError as exc:
        raise PromptSynthError(f"claude CLI failed: {exc}") from exc

    text = (text or "").strip().strip('"').strip("'")
    if not text:
        raise PromptSynthError("empty response from claude")
    if len(text) > 500:
        text = text[:500].rstrip() + "…"
    return text
