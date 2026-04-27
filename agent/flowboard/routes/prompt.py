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
