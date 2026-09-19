"""Vision describe endpoint.

`POST /api/vision/describe { media_id, node_id? }` returns a short text
brief about the image. Used by the frontend to auto-annotate
visual_asset / character nodes after upload, and as upstream context for
auto-prompt synthesis.

`node_id` is optional, unlike `/api/prompt/auto`'s: vision is a pure
function of the media and stays callable without a node (scripts, the
activity feed's retry, a media-only probe). Passing it is what makes the
call survive a reload — it both labels the activity row against the node
and lets the service write `aiBrief` onto that node itself, instead of
relying on the caller to still be there when the answer lands. See
`vision_service.describe_media`.
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
    node_id: Optional[int] = None


class DescribeResponse(BaseModel):
    media_id: str
    description: str


@router.post("/describe", response_model=DescribeResponse)
async def describe(body: DescribeBody) -> DescribeResponse:
    try:
        text = await vision_service.describe_media(
            body.media_id, node_id=body.node_id
        )
    except vision_service.VisionError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return DescribeResponse(media_id=body.media_id, description=text)
