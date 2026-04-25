"""User image upload to Google Flow.

Multipart upload that base64-encodes the bytes, hands them to
``FlowSDK.upload_image`` (which goes through the extension to
``/v1/flow/uploadImage``), and on success caches the bytes locally keyed by
the Flow-issued media_id.

Design choices:
- Run synchronously rather than through the worker queue. Upload is one
  round-trip and the caller (character node UI) needs the media_id immediately.
- Project-scoped: Flow's uploadImage requires ``clientContext.projectId``.
  Frontend must call ``ensureBoardProject`` first and pass the ``project_id``.
- 10 MB cap and ``image/*`` mime allowlist applied here as defence-in-depth;
  the route never trusts the browser-supplied content-type alone.
"""
from __future__ import annotations

import base64
import logging
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset
from flowboard.services import media as media_service
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["upload"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
ALLOWED_UPLOAD_MIMES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


@router.post("/upload")
async def upload_image(
    project_id: str = Form(...),
    node_id: Optional[int] = Form(default=None),
    file: UploadFile = File(...),
):
    if not is_valid_project_id(project_id):
        raise HTTPException(status_code=400, detail="invalid project_id")

    mime = (file.content_type or "").lower().split(";")[0].strip()
    if mime not in ALLOWED_UPLOAD_MIMES:
        raise HTTPException(
            status_code=415,
            detail=f"unsupported mime: {mime!r}; allowed: {sorted(ALLOWED_UPLOAD_MIMES)}",
        )

    # Read with a hard cap so a hostile client can't OOM us by streaming
    # forever. Read MAX+1 bytes; if we got more than MAX, reject.
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    size = len(raw)
    if size == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large: {size} > {MAX_UPLOAD_BYTES}",
        )

    image_b64 = base64.b64encode(raw).decode("ascii")
    file_name = file.filename or f"upload{_EXT_BY_MIME.get(mime, '')}"

    resp = await get_flow_sdk().upload_image(
        image_base64=image_b64,
        mime_type=mime,
        project_id=project_id,
        file_name=file_name,
    )
    if resp.get("error"):
        raise HTTPException(
            status_code=502,
            detail={"message": resp["error"], "raw": resp.get("raw")},
        )

    media_id = resp.get("media_id")
    if not isinstance(media_id, str) or not media_service.is_valid_media_id(media_id):
        raise HTTPException(
            status_code=502,
            detail={"message": "invalid media_id from Flow", "raw": resp.get("raw")},
        )

    # Cache bytes locally so /media/:id serves them without going back through
    # the extension. Upload bytes are user-owned, so unlike fifeUrl-cached
    # generations there's no signed URL to refresh later.
    ext = _EXT_BY_MIME.get(mime, ".bin")
    cache_path = media_service.MEDIA_CACHE_DIR / f"{media_id}{ext}"
    try:
        cache_path.write_bytes(raw)
    except OSError as exc:
        logger.error("failed to write upload cache %s: %s", cache_path, exc)
        raise HTTPException(status_code=500, detail="failed to cache upload")

    with get_session() as s:
        row = s.exec(
            select(Asset).where(Asset.uuid_media_id == media_id)
        ).first()
        if row is None:
            row = Asset(
                uuid_media_id=media_id,
                kind="image",
                local_path=str(cache_path),
                mime=mime,
                node_id=node_id,
            )
        else:
            row.local_path = str(cache_path)
            row.mime = mime
            if node_id is not None and row.node_id is None:
                row.node_id = node_id
        s.add(row)
        s.commit()

    logger.info("upload: media_id=%s size=%d mime=%s", media_id, size, mime)
    return {"media_id": media_id, "mime": mime, "size": size}
