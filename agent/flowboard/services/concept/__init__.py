"""Concepta — game / arch / illustration asset-pipeline prompt synth.

Replaces the fashion-editorial prompt vocabulary that ships with the
upstream Flowboard with concept-art / 3D-asset oriented synth modules.
Each node type has its own builder so the system prompts stay focused
and tunable independently:

  - variant.py    → Variant node (alternate states)

The legacy fashion synth in `services/prompt_synth.py` remains so that
old `image` / `video` nodes keep working — the dispatcher routes by
node type and falls back to legacy when unknown.
"""
from __future__ import annotations

from .variant import build_variant_prompt, get_variant_label, list_variant_axes

__all__ = [
    "build_variant_prompt",
    "get_variant_label",
    "list_variant_axes",
]
