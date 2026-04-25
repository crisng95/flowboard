"""Media cache + fetch service.

Run 6 wires Google Flow's GCS signed URLs (received through the extension's
TRPC fetch monkey-patch) into a local on-disk cache so the frontend can
render real images via `<img src="/media/:id">`.

GCS signed URLs are self-contained (signature + expiry in the query string)
— we don't need to proxy through the extension; a plain httpx GET works.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

import httpx
from sqlmodel import select

from flowboard.config import STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import Asset

logger = logging.getLogger(__name__)

MEDIA_CACHE_DIR = STORAGE_DIR / "media"
MEDIA_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Media id is a hex-with-dashes UUID in the GCS path.
_MEDIA_ID_RE = re.compile(r"^[0-9a-fA-F-]{1,64}$")

# Allowed URL prefixes. Google Flow serves user-generated media from its
# `flow-content.google` CDN (signed with short-TTL query params). The response
# from `batchGenerateImages` includes the signed URL at
# `data.media[].image.generatedImage.fifeUrl`.
_ALLOWED_URL_PREFIXES: tuple[str, ...] = (
    "https://flow-content.google/",
)


def _url_allowed(url: str) -> bool:
    return isinstance(url, str) and any(url.startswith(p) for p in _ALLOWED_URL_PREFIXES)

_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}


def is_valid_media_id(media_id: str) -> bool:
    return bool(_MEDIA_ID_RE.fullmatch(media_id or ""))


def normalize_media_id(raw: str) -> str:
    """Accept either ``media/<uuid>`` or the bare uuid."""
    if raw.startswith("media/"):
        return raw.split("/", 1)[1]
    return raw


def _cache_glob(media_id: str) -> Optional[Path]:
    """Return the cached file for this media_id if one exists (any extension)."""
    if not is_valid_media_id(media_id):
        return None
    for p in MEDIA_CACHE_DIR.glob(f"{media_id}.*"):
        if p.is_file():
            return p
    return None


def cached_path(media_id: str) -> Optional[Path]:
    return _cache_glob(media_id)


def ingest_urls(urls: list[dict[str, Any]]) -> int:
    """Upsert Asset rows keyed by uuid_media_id. Returns count touched."""
    touched = 0
    with get_session() as s:
        for entry in urls or []:
            if not isinstance(entry, dict):
                continue
            media_id = entry.get("media_id") or entry.get("mediaId")
            url = entry.get("url")
            kind = entry.get("mediaType") or entry.get("kind") or "image"
            if not isinstance(media_id, str) or not is_valid_media_id(media_id):
                continue
            if not _url_allowed(url):
                logger.warning(
                    "media: skip non-allowed url for %s: %r", media_id, (url or "")[:80]
                )
                continue
            row = s.exec(
                select(Asset).where(Asset.uuid_media_id == media_id)
            ).first()
            if row is None:
                row = Asset(uuid_media_id=media_id, url=url, kind=kind)
            else:
                row.url = url
                if not row.kind:
                    row.kind = kind
            s.add(row)
            touched += 1
        s.commit()
    if touched:
        logger.info("media: ingested %d url(s)", touched)
    return touched


async def fetch_and_cache(media_id: str) -> Optional[tuple[bytes, str, Path]]:
    """If the Asset has a URL and no cached file, fetch bytes, cache, return.

    Returns ``(bytes, mime, path)`` on success, ``None`` if there is no URL,
    the URL is no longer valid, or the fetch fails.
    """
    if not is_valid_media_id(media_id):
        return None

    with get_session() as s:
        row = s.exec(
            select(Asset).where(Asset.uuid_media_id == media_id)
        ).first()
        if row is None or not row.url:
            return None
        url = row.url

    if not _url_allowed(url):
        logger.warning("refusing to fetch non-allowed URL: %s", url[:60])
        return None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("GCS fetch failed for %s: %s", media_id, exc)
        return None

    if resp.status_code != 200:
        logger.warning("GCS fetch %s returned %d", media_id, resp.status_code)
        return None

    mime = resp.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
    # Whitelist served mime — block any injected content-type that isn't image/video
    # from being cached and served back to the browser.
    if not (mime.startswith("image/") or mime.startswith("video/")):
        logger.warning("refusing non-media mime from GCS: %s (media_id=%s)", mime, media_id)
        return None
    ext = _EXT_BY_MIME.get(mime, ".bin")
    path = MEDIA_CACHE_DIR / f"{media_id}{ext}"
    try:
        path.write_bytes(resp.content)
    except OSError as exc:
        logger.error("failed to write cache %s: %s", path, exc)
        return None

    with get_session() as s:
        row = s.exec(
            select(Asset).where(Asset.uuid_media_id == media_id)
        ).first()
        if row is not None:
            row.local_path = str(path)
            row.mime = mime
            s.add(row)
            s.commit()

    return resp.content, mime, path


def status(media_id: str) -> dict:
    """Read-only status for polling from the frontend."""
    if not is_valid_media_id(media_id):
        return {"available": False, "has_url": False, "reason": "invalid_id"}
    cached = _cache_glob(media_id)
    if cached is not None:
        mime = _mime_from_ext(cached.suffix)
        return {"available": True, "has_url": True, "mime": mime}
    with get_session() as s:
        row = s.exec(
            select(Asset).where(Asset.uuid_media_id == media_id)
        ).first()
        if row is None:
            return {"available": False, "has_url": False, "reason": "unknown_media"}
        if row.url:
            return {"available": False, "has_url": True, "reason": "not_cached_yet"}
        return {"available": False, "has_url": False, "reason": "no_url_yet"}


def _mime_from_ext(ext: str) -> str:
    for mime, e in _EXT_BY_MIME.items():
        if e == ext:
            return mime
    return "application/octet-stream"
