"""Concepta — game / arch / illustration asset-pipeline prompt synth.

Replaces the fashion-editorial prompt vocabulary that ships with the
upstream Flowboard with concept-art / 3D-asset oriented synth modules.
Each node type has its own builder so the system prompts stay focused
and tunable independently:

  - subject.py    → Concept node (canonical asset sheet)
  - multiview.py  → Multi-view node (orthographic angles)
  - part.py       → Part node (zoomed isolated region)
  - variant.py    → Variant node (alternate states)
  - turntable.py  → Turntable node (Veo i2v orbit camera)

The legacy fashion synth in `services/prompt_synth.py` remains so that
old `image` / `video` nodes keep working — the dispatcher routes by
node type and falls back to legacy when unknown.
"""
from __future__ import annotations

from .multiview import angles_for_preset, build_multiview_angle_prompt
from .part import get_part_label, get_part_prompt, list_part_regions
from .subject import build_concept_system_prompt
from .variant import build_variant_prompt, get_variant_label, list_variant_axes

__all__ = [
    "build_concept_system_prompt",
    "build_multiview_angle_prompt",
    "angles_for_preset",
    "get_part_prompt",
    "get_part_label",
    "list_part_regions",
    "build_variant_prompt",
    "get_variant_label",
    "list_variant_axes",
]
