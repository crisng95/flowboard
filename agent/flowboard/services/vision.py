"""AI-vision brief generation for cached media.

Asks the configured Vision provider (Claude / Gemini / OpenAI Codex)
to summarise an image into a short factual description ("aiBrief").
Used by:
- Visual asset / character nodes — annotate uploaded or generated images
- Auto-prompt synthesizer — feed those briefs into a downstream prompt

Provider routing goes through ``run_llm("vision", ...)``. The user picks
which one in Settings → AI Providers — there is no default; the forced
setup gate ensures one is chosen before the app is usable. All three
shipped providers support vision, so the registry's vision-capability
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

# Reference tags routed into a non-default vision profile. Mirrors
# `_MATERIAL_TAGS` / `_HYBRID_TAGS` in
# `flowboard/services/prompt_synth.py`; duplicated here so this module
# has zero import coupling with prompt_synth (avoids a circular
# dependency via the LLM registry).
_MATERIAL_REF_TAGS = frozenset({"texture", "material", "style", "lighting", "mood"})
_HYBRID_REF_TAGS = frozenset({"photo", "3d_render"})

# Profile keys returned by `_resolve_profile`. Each profile carries a
# (system_prompt, user_prompt) pair tuned to a specific role:
#
#   texture_material   - surface / shader / palette
#   lighting_mood      - lighting / atmosphere / colour grading
#   style_only         - artistic medium / brushwork
#   photo_as_material  - hybrid `photo` ref demoted to material
#   render_as_material - hybrid `3d_render` ref demoted to material
#   default            - fashion / e-commerce annotator (legacy)
#
# Every non-default profile shares the same critical rule: do NOT name
# the pictured object. The brief is spliced into auto-prompt synth,
# and object nouns there (`sword`, `dagger`, `hallway`, `dancer`)
# leak structure into the generated image and re-introduce the
# composite bug fixed in `prompt_synth.py`.

_PROMPT_TEXTURE_MATERIAL = (
    "You are a texture and material analyzer. Output ONE short "
    "factual sentence (max 200 characters) describing ONLY the "
    "material properties of the image: surface finish (matte, "
    "glossy, translucent, polished), texture (smooth, rough, "
    "crystalline, woven, eroded), color palette (use concrete "
    "adjectives like 'cyan-blue', 'bone-white', 'oxidised copper'), "
    "and lighting feel (rim-lit, sub-surface glow, hard shadow).\n\n"
    "CRITICAL CONSTRAINTS:\n"
    "- DO NOT name the literal object pictured. If the image shows a "
    "sword, do NOT use 'sword', 'blade', 'weapon', 'dagger', "
    "'hilt'. If it shows a creature, do NOT use 'creature', "
    "'organism', 'animal'. Strip every object/part noun.\n"
    "- DO NOT count objects (no 'two', 'pair of', 'set of').\n"
    "- DO NOT describe shape, silhouette, or composition.\n"
    "- DO use phrasing like 'glowing cyan crystalline material with "
    "bone-white finish and rim-lit edges'.\n"
    "No marketing language, no opinions, no preamble - output the "
    "material description sentence only."
)
_USER_TEXTURE_MATERIAL = (
    "Describe ONLY the material, surface, palette, and lighting of "
    "this image. Do not name the object pictured."
)

_PROMPT_LIGHTING_MOOD = (
    "You are a lighting and atmosphere analyzer. Output ONE short "
    "factual sentence (max 200 characters) describing ONLY: light "
    "colour temperature (warm tungsten, cool moonlight, neon "
    "magenta), light direction and quality (hard rim-light from "
    "upper-left, soft diffused fill, hazy backlight), shadow "
    "behaviour (long crisp shadows, soft falloff, no shadow), and "
    "overall colour grading / mood (teal-and-orange, desaturated "
    "melancholy, high-contrast noir, sun-bleached).\n\n"
    "CRITICAL CONSTRAINTS:\n"
    "- DO NOT name any object, person, animal, or location pictured. "
    "If the image shows a dancer in a hallway, do NOT use 'dancer', "
    "'person', 'hallway', 'corridor', 'room', 'building'. Strip "
    "every subject and setting noun.\n"
    "- DO NOT describe shape, silhouette, composition, or pose.\n"
    "- DO use phrasing like 'warm tungsten key from upper-left with "
    "soft cool fill, long crisp shadows, teal-and-orange grade, "
    "melancholy late-evening mood'.\n"
    "No marketing language, no opinions, no preamble - output the "
    "lighting / atmosphere description sentence only."
)
_USER_LIGHTING_MOOD = (
    "Describe ONLY the lighting, shadows, colour grading, and "
    "atmosphere of this image. Do not name the subject or setting."
)

_PROMPT_STYLE_ONLY = (
    "You are an artistic style analyzer. Output ONE short factual "
    "sentence (max 200 characters) describing ONLY: medium (oil "
    "paint, watercolour, gouache, acrylic, digital, ink, pencil, "
    "woodblock, 3D render style), brushwork or stroke quality "
    "(loose impasto, fine pen hatching, flat cel-shading, soft "
    "airbrush gradient), line weight, and rendering technique "
    "(stylised toon, semi-realistic painterly, photoreal, "
    "low-poly).\n\n"
    "CRITICAL CONSTRAINTS:\n"
    "- DO NOT name any object, person, animal, or location "
    "pictured. If the image shows a knight on a horse, do NOT use "
    "'knight', 'horse', 'rider', 'armour'. Strip every subject "
    "noun.\n"
    "- DO NOT describe colour palette, lighting, mood, or "
    "composition - those belong to other reference roles.\n"
    "- DO use phrasing like 'loose impasto oil painting with thick "
    "directional brush strokes and visible canvas weave, "
    "semi-realistic painterly rendering'.\n"
    "No marketing language, no opinions, no preamble - output the "
    "style description sentence only."
)
_USER_STYLE_ONLY = (
    "Describe ONLY the artistic medium, brushwork, and rendering "
    "technique of this image. Do not name the subject pictured."
)

_PROMPT_HYBRID_AS_MATERIAL = (
    "You are a surface-and-detail analyzer for a hybrid reference "
    "that is being demoted to a material/style sample. Output ONE "
    "short factual sentence (max 200 characters) describing ONLY: "
    "surface finish, micro-texture and detail density, colour "
    "palette, and lighting feel. Behave as if the image were a "
    "material chip - the structural form on screen is irrelevant "
    "and must be discarded.\n\n"
    "CRITICAL CONSTRAINTS:\n"
    "- DO NOT name the literal object, person, vehicle, animal, "
    "location, or any visible part. If the image shows a sports "
    "car in a desert, do NOT use 'car', 'vehicle', 'wheel', "
    "'desert', 'sand', 'driver'. Strip every subject and setting "
    "noun.\n"
    "- DO NOT describe shape, silhouette, pose, or composition.\n"
    "- DO use phrasing like 'photoreal polished metallic finish "
    "with crisp specular highlights, warm-amber palette, hazy "
    "sun-flare lighting, fine micro-scratch detail'.\n"
    "No marketing language, no opinions, no preamble - output the "
    "material / detail description sentence only."
)
_USER_HYBRID_AS_MATERIAL = (
    "Describe ONLY the surface finish, micro-texture, palette, and "
    "lighting feel of this image. Do not name any object, person, "
    "or location."
)

_PROMPT_POSE_ONLY = (
    "You are a skeletal and pose analyzer. Output ONE short factual "
    "sentence (max 200 characters) describing ONLY: body mechanics "
    "and stance (standing, crouched, mid-stride, leaning), gesture "
    "and limb placement (left arm raised at shoulder height, right "
    "hand on hip, fingers curled), weight distribution (weight on "
    "front leg, hips squared, slight contrapposto), body angle "
    "(three-quarter to camera, profile, frontal), and camera "
    "perspective (low angle, eye level, slight high-angle).\n\n"
    "CRITICAL CONSTRAINTS:\n"
    "- DO NOT describe character identity in any form. Strip ALL "
    "references to gender, age, ethnicity, body type, facial "
    "features, expression, hair style, hair colour, eye colour, "
    "skin tone.\n"
    "- DO NOT describe clothing. Strip every garment noun "
    "('crop-top', 'jacket', 'gloves', 'boots'), clothing colour, "
    "fabric, accessory, prop, or weapon.\n"
    "- DO NOT describe environment, background, lighting, or "
    "rendering style.\n"
    "- DO use phrasing like 'figure stands in slight contrapposto "
    "with weight on left leg, right arm extended forward at "
    "shoulder height, torso angled three-quarter to camera, eye-"
    "level perspective'.\n"
    "No marketing language, no opinions, no preamble - output the "
    "pose / mechanics description sentence only."
)
_USER_POSE_ONLY = (
    "Describe ONLY the body mechanics, stance, gesture, weight "
    "distribution, and camera angle. Do not describe identity, "
    "clothing, or environment."
)

_PROMPT_SKETCH_ONLY = (
    "You are a linework and composition analyzer for sketches, "
    "blueprints, and orthographic references. Output ONE short "
    "factual sentence (max 200 characters) describing ONLY: line "
    "work and stroke quality (clean technical pen, loose graphite, "
    "vector contour, ink wash), silhouette and proportions "
    "(elongated, stocky, large-headed, 1:7 ratio), compositional "
    "layout (centered figure, three-quarter front view, multiple "
    "views side by side), and structural notation (construction "
    "lines, perspective grid, callout arrows).\n\n"
    "CRITICAL CONSTRAINTS:\n"
    "- DO NOT describe colour, palette, material, finish, or "
    "shading - this is a structure-only profile.\n"
    "- DO NOT describe lighting, mood, or rendering style.\n"
    "- DO NOT name the depicted character or object beyond the "
    "minimum needed to call out silhouette ('humanoid silhouette' "
    "is fine; 'a sword-wielding knight' is not).\n"
    "- DO use phrasing like 'clean technical pen linework with "
    "construction lines visible, humanoid silhouette in 1:7 "
    "proportions, three-quarter front view centered on the page'.\n"
    "No marketing language, no opinions, no preamble - output the "
    "linework / composition description sentence only."
)
_USER_SKETCH_ONLY = (
    "Describe ONLY the linework, silhouette, proportions, and "
    "compositional layout. Do not describe colour, material, or "
    "lighting."
)

# Profile registry. Keys are stable (logged + persisted in activity
# params); values are the (system_prompt, user_prompt) tuple sent to
# the vision provider. Adding a new profile is a one-line change
# here plus a branch in `_resolve_profile`.
_VISION_PROFILES: dict[str, tuple[str, str]] = {
    "texture_material": (_PROMPT_TEXTURE_MATERIAL, _USER_TEXTURE_MATERIAL),
    "lighting_mood": (_PROMPT_LIGHTING_MOOD, _USER_LIGHTING_MOOD),
    "style_only": (_PROMPT_STYLE_ONLY, _USER_STYLE_ONLY),
    "photo_as_material": (_PROMPT_HYBRID_AS_MATERIAL, _USER_HYBRID_AS_MATERIAL),
    "render_as_material": (_PROMPT_HYBRID_AS_MATERIAL, _USER_HYBRID_AS_MATERIAL),
    "pose_only": (_PROMPT_POSE_ONLY, _USER_POSE_ONLY),
    "sketch_only": (_PROMPT_SKETCH_ONLY, _USER_SKETCH_ONLY),
}


def _resolve_profile(
    ref_type: Optional[str],
    force_material_mode: bool,
) -> Optional[str]:
    """Return the profile key for this (ref_type, force_material_mode)
    pair, or ``None`` if the default annotator should be used.

    Resolution order:
      1. Material tags get tag-specific profiles. `texture` /
         `material` share the surface analyzer; `lighting` / `mood`
         share the atmosphere analyzer; `style` gets its own.
      2. Structural tags get structure-only profiles. `pose` routes
         through a skeletal/pose analyzer that strips identity and
         clothing nouns; `sketch` / `blueprint` route through a
         linework analyzer that strips colour and material nouns.
         Both keep the structure description focused so a downstream
         material/style ref can be layered on without conflict.
      3. Hybrid tags (`photo`, `3d_render`) only swap profile when
         `force_material_mode` is set - that flag means the upstream
         graph also contains a structural ref, so the hybrid is being
         demoted by the burn-and-bake rule.
      4. Anything else falls through to the default annotator.
    """
    if not isinstance(ref_type, str):
        return None
    rt = ref_type.lower()
    if rt in {"texture", "material"}:
        return "texture_material"
    if rt in {"lighting", "mood"}:
        return "lighting_mood"
    if rt == "style":
        return "style_only"
    if rt == "pose":
        return "pose_only"
    if rt in {"sketch", "blueprint"}:
        return "sketch_only"
    if force_material_mode and rt == "photo":
        return "photo_as_material"
    if force_material_mode and rt == "3d_render":
        return "render_as_material"
    return None


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


async def describe_media(
    media_id: str,
    *,
    node_id: Optional[int] = None,
    ref_type: Optional[str] = None,
    force_material_mode: bool = False,
) -> str:
    """Return a short factual description of the cached media.

    Raises ``VisionError`` if the media is not cached locally or if the
    configured Vision provider fails. Caller decides whether to retry
    or fall back.

    ``node_id`` (optional) is forwarded to the activity log so the
    feed can show "Vision · #abc1" instead of an orphan row. Callers
    that know the node should pass it; the route-level handler that
    only has ``media_id`` can leave it None.

    ``ref_type`` (optional) is the upstream `add_reference.refType`.
    When it falls in the material-tag set (texture / material / style
    / lighting / mood) the vision call uses a material-only system
    prompt that strips object nouns from the brief. The brief is later
    spliced into the auto-prompt synthesiser; any object noun there
    leaks structure into the generated image and undoes the burn-and-
    bake fix in ``prompt_synth.py``.

    ``force_material_mode`` (optional) tells the resolver to demote a
    hybrid ref (``photo`` / ``3d_render``) to a material profile. The
    frontend sets this when the same target also has a structural
    ``add_reference`` upstream - the burn-and-bake rule treats hybrid
    refs as material samples in that scenario, so their briefs must
    strip subject nouns just like the other material profiles.

    Activity log wraps the entire body — cache misses, fetch failures,
    and provider errors all show up as a single "failed" row. The user
    debugging from the activity feed sees every Vision attempt rather
    than only the ones that reached the provider.
    """
    media_id = media_service.normalize_media_id(media_id)
    if not media_service.is_valid_media_id(media_id):
        raise VisionError("invalid media_id")

    profile_key = _resolve_profile(ref_type, force_material_mode)
    if profile_key is None:
        system_prompt, user_prompt = _VISION_SYSTEM, _VISION_USER_PROMPT
    else:
        system_prompt, user_prompt = _VISION_PROFILES[profile_key]

    async with record_activity(
        "vision",
        params={
            "media_id": media_id,
            "ref_type": ref_type,
            "force_material_mode": force_material_mode,
            "profile": profile_key or "default",
        },
        node_id=node_id,
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
                user_prompt,
                system_prompt=system_prompt,
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
