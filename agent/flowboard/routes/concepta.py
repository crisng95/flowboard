"""Concepta-fork metadata routes.

Lightweight read-only endpoints the frontend hits on first render to
hydrate Part / Variant pickers. Keeping the canonical list on the
backend lets us evolve presets without shipping a frontend redeploy.

Endpoints:
  GET /api/concepta/part-regions  → [{key, label}]
  GET /api/concepta/variant-axes  → [{key, label}]

The label-only shape keeps the wire payload tiny — the frontend uses
key for dispatch + label for the dropdown UI; the full prompt
templates stay backend-side where they belong.
"""
from __future__ import annotations

from fastapi import APIRouter

from flowboard.services.concept import list_part_regions, list_variant_axes

router = APIRouter(prefix="/api/concepta", tags=["concepta"])


@router.get("/part-regions")
def get_part_regions() -> list[dict]:
    """Surface the Part region presets to the frontend picker.

    Drops the `prompt` field on the wire — only key + label are
    needed UI-side; the dispatched prompt is composed in
    `_handle_gen_part` from the same key.
    """
    return [{"key": r["key"], "label": r["label"]} for r in list_part_regions()]


@router.get("/variant-axes")
def get_variant_axes() -> list[dict]:
    """Surface the Variant axis presets to the frontend picker.

    Same shape as part-regions — drop the prompt template.
    """
    return [{"key": a["key"], "label": a["label"]} for a in list_variant_axes()]
