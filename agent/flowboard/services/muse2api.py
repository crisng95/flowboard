"""muse2api gateway client — the Muse provider's direct transport.

muse2api (https://github.com/crisng95/muse2api) is a separate service that
exposes the muse.ai web app as an OpenAI-compatible API, with its own
account pool, failover and video task manager. When
``FLOWBOARD_MUSE2API_BASE`` is set, the Muse provider talks to it directly
instead of publishing jobs to the provider-job queue for a Pax worker:

    Flowboard ──HTTP (Bearer key)──▶ muse2api ──▶ muse.ai

    LLM (auto-prompt / vision / planner / chat)  POST /v1/chat/completions
    gen_image                                    POST /v1/images/generations
    edit_image                                   POST /v1/images/edits
    gen_video / gen_video_omni                   POST /v1/videos + GET /v1/videos/{id}

Unset, nothing changes: the queue + worker path stays the Muse transport.

Every call raises ``Muse2APIError`` on failure; the message carries
muse2api's OpenAI-style ``error.message`` (never the API key) so callers
can surface it verbatim. The two call sites translate it into their own
error conventions (``LLMError`` / the processor's ``(result, error)``).
"""
from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from flowboard import config

logger = logging.getLogger(__name__)

# Test hook: an ``httpx.MockTransport`` (or ASGI transport) swapped in by
# the test suite so no real socket is opened.
_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

_READY_TTL_S = 30.0
_READY_TIMEOUT_S = 3.0
_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_MAX_MEDIA_BYTES = 500 * 1024 * 1024
# muse2api's ImageGenerationRequest caps ``n`` at 4.
MAX_IMAGES_PER_CALL = 4

_ready_cache: dict[str, tuple[float, bool]] = {}


class Muse2APIError(RuntimeError):
    """Any muse2api failure: transport, non-2xx, malformed body, task failed."""

    def __init__(self, message: str, *, status: Optional[int] = None, code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


# ── configuration ─────────────────────────────────────────────────────


def base_url() -> str:
    return (config.MUSE2API_BASE or "").strip().rstrip("/")


def is_configured() -> bool:
    """True when the Muse provider should use muse2api instead of the queue."""
    return bool(base_url())


def reset_cache() -> None:
    _ready_cache.clear()


def _client(timeout: float) -> httpx.AsyncClient:
    headers = {}
    if config.MUSE2API_KEY:
        headers["authorization"] = f"Bearer {config.MUSE2API_KEY}"
    kwargs: dict = {"base_url": base_url(), "headers": headers, "timeout": timeout}
    if _TRANSPORT is not None:
        kwargs["transport"] = _TRANSPORT
    return httpx.AsyncClient(**kwargs)


def _error_from(resp: httpx.Response) -> Muse2APIError:
    message = ""
    code = ""
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            message = str(err.get("message") or "")
            code = str(err.get("code") or "")
        elif isinstance(body.get("detail"), str):
            message = body["detail"]
    if not message:
        message = (resp.text or "").strip()[:200] or "(empty body)"
    return Muse2APIError(
        f"muse2api HTTP {resp.status_code}: {message[:300]}",
        status=resp.status_code,
        code=code,
    )


async def _request(
    method: str, path: str, *, timeout: float, **kwargs
) -> httpx.Response:
    try:
        async with _client(timeout) as client:
            resp = await client.request(method, path, **kwargs)
    except httpx.TimeoutException as exc:
        raise Muse2APIError(f"muse2api timed out after {timeout:.0f}s ({path})") from exc
    except httpx.HTTPError as exc:
        raise Muse2APIError(f"muse2api unreachable at {base_url()}: {exc}") from exc
    if resp.status_code >= 400:
        raise _error_from(resp)
    return resp


def _json(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
    except ValueError as exc:
        raise Muse2APIError("muse2api response was not JSON") from exc
    if not isinstance(data, dict):
        raise Muse2APIError("muse2api response was not a JSON object")
    return data


# ── health / catalog ──────────────────────────────────────────────────


async def is_ready(force: bool = False) -> bool:
    """Cached ``GET /readyz``: driver up and at least one usable account.

    Polled by the Settings panel every 30s, so it is cached and short-fused;
    it never touches the model.
    """
    if not is_configured():
        return False
    key = base_url()
    now = time.monotonic()
    cached = _ready_cache.get(key)
    if not force and cached is not None and now - cached[0] < _READY_TTL_S:
        return cached[1]
    ok = False
    try:
        resp = await _request("GET", "/readyz", timeout=_READY_TIMEOUT_S)
        ok = bool(_json(resp).get("ready"))
    except Muse2APIError as exc:
        logger.info("muse2api: not ready (%s)", exc)
    _ready_cache[key] = (now, ok)
    return ok


async def list_models(kind: str = "chat") -> list[dict]:
    """``GET /v1/models`` filtered to one kind, as ``[{"id", "label"}]``.

    Never raises: a catalog is a UI convenience.
    """
    try:
        resp = await _request("GET", "/v1/models", timeout=10.0)
        items = _json(resp).get("data") or []
    except Muse2APIError as exc:
        logger.info("muse2api: model list unavailable (%s)", exc)
        return []
    out: list[dict] = []
    for m in items:
        if not isinstance(m, dict) or m.get("kind") != kind or m.get("alias_of"):
            continue
        mid = m.get("id")
        if isinstance(mid, str) and mid:
            out.append({"id": mid, "label": f"{mid} (muse2api)"})
    return out


# ── helpers ───────────────────────────────────────────────────────────


def size_for_orientation(orientation: Optional[str]) -> Optional[str]:
    """Provider-job orientation → muse2api ``size`` (an aspect ratio)."""
    if orientation == "HORIZONTAL":
        return "16:9"
    if orientation == "VERTICAL":
        return "9:16"
    return None


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _file_data_url(path: str) -> str:
    p = Path(path)
    try:
        size = p.stat().st_size
    except OSError as exc:
        raise Muse2APIError(f"attachment unreadable: {p.name}") from exc
    if size > _MAX_ATTACHMENT_BYTES:
        raise Muse2APIError(
            f"attachment too large for muse2api: {p.name} "
            f"({size // (1024 * 1024)}MB > {_MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB)"
        )
    mime = mimetypes.guess_type(path)[0] or "image/png"
    return data_url(p.read_bytes(), mime)


async def _download(url: str, timeout: float) -> tuple[bytes, str]:
    """Fetch a muse2api media URL.

    ``/v1/media/{name}`` links are re-rooted on our configured base: muse2api
    builds them from its own view of the request host, which may not be
    reachable from here (reverse proxy, docker network, 0.0.0.0).
    """
    path = urlparse(url).path
    if path.startswith("/v1/media/"):
        resp = await _request("GET", path, timeout=timeout)
    else:
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=_TRANSPORT) as client:
                resp = await client.get(url, follow_redirects=True)
        except httpx.HTTPError as exc:
            raise Muse2APIError(f"muse2api media download failed: {exc}") from exc
        if resp.status_code >= 400:
            raise Muse2APIError(f"muse2api media download HTTP {resp.status_code}")
    data = resp.content
    if not data or len(data) > _MAX_MEDIA_BYTES:
        raise Muse2APIError(f"muse2api media has unusable size ({len(data)} bytes)")
    mime = resp.headers.get("content-type", "").split(";")[0].strip()
    if not mime.startswith(("image/", "video/")):
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return data, mime


# ── chat ──────────────────────────────────────────────────────────────


async def chat(
    user_prompt: str,
    *,
    system_prompt: Optional[str] = None,
    attachments: Optional[list[str]] = None,
    model: Optional[str] = None,
    timeout: float = 90.0,
) -> str:
    """Non-streaming ``/v1/chat/completions``. Attachments are local paths,
    shipped as ``image_url`` data URLs (muse2api has no filesystem access)."""
    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if attachments:
        content: list[dict] = [{"type": "text", "text": user_prompt}]
        for path in attachments:
            content.append({"type": "image_url", "image_url": {"url": _file_data_url(path)}})
        messages.append({"role": "user", "content": content})
    else:
        messages.append({"role": "user", "content": user_prompt})
    payload: dict = {"messages": messages, "stream": False}
    if model:
        payload["model"] = model

    resp = await _request("POST", "/v1/chat/completions", timeout=timeout, json=payload)
    data = _json(resp)
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise Muse2APIError(f"muse2api chat response missing content: {data!r:.200}") from exc
    if not isinstance(text, str) or not text.strip():
        raise Muse2APIError("muse2api returned an empty answer")
    return text


# ── images ────────────────────────────────────────────────────────────


def _decode_image_items(data: dict) -> list[dict]:
    items = data.get("data")
    if not isinstance(items, list) or not items:
        raise Muse2APIError("muse2api returned no images")
    return [i for i in items if isinstance(i, dict)]


async def _image_bytes(item: dict, timeout: float) -> tuple[bytes, str]:
    b64 = item.get("b64_json")
    if isinstance(b64, str) and b64:
        try:
            raw = base64.b64decode(b64)
        except ValueError as exc:
            raise Muse2APIError("muse2api returned invalid base64 image data") from exc
        return raw, _sniff_image_mime(raw)
    url = item.get("url")
    if isinstance(url, str) and url:
        return await _download(url, timeout)
    raise Muse2APIError("muse2api image item has neither b64_json nor url")


def _sniff_image_mime(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG"):
        return "image/png"
    if raw.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:3] == b"GIF":
        return "image/gif"
    return "image/png"


async def generate_images(
    prompt: str,
    *,
    n: int = 1,
    size: Optional[str] = None,
    model: Optional[str] = None,
    timeout: float = 600.0,
) -> list[tuple[bytes, str]]:
    """``/v1/images/generations`` with ``b64_json`` so no second fetch is needed."""
    payload: dict = {
        "prompt": prompt,
        "n": max(1, min(int(n), MAX_IMAGES_PER_CALL)),
        "response_format": "b64_json",
    }
    if size:
        payload["size"] = size
    if model:
        payload["model"] = model
    resp = await _request("POST", "/v1/images/generations", timeout=timeout, json=payload)
    return [await _image_bytes(i, timeout) for i in _decode_image_items(_json(resp))]


async def edit_image(
    prompt: str,
    *,
    image: tuple[bytes, str],
    references: Optional[list[tuple[bytes, str]]] = None,
    size: Optional[str] = None,
    timeout: float = 600.0,
) -> list[tuple[bytes, str]]:
    """OpenAI-style multipart ``/v1/images/edits`` (source first, then refs)."""
    files = []
    for i, (data, mime) in enumerate([image, *(references or [])]):
        ext = mimetypes.guess_extension(mime) or ".png"
        files.append(("image[]", (f"image_{i}{ext}", data, mime)))
    form = {"prompt": prompt, "response_format": "b64_json"}
    if size:
        form["size"] = size
    resp = await _request("POST", "/v1/images/edits", timeout=timeout, data=form, files=files)
    return [await _image_bytes(i, timeout) for i in _decode_image_items(_json(resp))]


# ── video ─────────────────────────────────────────────────────────────


async def generate_video(
    prompt: str,
    *,
    image: Optional[str] = None,
    size: Optional[str] = None,
    duration: Optional[int] = None,
    model: Optional[str] = None,
    timeout: float = 1800.0,
    poll_interval_s: Optional[float] = None,
) -> tuple[bytes, str]:
    """Create a ``/v1/videos`` task, poll it to a terminal state, download it.

    ``image`` is the first frame as a data URL or http(s) URL.
    """
    payload: dict = {"prompt": prompt}
    if image:
        payload["image"] = image
    if size:
        payload["size"] = size
    if isinstance(duration, int) and duration > 0:
        payload["duration"] = duration
    if model:
        payload["model"] = model

    deadline = time.monotonic() + timeout
    interval = poll_interval_s if poll_interval_s is not None else config.MUSE2API_POLL_S
    task = _json(await _request("POST", "/v1/videos", timeout=60.0, json=payload))
    task_id = task.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise Muse2APIError(f"muse2api video task has no id: {task!r:.200}")
    logger.info("muse2api: video task %s created", task_id)

    while True:
        status = task.get("status")
        if status == "succeeded":
            break
        if status in ("failed", "cancelled"):
            err = task.get("error") or {}
            msg = err.get("message") if isinstance(err, dict) else None
            raise Muse2APIError(
                f"muse2api video task {task_id} {status}: {msg or 'no detail'}",
                code=(err.get("code") or "") if isinstance(err, dict) else "",
            )
        if time.monotonic() >= deadline:
            raise Muse2APIError(
                f"muse2api video task {task_id} still {status} after {timeout:.0f}s"
            )
        await asyncio.sleep(interval)
        task = _json(await _request("GET", f"/v1/videos/{task_id}", timeout=30.0))

    result = task.get("result") or {}
    url = result.get("url") if isinstance(result, dict) else None
    if not isinstance(url, str) or not url:
        raise Muse2APIError(f"muse2api video task {task_id} succeeded without a url")
    data, mime = await _download(url, timeout=max(60.0, deadline - time.monotonic()))
    if not mime.startswith("video/"):
        mime = (result.get("mime") if isinstance(result.get("mime"), str) else None) or "video/mp4"
    return data, mime
