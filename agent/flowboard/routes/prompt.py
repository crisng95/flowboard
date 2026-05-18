"""Auto-prompt route.

`POST /api/prompt/auto { node_id }` returns a Claude-composed prompt built
from the immediate-upstream context (character / visual_asset / image
nodes' aiBriefs). Frontend calls this when the user clicks Generate
without typing a prompt.
"""
from __future__ import annotations

import logging
from enum import Enum
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services import prompt_synth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompt", tags=["prompt"])


class AutoPromptBody(BaseModel):
    node_id: int
    # Optional video-only constraint: e.g. "static" → synth uses the camera-
    # locked system prompt and avoids dolly/zoom suggestions.
    camera: Optional[str] = None


class AutoPromptResponse(BaseModel):
    node_id: int
    prompt: str


@router.post("/auto", response_model=AutoPromptResponse)
async def auto_prompt(body: AutoPromptBody) -> AutoPromptResponse:
    try:
        text = await prompt_synth.auto_prompt(body.node_id, camera=body.camera)
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AutoPromptResponse(node_id=body.node_id, prompt=text)


class AutoPromptBatchBody(BaseModel):
    node_id: int
    count: int
    camera: Optional[str] = None


class AutoPromptBatchResponse(BaseModel):
    node_id: int
    prompts: list[str]


@router.post("/auto-batch", response_model=AutoPromptBatchResponse)
async def auto_prompt_batch(body: AutoPromptBatchBody) -> AutoPromptBatchResponse:
    """Return N pose-distinct prompts so that an N-variant image gen
    actually produces N different shots instead of N seeds of the same
    stance."""
    if body.count < 1 or body.count > 8:
        raise HTTPException(status_code=400, detail="count must be 1..8")
    try:
        prompts = await prompt_synth.auto_prompt_batch(
            body.node_id, body.count, camera=body.camera
        )
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AutoPromptBatchResponse(node_id=body.node_id, prompts=prompts)


# -- Multi-view (Concepta fork) ----------------------------------------
#
# Two prompt-composition pipelines live in this section. Frontend or
# worker chooses by passing `mode` to `/auto-multiview`; `/auto-sheet`
# returns the same building blocks for explicit 2-phase runs.
#
# Layered architecture (per spec):
#
#   identity  ->  pulled from upstream subject brief via
#                 prompt_synth.get_identity(node_id)
#   angle     ->  per-angle camera + pose + visibility wording
#                 (`_ANGLE_CAMERA_*` per subject family)
#   style     ->  shared trailing constraints (orthographic, neutral grey,
#                 lighting, no weapons) (`_STYLE_SUFFIX_*`)
#   reference ->  visual-anchor instruction used only when a sheet image
#                 is available downstream (`_REFERENCE_ANCHOR`)
#
# Pipelines:
#
#   edit_chain (default, cheaper - matches existing worker behaviour)
#     `_compose_per_view_prompt(identity, angle, with_reference=False)`
#     called once per angle; worker still runs root + N-1 edit_image.
#
#   sheet_regen (premium - 2 phase, used by Phase 1 + Phase 2 dispatch)
#     1. Worker calls `/auto-sheet` -> `_compose_sheet_prompt(...)` for
#        a single multi-panel `gen_image` request.
#     2. Worker calls `/auto-multiview mode=sheet_regen` ->
#        `_compose_per_view_prompt(..., with_reference=True)` for each
#        angle, dispatched as `gen_image` with the sheet as ref_image.


class MultiviewMode(str, Enum):
    """Multi-view dispatch strategy.

    EDIT_CHAIN: default. Generate root angle, then edit_image for the
    remaining angles. Cheaper, matches existing worker logic.

    SHEET_REGEN: 2-phase. Generate a multi-panel character sheet first,
    then re-generate every angle individually with the sheet as a
    reference image. More credits, higher per-view fidelity.
    """

    EDIT_CHAIN = "edit_chain"
    SHEET_REGEN = "sheet_regen"


class AutoPromptMultiviewBody(BaseModel):
    """Request a per-angle prompt set for a Multi-view dispatch."""

    node_id: int
    preset: str = "4view"
    mode: MultiviewMode = MultiviewMode.EDIT_CHAIN


class AutoPromptMultiviewResponse(BaseModel):
    node_id: int
    angles: list[str]
    prompts: list[str]
    # Populated only when mode=SHEET_REGEN, so the frontend can dispatch
    # the Phase-1 sheet without a separate /auto-sheet round-trip.
    sheet_prompt: Optional[str] = None


class AutoPromptSheetBody(BaseModel):
    node_id: int
    preset: str = "4view"


class AutoPromptSheetResponse(BaseModel):
    node_id: int
    preset: str
    angles: list[str]
    sheet_prompt: str
    per_view_prompts: list[str]


# -- Layer constants ----------------------------------------------
#
# Two angle/style families ship today: characters and props. Each family
# has its own dict + style suffix because the wording requirements are
# fundamentally different (humanoid pose anchors vs product-photography
# framing, body silhouette vs prop silhouette, hands-empty vs no-hands
# etc). Sharing a single dict was the bug that made `prop_4view` render
# humanoid creatures on `front` / `back`.
_ANGLE_CAMERA_CHARACTER: dict[str, str] = {
    "front": (
        "Camera directly in front of the subject, facing head-on. "
        "Subject in A-pose: arms relaxed at 45 degrees away from body, "
        "palms facing inward, legs slightly apart shoulder-width, feet flat. "
        "Both shoulders perfectly square to the lens."
    ),
    "back": (
        "Camera directly behind the subject. Subject in A-pose: "
        "arms relaxed at 45 degrees away from body, palms facing inward, "
        "legs slightly apart shoulder-width, feet flat. "
        "Subject faces AWAY from camera entirely."
    ),
    "left profile": (
        "STRICT LEFT PROFILE. Camera at the subject 9-o-clock position. "
        "The nose points directly toward the LEFT edge of the image. "
        "The back of the head faces the RIGHT edge of the image. "
        "Only the left half of the face is visible: left eye, left eyebrow, "
        "left cheek, left ear. Right eye completely hidden behind the nose "
        "bridge. Right ear fully occluded by skull. A-pose, right arm hidden "
        "behind torso. NOT a three-quarter view. NOT both eyes visible."
    ),
    "right profile": (
        "STRICT RIGHT PROFILE. Camera at the subject 3-o-clock position. "
        "The nose points directly toward the RIGHT edge of the image. "
        "The back of the head faces the LEFT edge of the image. "
        "Only the right half of the face is visible: right eye, right eyebrow, "
        "right cheek, right ear. Left eye completely hidden behind the nose "
        "bridge. Left ear fully occluded by skull. A-pose, left arm hidden "
        "behind torso. NOT a three-quarter view. NOT both eyes visible."
    ),
}

_STYLE_SUFFIX_CHARACTER = (
    "Orthographic projection, full body, centred, plain neutral grey "
    "background, even studio lighting. No weapons of any kind. No swords, "
    "no daggers, no knives, no guns, no sheaths, no scabbards. Clean "
    "uncluttered body silhouette. Fingers relaxed, hands empty."
)

_ANGLE_CAMERA_PROP: dict[str, str] = {
    "3/4 hero": (
        "Hero product-photography angle of an INANIMATE PROP / OBJECT. "
        "The subject is NOT a person, NOT a creature, NOT a robot - it "
        "is the static prop shown in the reference image. Camera "
        "positioned 30-45 degrees rotated from the prop front, slightly "
        "elevated by 10-15 degrees. Front face and one side of the prop "
        "are both visible, creating a clean three-quarter silhouette."
    ),
    "front": (
        "Strict front orthographic view of an INANIMATE PROP / OBJECT. "
        "The subject is NOT a person and NOT a creature - it is the prop "
        "shown in the reference image. Camera dead-on perpendicular to "
        "the prop front face. Object centred, no rotation, no perspective "
        "skew."
    ),
    "back": (
        "Strict back orthographic view of an INANIMATE PROP / OBJECT. "
        "The subject is NOT a person and NOT a creature - it is the prop "
        "shown in the reference image, viewed from behind. Camera dead-on "
        "perpendicular to the prop back face. Show the rear surface - "
        "panels, fasteners, hinges, stitching, mounting points."
    ),
    "top-down": (
        "Top-down orthographic view of an INANIMATE PROP / OBJECT. "
        "The subject is NOT a person and NOT a creature - it is the prop "
        "shown in the reference image, viewed straight from above. Camera "
        "directly overhead, lens pointing straight down. Outline / footprint "
        "reads as a clean silhouette against the ground plane."
    ),
}

_STYLE_SUFFIX_PROP = (
    "Object isolated, no hands, no character holding it. Orthographic "
    "projection, plain neutral grey background, flat even studio lighting, "
    "minimal cast shadow."
)

_REFERENCE_ANCHOR = (
    "Use the provided character sheet as the sole visual reference. "
    "Preserve every design detail: colours, materials, accessories, "
    "hair style, and body proportions. Do not invent or alter any "
    "design element. Generate ONLY the specified angle view from this "
    "exact subject."
)

# Map preset key -> (angle_table, style_suffix). When a new preset ships,
# add an entry here and the dispatch logic below picks it up automatically.
_FAMILY_BY_PRESET: dict[str, tuple[dict[str, str], str]] = {
    "4view": (_ANGLE_CAMERA_CHARACTER, _STYLE_SUFFIX_CHARACTER),
    "prop_4view": (_ANGLE_CAMERA_PROP, _STYLE_SUFFIX_PROP),
}

_IDENTITY_FALLBACK = "A humanoid character"


def _resolve_family(preset_key: str) -> tuple[dict[str, str], str]:
    """Pick the angle dict + style suffix that match this preset.

    Falls back to character family for unknown presets so the response
    stays valid; the upstream dispatcher already 400s on truly unknown
    presets via `angles_for_preset`.
    """
    return _FAMILY_BY_PRESET.get(preset_key, _FAMILY_BY_PRESET["4view"])


def _compose_per_view_prompt(
    identity: str,
    angle: str,
    *,
    angle_table: dict[str, str],
    style_suffix: str,
    with_reference: bool = False,
) -> str:
    """Compose one angle prompt from the layered building blocks.

    Order: identity, optional reference anchor, angle camera/pose, style
    suffix. Reference anchor is inserted right after identity so the
    model is told WHAT subject to lock onto before being told HOW to
    frame it.
    """
    camera = angle_table.get(angle, f"{angle} view of the subject.")
    parts: list[str] = []
    if identity:
        parts.append(identity if identity.endswith(".") else identity + ".")
    if with_reference:
        parts.append(_REFERENCE_ANCHOR)
    parts.append(camera)
    parts.append(style_suffix)
    return " ".join(p.strip() for p in parts if p)


def _compose_sheet_prompt(
    identity: str,
    angles: list[str],
    *,
    angle_table: dict[str, str],
    style_suffix: str,
) -> str:
    """Compose the single multi-panel sheet prompt for Phase 1.

    Each panel reuses the angle camera string, but only its first
    sentence so the sheet prompt stays compact (the full per-view
    prompts are reserved for Phase 2). The sheet enforces consistency
    with explicit "same character across all panels" wording so the
    model treats it as a turnaround sheet rather than four independent
    images.
    """
    panel_descriptions = []
    for index, angle in enumerate(angles, start=1):
        camera = angle_table.get(angle, f"{angle} view")
        first_sentence = camera.split(".")[0].strip()
        panel_descriptions.append(f"Panel {index}: {first_sentence}")
    panel_text = ". ".join(panel_descriptions)

    identity_clause = identity.rstrip(".") if identity else _IDENTITY_FALLBACK

    return (
        f"Character design reference sheet, {len(angles)}-panel "
        f"horizontal layout. {panel_text}. Same exact subject across "
        f"every panel. {identity_clause}. {style_suffix} Each panel "
        f"must be equal width, strictly separated by thin vertical "
        f"gutters, with consistent scale and colours across panels."
    )


async def _resolve_identity(node_id: int) -> str:
    """Pull identity from upstream context, with safe fallback.

    Wraps `prompt_synth.get_identity` so callers don\'t have to repeat
    the warning + fallback dance.
    """
    try:
        identity = await prompt_synth.get_identity(node_id)
    except prompt_synth.PromptSynthError as exc:
        # An upstream collection failure is not fatal - the prompt
        # builder can still emit usable text with the fallback. Log
        # so we know identity recovery degraded.
        logger.warning(
            "get_identity failed for node %s (%s); using fallback",
            node_id,
            exc,
        )
        identity = ""
    if not identity:
        logger.warning(
            "No upstream identity for node %s; using fallback", node_id
        )
        return _IDENTITY_FALLBACK
    return identity


@router.post("/auto-multiview", response_model=AutoPromptMultiviewResponse)
async def auto_prompt_multiview(
    body: AutoPromptMultiviewBody,
) -> AutoPromptMultiviewResponse:
    """Return per-angle prompts for a Multi-view dispatch.

    Behaviour depends on `body.mode`:
      * EDIT_CHAIN (default): per-angle prompts only, no reference
        anchor. Worker will gen the root angle then edit_image the
        rest off it. Backward-compatible with all existing clients.
      * SHEET_REGEN: per-angle prompts include the reference anchor
        block. Response also carries `sheet_prompt` so the caller can
        run Phase 1 (multi-panel sheet) without a second round-trip.
    """
    from flowboard.services.concept import angles_for_preset

    angles = angles_for_preset(body.preset)
    if not angles:
        raise HTTPException(
            status_code=400, detail=f"unknown preset {body.preset!r}"
        )

    angle_table, style_suffix = _resolve_family(body.preset)
    identity = await _resolve_identity(body.node_id)

    with_reference = body.mode == MultiviewMode.SHEET_REGEN
    prompts = [
        _compose_per_view_prompt(
            identity,
            angle,
            angle_table=angle_table,
            style_suffix=style_suffix,
            with_reference=with_reference,
        )
        for angle in angles
    ]

    sheet_prompt: Optional[str] = None
    if body.mode == MultiviewMode.SHEET_REGEN:
        sheet_prompt = _compose_sheet_prompt(
            identity,
            angles,
            angle_table=angle_table,
            style_suffix=style_suffix,
        )

    return AutoPromptMultiviewResponse(
        node_id=body.node_id,
        angles=angles,
        prompts=prompts,
        sheet_prompt=sheet_prompt,
    )


@router.post("/auto-sheet", response_model=AutoPromptSheetResponse)
async def auto_prompt_sheet(
    body: AutoPromptSheetBody,
) -> AutoPromptSheetResponse:
    """Phase 1 of the sheet_regen pipeline.

    Returns one `sheet_prompt` for a single multi-panel `gen_image`
    dispatch, plus the per-view prompts (with reference anchor) the
    worker will use in Phase 2 once the sheet image is available.

    No LLM call - the prompts are deterministic compositions of the
    upstream identity with the canonical angle/style layers.
    """
    from flowboard.services.concept import angles_for_preset

    angles = angles_for_preset(body.preset)
    if not angles:
        raise HTTPException(
            status_code=400, detail=f"unknown preset {body.preset!r}"
        )

    angle_table, style_suffix = _resolve_family(body.preset)
    identity = await _resolve_identity(body.node_id)

    sheet_prompt = _compose_sheet_prompt(
        identity,
        angles,
        angle_table=angle_table,
        style_suffix=style_suffix,
    )
    per_view_prompts = [
        _compose_per_view_prompt(
            identity,
            angle,
            angle_table=angle_table,
            style_suffix=style_suffix,
            with_reference=True,
        )
        for angle in angles
    ]

    return AutoPromptSheetResponse(
        node_id=body.node_id,
        preset=body.preset,
        angles=angles,
        sheet_prompt=sheet_prompt,
        per_view_prompts=per_view_prompts,
    )