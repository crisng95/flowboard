/**
 * Concept-pipeline presets â€” the shared dictionaries that every Concepta
 * node reads from. Mirrors the legacy `character.ts` shape so existing
 * `countryLabel` / `vibeLabel` patterns translate 1:1.
 *
 *   STYLE_PRESETS â€” picks the visual treatment (Stylized 3D, anime, â€¦).
 *                   Surfaces in StylePack node + Concept node picker.
 *   TYPE_PRESETS  â€” picks the asset kind (Humanoid, Vehicle, Building, â€¦).
 *                   Drives the synth's pose / framing rules.
 *
 * `tokens[]` are the LLM-facing strings appended to the auto-prompt
 * during dispatch. `label` is the Vietnamese UI string for the picker
 * chip. `key` is the stable id persisted into `node.data.styleKey` /
 * `node.data.typeKey` so reloads + viewers can map back.
 */

// â”€â”€ Style presets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Each style ships a small bag of LLM tokens that the synth splices
// into the system prompt. Tokens are kept terse (â‰¤ 60 chars each) so
// the system prompt budget isn't blown when one style is selected
// alongside a long type-specific clause.

export const STYLE_PRESETS = [
  {
    key: "stylized_3d",
    label: "Stylized 3D",
    hint: "Riot Â· Blizzard Â· Overwatch Â· League â€” clean PBR + hand-painted detail",
    tokens: [
      "stylized 3D production look (Riot/Blizzard quality)",
      "clean PBR materials with hand-painted texture detail",
      "exaggerated proportions, slightly cartoony silhouette",
      "matte highlights, soft surface shading, no photoreal grit",
    ],
  },
  {
    key: "semi_realistic_pbr",
    label: "Semi-realistic PBR",
    hint: "Unreal asset feel â€” grounded materials with light stylisation",
    tokens: [
      "semi-realistic PBR rendering (Unreal Engine asset feel)",
      "physically-grounded materials (metal, leather, fabric, stone)",
      "subtle stylisation, anatomy slightly idealised",
      "octane/marmoset render quality, sharp surface micro-detail",
    ],
  },
  {
    key: "anime",
    label: "Anime 2D",
    hint: "Genshin Â· Honkai key art â€” cel-shaded, anime proportions",
    tokens: [
      "anime 2D key-art style (Genshin Impact / Honkai Star Rail)",
      "cel-shaded with crisp linework and limited shadow tones",
      "anime proportions (slim torso, large eyes, stylised hair)",
      "painterly highlight rim, soft saturated palette",
    ],
  },
  {
    key: "realistic_concept",
    label: "Realistic concept",
    hint: "ArtStation portfolio piece â€” photoreal lighting, fine detail",
    tokens: [
      "realistic concept art (ArtStation portfolio piece)",
      "photoreal lighting and surface detail",
      "octane / vray render quality, anatomically accurate proportions",
      "true-to-life materials, no stylisation",
    ],
  },
  {
    key: "lowpoly",
    label: "Lowpoly",
    hint: "PS1 / flat-shaded â€” faceted geometry, limited palette",
    tokens: [
      "lowpoly flat-shaded aesthetic (PS1 / N64 era)",
      "visible polygon facets, limited 16-32 colour palette",
      "no smooth shading, no normal-map detail, hard edges",
      "geometric simplification, charming retro look",
    ],
  },
  {
    key: "photoreal_arch",
    label: "Photorealistic Arch",
    hint: "Building / interior / environment â€” Corona/V-Ray photoreal",
    tokens: [
      "photorealistic architecture render (Corona / V-Ray quality)",
      "physically accurate sun + sky lighting, true-to-scale geometry",
      "fine material detail (concrete, glass, timber, metal cladding)",
      "professional architectural visualisation, no stylisation",
    ],
  },
] as const;

export type StyleKey = (typeof STYLE_PRESETS)[number]["key"];

export function styleLabel(key: string | undefined): string | null {
  if (!key) return null;
  return STYLE_PRESETS.find((s) => s.key === key)?.label ?? null;
}

// â”€â”€ Type presets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `pose` chooses the canonical neutral pose the synth anchors the
// concept on. T-pose for humanoid/creature/robot (industry default for
// rigging); A-pose acceptable but T is the strongest constraint for
// auto-rig pipelines. Vehicles + buildings get an orthographic 3/4
// view. Props / weapons sit centered isolated.
//
// `framing` chooses the camera distance â€” full-body, full-silhouette,
// product-isolated, etc.

export const TYPE_PRESETS = [
  {
    key: "humanoid",
    label: "Humanoid",
    hint: "Human, elf, NPC â€” riggable bipedal subject",
    pose: "T-pose, arms outstretched horizontally at 90Â°, palms forward",
    framing: "full body in frame, 8% headroom, no extremity crop, head at frame top, feet at frame bottom",
    extra: "anatomically readable proportions, design clarity prioritised over expression",
  },
  {
    key: "creature",
    label: "Creature",
    hint: "Beast / monster / fantasy creature â€” riggable non-bipedal",
    pose: "neutral standing pose with limbs extended for clear silhouette",
    framing: "full body in frame, generous headroom for horns / wings, no extremity crop",
    extra: "anatomy readable, all limbs visible, claws / fangs / horns clearly defined",
  },
  {
    key: "robot",
    label: "Robot",
    hint: "Mech, droid, automaton â€” hard-surface bipedal/mech",
    pose: "T-pose with mechanical arms outstretched, joint clarity prioritised",
    framing: "full body in frame, 8% headroom, panel seams + joint lines clearly visible",
    extra: "hard-surface clarity, modular component readability, mechanical detail at every joint",
  },
  {
    key: "vehicle",
    label: "Vehicle",
    hint: "Car / mech / spaceship / hovercraft",
    pose: "orthographic 3/4 front view, wheels/tracks/thrusters fully visible",
    framing: "full vehicle silhouette, ground line implied, 8% margin all sides",
    extra: "structural detail readable, wheel wells / cockpit / engine bay clearly defined",
  },
  {
    key: "building",
    label: "Building",
    hint: "Architecture exterior â€” house, tower, structure",
    pose: "orthographic 3/4 front-corner view, ground level visible",
    framing: "entire building silhouette in frame, 10% headroom for roofline, ground line visible",
    extra: "architectural scale relative to human reference, faÃ§ade material readable",
  },
  {
    key: "prop",
    label: "Prop",
    hint: "Object / item / consumable â€” non-character asset",
    pose: "centered 3/4 hero angle, isolated on background",
    framing: "object fills 60% of frame, generous margin all sides",
    extra: "design detail prioritised, material + scale ambiguity removed",
  },
  {
    key: "weapon",
    label: "Weapon",
    hint: "Sword / gun / staff / bow â€” gameplay-readable item",
    pose: "horizontal layout angle showing full weapon length, 3/4 perspective for grip detail",
    framing: "weapon spans 75% of frame width, blade/barrel direction unambiguous",
    extra: "blade-edge and grip detail prioritised, decorative engraving visible at full resolution",
  },
  {
    key: "outfit",
    label: "Outfit",
    hint: "Garment / armor / costume â€” wearable asset",
    pose: "displayed on invisible mannequin in T-pose, garment fully spread",
    framing: "full garment in frame including any cape/cloak length, 8% margin",
    extra: "fabric drape and material weight readable, seams and trim detail visible",
  },
] as const;

export type TypeKey = (typeof TYPE_PRESETS)[number]["key"];

export function typeLabel(key: string | undefined): string | null {
  if (!key) return null;
  return TYPE_PRESETS.find((t) => t.key === key)?.label ?? null;
}

// â”€â”€ Multi-view angle sets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Used by the Multi-view node. The `4-view` set is the industry default
// (front / back / left / right); `8-view` adds the four 45Â° rotations
// for hi-fi turnarounds. Architecture has its own `arch-views` set
// (front / side / floorplan / cross-section / aerial).

export const MULTIVIEW_PRESETS = [
  {
    // Legacy preset key kept for backward-compat with persisted nodes
    // pre-prop-rework. UI label clarifies it's character-oriented.
    key: "4view",
    label: "Character 4-view",
    hint: "Humanoid / creature / robot - front + back + L/R profile",
    angles: ["front", "back", "left profile", "right profile"],
  },
  {
    key: "prop_4view",
    label: "Prop 4-view",
    hint: "Prop / weapon / outfit - 3/4 hero + front + back + top-down",
    angles: ["3/4 hero", "front", "back", "top-down"],
  },
] as const;

export type MultiviewKey = (typeof MULTIVIEW_PRESETS)[number]["key"];

// â”€â”€ Variant axis presets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Variant node â€” pick what dimension to vary. Default 4 axes match
// the most common asset-pipeline use cases.

export const VARIANT_AXES = [
  { key: "color", label: "Color", hint: "Recolor while preserving form" },
  { key: "material", label: "Material", hint: "Swap material/surface (metal â†’ leather)" },
  { key: "damage", label: "Damage", hint: "Wear states (pristine â†’ damaged â†’ ruined)" },
  { key: "equipment", label: "Equipment", hint: "Equipment / accessory swaps" },
  { key: "outfit_alt", label: "Outfit", hint: "Alternate outfit / costume" },
] as const;

export type VariantAxisKey = (typeof VARIANT_AXES)[number]["key"];
