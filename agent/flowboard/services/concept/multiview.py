"""Multi-view node - orthographic turnaround sheet builder.

Industry standard for game / 3D asset pipelines: a "concept turn"
gives the modeler N views of the same character/asset (front, back,
profiles, 3/4 angles) so they can model + texture from consistent
reference. Magnific / Midjourney handle this poorly because every
variant is independently sampled - the modeler ends up with subtly
different proportions across angles.

Concepta solves this with a **sequential edit chain**:

  angle 1 (e.g. "front")  ->  gen_image from the upstream Concept
                              with explicit "front view" prompt
  angle 2 (e.g. "back")   ->  edit_image with base = angle 1's mediaId
                              + prompt "rotate 180° to back view"
  angle 3 (e.g. "left")   ->  edit_image with base = angle 1
                              + prompt "rotate 90° left to profile"
  ...                       ->  ...

Why edit_image not gen_image for angles 2-N:
  Flow's edit_image preserves anatomy + costume + colour palette of
  the base image far better than re-sampling from a reference. The
  modeler gets identical proportions across all N views, only the
  camera angle changes.

Why 1 -> all (not chain 1->2->3->4):
  Each edit_image step degrades fidelity slightly. Chaining linearly
  (each angle from the previous) compounds drift; branching all
  off angle 1 keeps drift constant at one edit step deep.
"""
from __future__ import annotations

from typing import TypedDict


class AnglePrompt(TypedDict):
    """One angle's dispatch payload."""
    angle: str  # e.g. "front", "back", "left profile", "3/4 hero"
    prompt: str
    is_root: bool  # True for angle 1 (gen_image); False for angles 2-N (edit_image)


_MULTIVIEW_CORE = """You are an orthographic turnaround prompt builder. The output is
ONE concept image showing a SPECIFIC named camera angle of an
existing character / asset / prop.

CRITICAL: this is part of a CONSISTENCY SET. The other angles in
the set will be edited from a base image, so consistency is enforced
elsewhere. Your job is just to write a prompt that nails THIS
specific angle.

ANGLE precision (character / creature / robot):
  • "front" = subject facing camera dead-on, both shoulders square
    to lens, centred composition
  • "back" = camera behind subject, back of head visible, no face
  • "left profile" = subject's left side facing camera, 90° rotation
    from front. Right side fully hidden.
  • "right profile" = mirror of left profile
  • "3/4 front-right" = subject rotated ~30-45° clockwise from front,
    showing front + right side. Both eyes visible.
  • "3/4 front-left" = mirror of 3/4 front-right
  • "3/4 back-right" = subject rotated ~135° from front, showing
    back + right side. No face visible.
  • "3/4 back-left" = mirror

ANGLE precision (prop / weapon / outfit):
  • "3/4 hero" = canonical product-photography angle. Subject rotated
    ~30-45° from front, slight high camera (~10-15° above eye level),
    full silhouette readable, design detail prioritised. The default
    "hero shot" you see in art-station portfolio prop sheets.
  • "top-down" = camera directly overhead, looking straight down.
    Reveals outline + scale relative to ground / surface. Common in
    inventory icons + RTS unit views.

POSE: identical to base image. Do NOT change pose between angles.
LIGHTING: same 3-point studio rig.
BACKGROUND: same neutral grey.
FRAMING: same scale (full body / full silhouette).

Output ONE precise sentence (max 200 chars). Mention the angle
explicitly. Don't describe the subject in detail - that's already in
the base image."""


def build_multiview_angle_prompt(angle: str, is_root: bool) -> str:
    """Build the system prompt for one angle's dispatch.

    For the ROOT angle (typically "front" or "3/4 hero"), the prompt
    establishes the canonical view and gets dispatched as a fresh
    gen_image from the upstream Concept node's reference. For
    SUBSEQUENT angles, the prompt is a rotation directive applied via
    edit_image against the root angle's output.

    The system prompt differs subtly between root and child:
      - Root: "establish the canonical <angle> view"
      - Child: "rotate the base image to <angle>; preserve identity"
    """
    if is_root:
        return (
            _MULTIVIEW_CORE
            + f"\n\nMODE: ROOT angle ('{angle}'). This is the reference "
            f"view all other angles will be edited from. Establish a "
            f"clean, centred composition with maximum design clarity."
        )
    return (
        _MULTIVIEW_CORE
        + f"\n\nMODE: ROTATION. Edit the base image to show the "
        f"'{angle}' angle. PRESERVE: subject identity, costume detail, "
        f"colour palette, lighting direction, background tone. CHANGE: "
        f"only the camera angle relative to the subject. Output the "
        f"rotation prompt."
    )


def angles_for_preset(preset_key: str) -> list[str]:
    """Map the frontend MULTIVIEW_PRESETS key -> list of angle strings.

    Mirrors rontend/src/constants/concept.ts > MULTIVIEW_PRESETS.
    Single source of truth lives on the frontend (it's the user-facing
    label set); this is the backend dual.
    """
    presets: dict[str, list[str]] = {
        # Character pipeline (humanoid / creature / robot).
        "4view": ["front", "back", "left profile", "right profile"],
        # Prop / weapon / outfit pipeline. 3/4 hero is the canonical
        # display angle; top-down reveals outline + scale.
        "prop_4view": ["3/4 hero", "front", "back", "top-down"],
    }
    return presets.get(preset_key, presets["4view"])