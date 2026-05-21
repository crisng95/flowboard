"""Concept node — canonical asset sheet system prompt builder.

The Concept node anchors a 3D / game / illustration asset pipeline:
T-pose for humanoids, orthographic 3/4 for vehicles + buildings,
neutral lighting, no environmental context. Downstream Multi-view /
Part / Variant nodes inherit identity from this canonical sheet, so
the prompt prioritises **design clarity** over storytelling — the
opposite priority from the legacy fashion-editorial synth.

Inputs the synth reads from a node:
  - `data.styleKey`   → resolves to STYLE_PRESETS entry
  - `data.typeKey`    → resolves to TYPE_PRESETS entry (T-pose vs 3/4 etc.)
  - upstream refs     → reference / style_pack / mood-board nodes
"""
from __future__ import annotations

from .presets import ref_type_hint, style_tokens, type_clause


# Core directives that apply regardless of style/type. Pulled out of
# the per-call build because they're invariant across the pipeline.
_CONCEPT_CORE = """You are a concept-art prompt builder for a 3D / game / architecture
asset pipeline. Output ONE precise sentence (max 320 chars).

POSE + FRAMING: dictated by the TYPE block below.

LIGHTING: 3-point studio rig — soft key light at 45° camera-right,
fill at 30% intensity from the opposite side, rim light from behind
for clean silhouette separation. Neutral grey background (#808080) or
pure white when style demands.

BACKGROUND — ABSOLUTE RULE: the output MUST show a PLAIN NEUTRAL
BACKGROUND (solid grey #808080 or solid white). There is NO scene,
NO environment, NO ground plane with texture, NO sky, NO foliage,
NO architecture, NO props around the subject. Even if the subject
description mentions a habitat or setting (e.g. "forest elf",
"desert warrior", "underwater creature"), the background stays
PLAIN NEUTRAL — the setting is flavour for the design, NOT a
backdrop to render. Violating this rule makes the output unusable
for the downstream 3D pipeline.

OUTPUT INTENT: this image will be used as a CANONICAL reference sheet.
Downstream Multi-view, Part, and Variant generations will inherit
identity from this output, so:
  • silhouette must be 100% readable
  • design detail must be unambiguous
  • proportions must be true to the type
  • no motion blur, no depth-of-field blur, no stylised camera distortion

Forbidden: stance/action pose (use the canonical pose from TYPE),
hand-on-hip, dramatic angle, motion lines, rule-of-thirds offset,
environmental props, narrative composition, mood lighting,
environmental scene, ambient storytelling, atmospheric perspective,
ground texture, scenic backdrop, matte painting elements."""


def _ref_context_block(ref_nodes: list[dict]) -> str:
    """Build a REFERENCES block from upstream reference node data.

    Each entry surfaces the ref's type hint, aiBrief (vision description),
    and customNote (user annotation) so the LLM knows HOW to use each
    upstream image without the user having to re-explain in the prompt.

    Only included when at least one ref node has usable data.
    """
    lines: list[str] = []
    for node in ref_nodes:
        data = node.get("data") or {}
        ref_type = data.get("refType")
        custom_note = (data.get("customNote") or "").strip()
        ai_brief = (data.get("aiBrief") or "").strip()
        short_id = data.get("shortId") or "?"

        hint = ref_type_hint(ref_type)
        line = f"  - Ref #{short_id} [{ref_type or 'reference'}]: {hint}."
        if ai_brief:
            line += f" Visual: {ai_brief[:150]}"
        if custom_note:
            line += f" Note: {custom_note[:120]}"
        lines.append(line)
    return "\n".join(lines)


def build_concept_system_prompt(
    *,
    style_key: str | None,
    type_key: str | None,
    ref_nodes: list[dict] | None = None,
) -> str:
    """Compose the system prompt for a Concept node generation.

    Returns a complete system prompt ready to send to the auto-prompt
    LLM. Order: core directives → type-specific clause → ref context
    (when upstream refs have type/note/brief) → style tokens → output
    rule.

    `ref_nodes` is a list of upstream reference node dicts (each with
    a `data` key containing `refType`, `aiBrief`, `customNote`).
    """
    parts: list[str] = [_CONCEPT_CORE]

    type_block = type_clause(type_key)
    if type_block:
        parts.append(type_block)
    else:
        parts.append(
            "TYPE = GENERIC\n"
            "  POSE: neutral canonical pose, full silhouette clear\n"
            "  FRAMING: full subject in frame, 8% margin all sides\n"
            "  PRIORITY: design clarity, anatomy / structure readable"
        )

    # Inject upstream reference context when available.
    if ref_nodes:
        ref_block = _ref_context_block(ref_nodes)
        if ref_block:
            parts.append(f"UPSTREAM REFERENCES:\n{ref_block}")

    tokens = style_tokens(style_key)
    if tokens:
        bullets = "\n".join(f"  • {t}" for t in tokens)
        parts.append(f"STYLE TOKENS:\n{bullets}")

    parts.append("Output the concept prompt sentence only — no preamble, no markdown.")
    return "\n\n".join(parts)
