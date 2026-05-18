"""Part node — zoomed isolated region of a Concept.

Use case: artist has a Concept sheet (full body) and needs a clean
close-up of one component (head, weapon, boots, armor piece) for
detailed reference. Output goes back into the modeling pipeline as
a high-density texture / detail reference.

Mechanism: dispatch as `edit_image` with the upstream Concept's
mediaId as base + a "zoom + isolate" prompt. edit_image keeps the
design language (colors, materials, line work) of the source while
re-cropping and re-lighting on the requested part.

Why edit_image not gen_image: the part should look IDENTICAL to the
corresponding region of the source — same scratches, same fabric
weave, same metal scuffs. gen_image with a reference would re-roll
detail; edit_image preserves it.

Per-region preset list mirrors the frontend `PART_REGIONS` enum so
the user picks a label and the backend resolves it into a precise
camera direction.
"""
from __future__ import annotations

from typing import TypedDict


class PartRegion(TypedDict):
    """One pickable region with its zoom directive."""

    key: str
    label: str
    # The full prompt that gets dispatched as edit_image. Includes
    # framing, isolation, and lighting directives. Subject identity is
    # preserved by Flow's edit_image base-image path.
    prompt: str


# Region presets — chosen to cover 80% of game-asset zoom-in needs.
# Each prompt:
#   - Names the EXACT region (no ambiguity to Flow)
#   - Demands isolation on neutral background (re-establishes the
#     studio-grey baseline even if the source had environment context)
#   - Specifies framing scale ("close-up", "tight", "fills 70%")
#   - Asks for design clarity (sharp focus on detail)
#
# All prompts cap at ~250 chars so the dispatch payload stays light.
_PART_REGIONS: dict[str, PartRegion] = {
    "head": {
        "key": "head",
        "label": "Head & face",
        "prompt": (
            "CROP to head and face ONLY — show neck-up, NOTHING below "
            "the collarbone. REMOVE the body entirely. Frame the head "
            "filling 70% of the image. Plain neutral grey background "
            "(#808080), no environment. Even studio lighting, sharp focus "
            "on facial features, helmet, mask, hair detail. Same character "
            "identity, same colour palette, same material treatment as "
            "source. Do NOT show shoulders, torso, or any body below neck."
        ),
    },
    "torso": {
        "key": "torso",
        "label": "Torso & armor",
        "prompt": (
            "CROP to torso ONLY — show collarbone to waist, NOTHING "
            "above the neck, NOTHING below the waist. REMOVE head and "
            "legs entirely. Frame the torso filling 75% of the image. "
            "Plain neutral grey background (#808080), no environment. "
            "Even studio lighting, sharp focus on chest armor, outfit "
            "detail, clasps, fabric texture. Same character identity, "
            "same palette, same materials as source. Do NOT show full body."
        ),
    },
    "arms": {
        "key": "arms",
        "label": "Arms & gloves",
        "prompt": (
            "CROP to arms ONLY — show shoulder to fingertips, REMOVE "
            "the torso, head, and legs entirely. Display the arms "
            "isolated, filling 70% of the frame. Plain neutral grey "
            "background (#808080), no environment. Even studio lighting, "
            "sharp focus on sleeve detail, gauntlet, glove design, hand "
            "pose, finger articulation. Same identity, same palette, "
            "same materials. Do NOT show the full body or torso."
        ),
    },
    "legs": {
        "key": "legs",
        "label": "Legs & boots",
        "prompt": (
            "CROP to legs ONLY — show waist to feet, REMOVE the torso, "
            "head, and arms entirely. Display the legs isolated, filling "
            "75% of the frame. Plain neutral grey background (#808080), "
            "no environment. Even studio lighting, sharp focus on greaves, "
            "trousers, boot design, knee detail, sole and heel structure. "
            "Same identity, same palette, same materials as source. "
            "Do NOT show the upper body."
        ),
    },
    "weapon": {
        "key": "weapon",
        "label": "Weapon",
        "prompt": (
            "Isolate the weapon ONLY — REMOVE all body parts, no hands, "
            "no fingers, no arms holding it. Display the full weapon "
            "length alone on plain neutral grey background (#808080), "
            "3/4 hero angle, even studio lighting, sharp focus on blade "
            "edge, barrel, grip, decorative engraving. Preserve the exact "
            "design from source. NOTHING else in frame except the weapon."
        ),
    },
    "outfit_top": {
        "key": "outfit_top",
        "label": "Outfit top",
        "prompt": (
            "Isolate the TOP garment ONLY — shirt, coat, or armor torso "
            "piece. REMOVE the body, head, arms, and legs. Display the "
            "garment flat or on invisible mannequin, plain neutral grey "
            "background (#808080), even studio lighting, sharp focus on "
            "fabric texture, seams, trim, fasteners. Same exact design, "
            "colours, materials as source. No body visible."
        ),
    },
    "outfit_bottom": {
        "key": "outfit_bottom",
        "label": "Outfit bottom",
        "prompt": (
            "Isolate the BOTTOM garment ONLY — pants, skirt, or leg "
            "armor. REMOVE the body, head, torso, and arms. Display the "
            "garment flat or on invisible mannequin, plain neutral grey "
            "background (#808080), even studio lighting, sharp focus on "
            "fabric texture, seams, trim. Preserve exact design, colours, "
            "materials as source. No body visible."
        ),
    },
    "accessory": {
        "key": "accessory",
        "label": "Accessory",
        "prompt": (
            "Isolate ONE accessory item ONLY — backpack, bag, cape, belt, "
            "amulet, or wing — whichever is most visually distinctive. "
            "REMOVE the body entirely. Display the accessory alone on "
            "plain neutral grey background (#808080), 3/4 hero angle, "
            "even studio lighting, sharp focus on construction detail. "
            "Preserve exact design from source. NOTHING else in frame."
        ),
    },
}


def list_part_regions() -> list[PartRegion]:
    """Return regions in declaration order (UI-stable)."""
    return list(_PART_REGIONS.values())


def get_part_prompt(region_key: str) -> str | None:
    """Return the dispatch prompt for a region, or None when unknown."""
    region = _PART_REGIONS.get(region_key)
    return region["prompt"] if region else None


def get_part_label(region_key: str) -> str | None:
    """Return the user-facing label for a region. Used by the activity
    feed + result viewer to display "Part: Head & face" instead of the
    raw `head` key."""
    region = _PART_REGIONS.get(region_key)
    return region["label"] if region else None
