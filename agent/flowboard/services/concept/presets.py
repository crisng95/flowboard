"""Style + type preset dictionaries — backend mirror of the frontend
``constants/concept.ts``. Single source of truth for the synth modules
so they don't have to embed token bags inline.

Frontend persists `styleKey` and `typeKey` onto the node's `data` blob;
the backend reads them here and splices the matching tokens into the
system prompt at dispatch time.

Keep this file in lock-step with `frontend/src/constants/concept.ts` —
each `key` MUST match across the wire.
"""
from __future__ import annotations

from typing import TypedDict


class StylePreset(TypedDict):
    key: str
    label: str
    tokens: list[str]


class TypePreset(TypedDict):
    key: str
    label: str
    pose: str
    framing: str
    extra: str


# ── Style presets ────────────────────────────────────────────────────────

STYLE_PRESETS: dict[str, StylePreset] = {
    "stylized_3d": {
        "key": "stylized_3d",
        "label": "Stylized 3D",
        "tokens": [
            "stylized 3D production look (Riot/Blizzard quality)",
            "clean PBR materials with hand-painted texture detail",
            "exaggerated proportions, slightly cartoony silhouette",
            "matte highlights, soft surface shading, no photoreal grit",
        ],
    },
    "semi_realistic_pbr": {
        "key": "semi_realistic_pbr",
        "label": "Semi-realistic PBR",
        "tokens": [
            "semi-realistic PBR rendering (Unreal Engine asset feel)",
            "physically-grounded materials (metal, leather, fabric, stone)",
            "subtle stylisation, anatomy slightly idealised",
            "octane/marmoset render quality, sharp surface micro-detail",
        ],
    },
    "anime": {
        "key": "anime",
        "label": "Anime 2D",
        "tokens": [
            "anime 2D key-art style (Genshin Impact / Honkai Star Rail)",
            "cel-shaded with crisp linework and limited shadow tones",
            "anime proportions (slim torso, large eyes, stylised hair)",
            "painterly highlight rim, soft saturated palette",
        ],
    },
    "realistic_concept": {
        "key": "realistic_concept",
        "label": "Realistic concept",
        "tokens": [
            "realistic concept art (ArtStation portfolio piece)",
            "photoreal lighting and surface detail",
            "octane / vray render quality, anatomically accurate proportions",
            "true-to-life materials, no stylisation",
        ],
    },
    "lowpoly": {
        "key": "lowpoly",
        "label": "Lowpoly",
        "tokens": [
            "lowpoly flat-shaded aesthetic (PS1 / N64 era)",
            "visible polygon facets, limited 16-32 colour palette",
            "no smooth shading, no normal-map detail, hard edges",
            "geometric simplification, charming retro look",
        ],
    },
    "photoreal_arch": {
        "key": "photoreal_arch",
        "label": "Photorealistic Arch",
        "tokens": [
            "photorealistic architecture render (Corona / V-Ray quality)",
            "physically accurate sun + sky lighting, true-to-scale geometry",
            "fine material detail (concrete, glass, timber, metal cladding)",
            "professional architectural visualisation, no stylisation",
        ],
    },
}


# ── Type presets ─────────────────────────────────────────────────────────

TYPE_PRESETS: dict[str, TypePreset] = {
    "humanoid": {
        "key": "humanoid",
        "label": "Humanoid",
        "pose": "T-pose, arms outstretched horizontally at 90°, palms forward",
        "framing": "full body in frame, 8% headroom, no extremity crop, head at frame top, feet at frame bottom",
        "extra": "anatomically readable proportions, design clarity prioritised over expression",
    },
    "creature": {
        "key": "creature",
        "label": "Creature",
        "pose": "neutral standing pose with limbs extended for clear silhouette",
        "framing": "full body in frame, generous headroom for horns / wings, no extremity crop",
        "extra": "anatomy readable, all limbs visible, claws / fangs / horns clearly defined",
    },
    "robot": {
        "key": "robot",
        "label": "Robot",
        "pose": "T-pose with mechanical arms outstretched, joint clarity prioritised",
        "framing": "full body in frame, 8% headroom, panel seams + joint lines clearly visible",
        "extra": "hard-surface clarity, modular component readability, mechanical detail at every joint",
    },
    "vehicle": {
        "key": "vehicle",
        "label": "Vehicle",
        "pose": "orthographic 3/4 front view, wheels/tracks/thrusters fully visible",
        "framing": "full vehicle silhouette, ground line implied, 8% margin all sides",
        "extra": "structural detail readable, wheel wells / cockpit / engine bay clearly defined",
    },
    "building": {
        "key": "building",
        "label": "Building",
        "pose": "orthographic 3/4 front-corner view, ground level visible",
        "framing": "entire building silhouette in frame, 10% headroom for roofline, ground line visible",
        "extra": "architectural scale relative to human reference, façade material readable",
    },
    "prop": {
        "key": "prop",
        "label": "Prop",
        "pose": "centered 3/4 hero angle, isolated on background",
        "framing": "object fills 60% of frame, generous margin all sides",
        "extra": "design detail prioritised, material + scale ambiguity removed",
    },
    "weapon": {
        "key": "weapon",
        "label": "Weapon",
        "pose": "horizontal layout angle showing full weapon length, 3/4 perspective for grip detail",
        "framing": "weapon spans 75% of frame width, blade/barrel direction unambiguous",
        "extra": "blade-edge and grip detail prioritised, decorative engraving visible at full resolution",
    },
    "outfit": {
        "key": "outfit",
        "label": "Outfit",
        "pose": "displayed on invisible mannequin in T-pose, garment fully spread",
        "framing": "full garment in frame including any cape/cloak length, 8% margin",
        "extra": "fabric drape and material weight readable, seams and trim detail visible",
    },
}


def style_tokens(key: str | None) -> list[str]:
    """Tokens for a style key, or empty list when key is unknown / missing.

    Synth modules accept the empty fallback so a Concept node without a
    style picked still produces a usable prompt — just one without
    style-specific guidance.
    """
    if not key:
        return []
    preset = STYLE_PRESETS.get(key)
    return list(preset["tokens"]) if preset else []


def type_clause(key: str | None) -> str:
    """Single multi-line block ready to splice into a system prompt for
    the resolved type. Empty string when key is unknown — synth handles
    the fallback inline.
    """
    if not key:
        return ""
    preset = TYPE_PRESETS.get(key)
    if not preset:
        return ""
    return (
        f"TYPE = {preset['label'].upper()}\n"
        f"  POSE: {preset['pose']}\n"
        f"  FRAMING: {preset['framing']}\n"
        f"  PRIORITY: {preset['extra']}"
    )


# ── Reference type hints ──────────────────────────────────────────────────────
#
# Backend mirror of frontend `constants/concept.ts > REFERENCE_TYPES`.
# Keep keys in lock-step with the frontend constant — every key in
# REFERENCE_TYPES must have an entry here so the LLM gets a usage hint
# instead of falling through to the generic "Use as visual reference".

REFERENCE_TYPE_HINTS: dict[str, str] = {
    "sketch":      "Use as structural/silhouette guide (linework, wireframe)",
    "pose":        "Use as pose / body-language reference",
    "photo":       "Use as photographic realism reference",
    "texture":     "Use as surface / material sample reference",
    "lighting":    "Use as lighting direction and quality reference",
    "mood":        "Use as atmosphere / emotional tone / color-grade reference",
    "style":       "Use as artistic style / rendering-technique reference",
    "environment": "Use as background / environment / scene reference",
    "3d_render":   "Use as 3D form / volume / shading reference",
    "blueprint":   "Use as technical / orthographic blueprint reference",
}


def ref_type_hint(key: str | None) -> str:
    """Return the prompt hint for a reference type key.

    Falls back to a generic hint when key is unknown / missing so
    downstream synth modules always get a usable string.
    """
    if not key:
        return "Use as visual reference"
    return REFERENCE_TYPE_HINTS.get(key, "Use as visual reference")
