"""Variant node — alternate states / colorways / equipment swaps.

Use case: artist has a Concept (or Part) and needs N alternate
versions sharing the same identity, varying along ONE explicit axis:
  - color: recolor while preserving form
  - material: metal → leather, fabric → chitin
  - damage: pristine → battle-worn → ruined
  - equipment: weapon swap, armor swap
  - outfit_alt: alternate costume entirely

Mechanism: dispatch as `edit_image` with the upstream as base + an
axis-specific delta prompt. Like Part, edit_image preserves the
source's design language while applying just the requested
variation.

Why not gen_image: same logic as Part — variants must look like
EDITS of the source, not re-rolls. A "red colorway" should preserve
silhouette + materials and only change colour; gen_image with a
reference would jiggle the silhouette.
"""
from __future__ import annotations

from typing import TypedDict


class VariantAxis(TypedDict):
    """One pickable variation axis."""

    key: str
    label: str
    # The user picks an axis + provides a free-text "instruction"
    # (e.g. for axis=color: "deep crimson and gold"). Backend
    # composes the final prompt from this template + instruction.
    # `{instruction}` is interpolated at dispatch time.
    template: str


_VARIANT_AXES: dict[str, VariantAxis] = {
    "color": {
        "key": "color",
        "label": "Color",
        "template": (
            "Recolor the subject to: {instruction}. PRESERVE: silhouette, "
            "design lines, material types (metal stays metal, fabric stays "
            "fabric), structural detail, anatomy, pose, framing, neutral "
            "grey background, lighting. CHANGE: colour palette only. The "
            "result must read as an alternate colorway of the SAME "
            "subject."
        ),
    },
    "material": {
        "key": "material",
        "label": "Material",
        "template": (
            "Swap the subject's materials to: {instruction}. PRESERVE: "
            "silhouette, design lines, anatomy, pose, framing, neutral "
            "grey background, lighting, colour palette where it makes "
            "sense. CHANGE: material rendering — surface roughness, "
            "specular highlights, texture grain. The result must read "
            "as the SAME subject re-imagined in different materials."
        ),
    },
    "damage": {
        "key": "damage",
        "label": "Damage state",
        "template": (
            "Apply this damage / wear state: {instruction}. PRESERVE: "
            "silhouette, anatomy, base design, pose, framing, neutral "
            "grey background, lighting, base colour palette. CHANGE: "
            "add weathering, scratches, dents, tears, dirt, bloodstains, "
            "missing pieces, charring — whatever the instruction calls "
            "for. The result must read as the SAME subject after the "
            "described damage."
        ),
    },
    "equipment": {
        "key": "equipment",
        "label": "Equipment",
        "template": (
            "Swap the subject's equipment / gear: {instruction}. "
            "PRESERVE: subject's body, anatomy, identity, pose, framing, "
            "neutral grey background, lighting, base outfit colours where "
            "unaffected. CHANGE: weapons, shields, accessories, armor "
            "pieces — whichever the instruction targets. The result must "
            "read as the SAME subject with different gear."
        ),
    },
    "outfit_alt": {
        "key": "outfit_alt",
        "label": "Outfit alt",
        "template": (
            "Replace the subject's outfit with: {instruction}. PRESERVE: "
            "subject's body, anatomy, face, identity, pose, framing, "
            "neutral grey background, lighting, overall mood. CHANGE: "
            "the entire wardrobe / armor / costume to match the "
            "instruction. The result must read as the SAME character "
            "wearing a different outfit."
        ),
    },
}


def list_variant_axes() -> list[VariantAxis]:
    """Axes in declaration order."""
    return list(_VARIANT_AXES.values())


def build_variant_prompt(axis_key: str, instruction: str) -> str | None:
    """Compose the dispatched prompt by interpolating the user's
    instruction into the axis template. Returns None when axis_key
    is unknown.

    `instruction` is the free-text string the user typed in the
    Variant node — e.g. for axis=color, "deep crimson and gold trim".
    We strip + clamp to a reasonable length so a runaway instruction
    can't blow Flow's prompt size cap.
    """
    axis = _VARIANT_AXES.get(axis_key)
    if axis is None:
        return None
    cleaned = (instruction or "").strip()
    if not cleaned:
        # Fallback: axis label as the instruction. Users sometimes
        # leave the field blank expecting a "default variant" — the
        # synth handles that by returning an axis-generic prompt.
        cleaned = f"a different {axis['label'].lower()}"
    if len(cleaned) > 280:
        cleaned = cleaned[:280].rstrip()
    return axis["template"].format(instruction=cleaned)


def get_variant_label(axis_key: str) -> str | None:
    axis = _VARIANT_AXES.get(axis_key)
    return axis["label"] if axis else None
