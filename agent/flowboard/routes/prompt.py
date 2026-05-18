"""Auto-prompt route.

`POST /api/prompt/auto { node_id }` returns a Claude-composed prompt built
from the immediate-upstream context (character / visual_asset / image
nodes' aiBriefs). Frontend calls this when the user clicks Generate
without typing a prompt.
"""
from __future__ import annotations

import logging
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


# ── Multi-view (Concepta fork) ────────────────────────────────────────────
class AutoPromptMultiviewBody(BaseModel):
    """Request a per-angle prompt set for a Multi-view dispatch.

    `preset` selects the angle list (`4view` / `6view` / `8view` /
    `arch_views`); the response carries one prompt per angle plus the
    angle labels themselves. The angles list is derived backend-side
    so the frontend doesn't have to mirror the full preset table —
    only the `preset` key is sent on the wire.
    """
    node_id: int
    preset: str = "4view"


class AutoPromptMultiviewResponse(BaseModel):
    node_id: int
    angles: list[str]
    prompts: list[str]


@router.post("/auto-multiview", response_model=AutoPromptMultiviewResponse)
async def auto_prompt_multiview(
    body: AutoPromptMultiviewBody,
) -> AutoPromptMultiviewResponse:
    """Return pre-composed per-angle prompts for a Multi-view dispatch.

    No LLM call — the 4-view angles are fixed and the prompts are
    deterministic. Each prompt uses explicit camera positioning +
    [VISIBLE]/[HIDDEN] tags to prevent Imagen's left/right collapse.
    """
    from flowboard.services.concept import angles_for_preset

    angles = angles_for_preset(body.preset)
    if not angles:
        raise HTTPException(status_code=400, detail=f"unknown preset {body.preset!r}")

    # Pre-composed prompts keyed by angle. Each one:
    #   - Uses explicit camera-position phrasing
    #   - Includes [VISIBLE] and [HIDDEN] tags
    #   - Specifies orthographic framing + neutral grey bg
    #   - Does NOT describe subject design (reference image carries identity)
    #
    # Left/right profile notes: Imagen collapses "left" and "right"
    # into a generic 3/4 view unless the prompt:
    #   1. States EXACT 90° perpendicular (no "slightly turned")
    #   2. Explicitly says face points AWAY from camera (perpendicular)
    #   3. Describes which eye/ear is visible vs hidden
    #   4. Contradicts the two profiles on every visible element
    _STATIC_PROMPTS: dict[str, str] = {
        "front": (
            "Camera directly in front of the subject, facing the camera "
            "head-on. Subject in A-pose: arms relaxed at 45 degrees "
            "away from body, palms facing inward, legs slightly apart "
            "shoulder-width, feet flat. Both shoulders perfectly square "
            "to the lens. "
            "No weapons of any kind. No swords, no daggers, no knives, "
            "no guns, no sheaths, no scabbards. Clean uncluttered body "
            "silhouette. Fingers relaxed, hands empty. "
            "Orthographic projection, full body, centred, plain neutral "
            "grey background, even studio lighting."
        ),
        "back": (
            "Camera directly behind the subject. Subject in A-pose: "
            "arms relaxed at 45 degrees away from body, palms facing "
            "inward, legs slightly apart shoulder-width, feet flat. "
            "Subject faces AWAY from camera entirely. "
            "No weapons of any kind. No swords, no daggers, no knives, "
            "no guns, no sheaths, no scabbards. Clean uncluttered body "
            "silhouette. Fingers relaxed, hands empty. "
            "Orthographic projection, full body, centred, plain neutral "
            "grey background, even studio lighting."
        ),
        "left profile": (
            "STRICT LEFT PROFILE. Camera at subject's 9-o'clock position. "
            "The nose points directly toward the LEFT edge of the image. "
            "The back of the head faces the RIGHT edge of the image. "
            "Only the left half of the face is visible: left eye, left "
            "eyebrow, left cheek, left ear. Right eye completely hidden "
            "behind the nose bridge. Right ear fully occluded by skull. "
            "A-pose, right arm hidden behind torso. "
            "NOT a three-quarter view. NOT both eyes visible. "
            "No weapons of any kind. Clean uncluttered silhouette. "
            "Hands empty. "
            "Orthographic, full body, centred, plain neutral grey "
            "background, even studio lighting."
        ),
        "right profile": (
            "STRICT RIGHT PROFILE. Camera at subject's 3-o'clock position. "
            "The nose points directly toward the RIGHT edge of the image. "
            "The back of the head faces the LEFT edge of the image. "
            "Only the right half of the face is visible: right eye, right "
            "eyebrow, right cheek, right ear. Left eye completely hidden "
            "behind the nose bridge. Left ear fully occluded by skull. "
            "A-pose, left arm hidden behind torso. "
            "NOT a three-quarter view. NOT both eyes visible. "
            "No weapons of any kind. Clean uncluttered silhouette. "
            "Hands empty. "
            "Orthographic, full body, centred, plain neutral grey "
            "background, even studio lighting."
        ),
    }

    prompts: list[str] = []
    for angle in angles:
        prompt = _STATIC_PROMPTS.get(angle)
        if prompt:
            prompts.append(prompt)
        else:
            # Fallback for unknown angles — generic but functional
            prompts.append(
                f"{angle} view of the subject. Orthographic projection, "
                f"full body, centred, neutral grey background, even "
                f"studio lighting. Preserve identity from reference."
            )

    return AutoPromptMultiviewResponse(
        node_id=body.node_id, angles=angles, prompts=prompts,
    )
