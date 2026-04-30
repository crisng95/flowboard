"""AI-vision brief generation for cached media.

Asks the configured Vision provider (Claude / Gemini / OpenAI / Grok)
to summarise an image into a short factual description ("aiBrief").
Used by:
- Visual asset / character nodes — annotate uploaded or generated images
- Auto-prompt synthesizer — feed those briefs into a downstream prompt

Provider routing goes through ``run_llm("vision", ...)``. The user picks
which one in Settings → AI Providers; default is Claude. Since all 4
providers in v1.2.0 support vision, the registry's vision-capability
gate is currently a defensive no-op — it kicks in if a future text-only
provider is added.

We always pass an ABSOLUTE path so the underlying transport (CLI flag
or HTTP base64) doesn't get tripped up by the agent's cwd.
"""
from __future__ import annotations

import logging

from typing import Optional

from flowboard.services import media as media_service
from flowboard.services.activity import record_activity
from flowboard.services.llm import run_llm
from flowboard.services.llm.base import LLMError

logger = logging.getLogger(__name__)

# Keep briefs short — they get spliced into downstream prompts. 200 chars
# is enough for "white cotton crewneck t-shirt with small heart logo" or
# "young Korean woman, neutral expression, dark hair tied back, dark top".
_VISION_SYSTEM = (
    "You are a visual asset annotator for a fashion / e-commerce media "
    "pipeline. Output one short factual sentence (max 200 characters) that "
    "describes the image. Focus on attributes useful for image generation: "
    "for a product → colour, material, design, fit, style; for a person → "
    "gender, apparent ethnicity, age range, expression, hair, outfit. No "
    "marketing language, no opinions, no preamble — just the description."
)

_VISION_USER_PROMPT = "Describe this image."


class VisionError(RuntimeError):
    pass


async def describe_media(media_id: str, *, node_id: Optional[int] = None) -> str:
    """Return a short factual description of the cached media.

    Raises ``VisionError`` if the media is not cached locally or if the
    configured Vision provider fails. Caller decides whether to retry
    or fall back.

    ``node_id`` (optional) is forwarded to the activity log so the
    feed can show "Vision · #abc1" instead of an orphan row. Callers
    that know the node should pass it; the route-level handler that
    only has ``media_id`` can leave it None.

    Activity log wraps the entire body — cache misses, fetch failures,
    and provider errors all show up as a single "failed" row. The user
    debugging from the activity feed sees every Vision attempt rather
    than only the ones that reached the provider.
    """
    media_id = media_service.normalize_media_id(media_id)
    if not media_service.is_valid_media_id(media_id):
        raise VisionError("invalid media_id")

    async with record_activity(
        "vision", params={"media_id": media_id}, node_id=node_id
    ) as activity:
        cached = media_service.cached_path(media_id)
        if cached is None:
            # Try to fetch from the stored URL once before giving up.
            # Vision makes no sense without bytes.
            result = await media_service.fetch_and_cache(media_id)
            if result is None:
                raise VisionError("media not cached and could not be fetched")
            _bytes, _mime, path = result
            cached = path

        try:
            # 120s ceiling. Vision is usually fast (5-15s on Claude),
            # but Gemini CLI's cold-start adds ~15s per call and image
            # attachment via `@<path>` adds a few more seconds for the
            # CLI to read + base64-encode the file before sending — and
            # Gemini's image inference itself can stretch when the
            # subject is dense (group shots, fine-print products).
            text = await run_llm(
                "vision",
                _VISION_USER_PROMPT,
                system_prompt=_VISION_SYSTEM,
                attachments=[str(cached.resolve())],
                timeout=120.0,
            )
        except LLMError as exc:
            raise VisionError(f"vision provider failed: {exc}") from exc

        # Trim and cap — defence-in-depth in case the model ignores the
        # length cap from the system prompt.
        text = (text or "").strip()
        if not text:
            raise VisionError("empty response from vision provider")
        if len(text) > 400:
            text = text[:400].rstrip() + "…"
        activity.set_result({"description": text})
        return text
