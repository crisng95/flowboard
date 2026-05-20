"""Vision describe endpoint.

`POST /api/vision/describe { media_id }` returns a short text brief about
the image. Used by the frontend to auto-annotate visual_asset / character
nodes after upload, and as upstream context for auto-prompt synthesis.
"""
from __future__ import annotations

import logging

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services import vision as vision_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vision", tags=["vision"])


class DescribeBody(BaseModel):
    media_id: str
    ref_type: Optional[str] = None
    # `True` when the frontend detects a hybrid ref (`photo` /
    # `3d_render`) sharing a target with at least one structural
    # ref. The vision service then demotes the hybrid to a
    # material-style profile so its brief strips subject nouns.
    force_material_mode: bool = False


class DescribeResponse(BaseModel):
    media_id: str
    description: str


@router.post("/describe", response_model=DescribeResponse)
async def describe(body: DescribeBody) -> DescribeResponse:
    try:
        text = await vision_service.describe_media(
            body.media_id,
            ref_type=body.ref_type,
            force_material_mode=body.force_material_mode,
        )
    except vision_service.VisionError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return DescribeResponse(media_id=body.media_id, description=text)
