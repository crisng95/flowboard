"""video_concat — ffmpeg join of video assets (skipped when no ffmpeg)."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from flowboard.db import get_session
from flowboard.db.models import Asset
from flowboard.services import video_concat

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def _make_mp4(path: Path, color: str, duration_s: float = 1.0):
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i",
            f"color=c={color}:s=64x64:d={duration_s}:r=10",
            "-pix_fmt", "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _register(path: Path) -> int:
    with get_session() as s:
        row = Asset(kind="video", local_path=str(path), mime="video/mp4")
        s.add(row)
        s.commit()
        s.refresh(row)
        return row.id


def _duration_s(path: Path) -> float:
    """ffprobe when available, else parse `ffmpeg -i` stderr."""
    if shutil.which("ffprobe"):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        return float(out.stdout.strip())
    out = subprocess.run(
        ["ffmpeg", "-i", str(path)], capture_output=True, text=True
    )
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out.stderr)
    assert m, f"could not parse duration from: {out.stderr[-300:]}"
    h, mi, sec = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(sec)


@needs_ffmpeg
def test_concat_two_videos_duration_sums(tmp_path):
    a = tmp_path / "a.mp4"
    b = tmp_path / "b.mp4"
    _make_mp4(a, "red")
    _make_mp4(b, "blue")
    new_id, err = video_concat.concat_video_assets([_register(a), _register(b)])
    assert err is None, err
    assert new_id
    with get_session() as s:
        row = s.get(Asset, new_id)
        assert row is not None and row.kind == "video"
        out = Path(row.local_path)
    assert out.is_file() and out.stat().st_size > 0
    dur = _duration_s(out)
    assert dur == pytest.approx(2.0, abs=0.3)


@needs_ffmpeg
def test_concat_output_under_storage_media(tmp_path):
    import os

    a = tmp_path / "a.mp4"
    _make_mp4(a, "green")
    new_id, err = video_concat.concat_video_assets([_register(a)])
    assert err is None
    with get_session() as s:
        row = s.get(Asset, new_id)
    storage_media = Path(os.environ["FLOWBOARD_STORAGE"]) / "media"
    assert Path(row.local_path).parent == storage_media
    assert Path(row.local_path).name.startswith("concat_")


def test_concat_empty_list_errors():
    new_id, err = video_concat.concat_video_assets([])
    assert new_id is None and err


def test_concat_unknown_asset_errors():
    new_id, err = video_concat.concat_video_assets([987654321])
    assert new_id is None and "not_found" in err


def test_concat_non_video_asset_errors():
    with get_session() as s:
        row = Asset(kind="image", local_path="/tmp/x.png", mime="image/png")
        s.add(row)
        s.commit()
        s.refresh(row)
        aid = row.id
    new_id, err = video_concat.concat_video_assets([aid])
    assert new_id is None and "not_video" in err


def test_concat_missing_ffmpeg_errors(monkeypatch):
    monkeypatch.setattr(
        "flowboard.services.video_concat.shutil.which", lambda *_: None
    )
    new_id, err = video_concat.concat_video_assets([1])
    assert new_id is None and "ffmpeg_not_found" in err
