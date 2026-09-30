"""ffmpeg-based concatenation of video assets.

Used by the chat E2E agent's ``concat_videos`` tool: takes the local
video files behind a list of Asset ids, joins them in order, and returns
a new ``Asset(kind="video")`` pointing at the merged file.

No Flow / extension dependency — pure local ffmpeg.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from sqlmodel import select

from flowboard import config
from flowboard.db import get_session
from flowboard.db.models import Asset

logger = logging.getLogger(__name__)

_FFMPEG_TIMEOUT_S = 300


def _ffmpeg() -> Optional[str]:
    return shutil.which("ffmpeg")


def concat_video_assets(asset_ids: list[int]) -> tuple[Optional[int], Optional[str]]:
    """Concatenate the videos behind ``asset_ids`` in order.

    Returns ``(new_asset_id, None)`` on success or ``(None, error)`` on
    failure. Never raises — the chat agent feeds the error back to the
    LLM as a tool observation.
    """
    ffmpeg = _ffmpeg()
    if ffmpeg is None:
        return None, "ffmpeg_not_found: ffmpeg is not installed on the agent host"

    if not asset_ids:
        return None, "no_inputs: asset_ids is empty"

    # Resolve ids → files inside one session so the paths can't drift.
    inputs: list[Path] = []
    with get_session() as s:
        for aid in asset_ids:
            row = s.get(Asset, aid)
            if row is None:
                return None, f"asset_not_found: no Asset with id {aid}"
            if (row.kind or "") != "video":
                return None, f"not_video: Asset {aid} has kind {row.kind!r}"
            if not row.local_path:
                return None, f"no_local_file: Asset {aid} has no local_path"
            p = Path(row.local_path)
            if not p.is_file():
                return None, f"missing_file: Asset {aid} local file is gone"
            inputs.append(p)

    out_dir = config.STORAGE_DIR / "media"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"concat_{uuid.uuid4().hex}.mp4"

    list_file: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False
        ) as tf:
            list_file = Path(tf.name)
            for p in inputs:
                # Absolute paths + -safe 0; escape single quotes per the
                # concat demuxer file format.
                tf.write(f"file '{str(p).replace(chr(39), chr(39)+chr(92)+chr(39))}'\n")

        # Fast path: stream copy (works when all inputs share codecs).
        err = _run_concat(ffmpeg, list_file, out_path, reencode=False)
        if err is not None:
            logger.warning("video_concat: stream copy failed (%s); retrying with re-encode", err[:120])
            err = _run_concat(ffmpeg, list_file, out_path, reencode=True)
        if err is not None:
            return None, f"ffmpeg_failed: {err[:300]}"
    finally:
        if list_file is not None:
            try:
                list_file.unlink()
            except OSError:
                pass

    new_id: Optional[int] = None
    with get_session() as s:
        row = Asset(
            kind="video",
            node_id=None,
            uuid_media_id=uuid.uuid4().hex,
            local_path=str(out_path),
            mime="video/mp4",
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        new_id = row.id
    logger.info("video_concat: %d inputs → asset %s", len(inputs), new_id)
    return new_id, None


def _run_concat(
    ffmpeg: str, list_file: Path, out_path: Path, *, reencode: bool
) -> Optional[str]:
    """Run one ffmpeg concat attempt. None on success, else stderr tail."""
    if reencode:
        cmd = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart",
            str(out_path),
        ]
    else:
        cmd = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c", "copy",
            str(out_path),
        ]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=_FFMPEG_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "timed out after 300s"
    except OSError as exc:
        return f"could not launch ffmpeg: {exc}"
    if proc.returncode != 0 or not out_path.is_file():
        tail = (proc.stderr or b"").decode("utf-8", "replace").strip()
        return tail[-500:] if tail else f"exit code {proc.returncode}"
    return None
