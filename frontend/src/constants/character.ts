// Character builder presets — shared between the GenerationDialog
// (uses `tokens` to bake into the prompt) and the ResultViewer detail
// panel (uses `label` to render country/vibe pills under the model
// badge). Keep `key` stable: it's persisted into `node.data.charCountry`
// / `node.data.charVibe` so the viewer can map back to a friendly label
// across reloads.
//
// Labels are Vietnamese for the picker UI; `tag` is the English noun
// injected into the dispatched prompt text.

export const CHARACTER_GENDERS = [
  { key: "male", label: "Nam", tag: "male" },
  { key: "female", label: "Nữ", tag: "female" },
] as const;

export const CHARACTER_COUNTRIES = [
  { key: "vn", label: "Việt Nam", tag: "Vietnamese" },
  { key: "jp", label: "Nhật Bản", tag: "Japanese" },
  { key: "kr", label: "Hàn Quốc", tag: "Korean" },
  { key: "cn", label: "Trung Quốc", tag: "Chinese" },
  { key: "th", label: "Thái Lan", tag: "Thai" },
  { key: "us", label: "Mỹ", tag: "American" },
  { key: "fr", label: "Pháp", tag: "French" },
] as const;

// Vibe presets drive everything *except* framing: makeup/grooming, hair,
// outfit, expression, lighting, backdrop, mood. Framing anchors (frontal
// face, both eyes, no occlusion, head-and-shoulders) are appended by the
// dialog so the character reference remains usable across downstream shots.
export const CHARACTER_VIBES = [
  {
    key: "clean",
    label: "Clean Girl",
    tokens: [
      "Clean Girl makeup styling, fresh dewy skin with sheer skin-tint coverage, healthy natural radiance, peachy cream blush on the cheek apples",
      "brushed-up laminated brows with clear brow gel finish, minimal eye makeup, glossy plump lips with lip-oil sheen",
      "slicked-back low bun or polished sleek hair, simple modern minimalist outfit, delicate gold hoop earrings",
      "relaxed friendly expression with a gentle subtle smile, soft natural gaze, soft natural daylight, airy bright tone, clean minimalist backdrop",
    ],
  },
  {
    key: "douyin",
    label: "Douyin",
    tokens: [
      "Douyin makeup styling, porcelain-smooth flawless complexion, glossy ethereal skin with subtle pearl glow",
      "shimmery glittery eyeshadow with light-catching pearl highlights, defined aegyo sal under-eye accent, individual cluster false lashes",
      "blurred-edge gradient lip in soft berry or muted red tone with diffused outline, delicate styled hair with face-framing strands, refined feminine outfit",
      "soft alluring expression with a composed sultry gaze, soft beauty lighting with subtle ethereal glow, clean pale studio backdrop, dreamy atmosphere",
    ],
  },
  {
    key: "oldmoney",
    label: "Old Money",
    tokens: [
      "Old Money makeup styling, polished neutral palette in earth tones (taupe, nude, soft coral), matte refined skin finish",
      "softly contoured eyes with warm matte brown shadow, groomed defined brows, classic red or elegant nude-pink lip",
      "polished sleek hair, timeless tailored outfit, understated gold or pearl jewelry",
      "composed dignified expression with a calm refined gaze, soft directional studio lighting, warm neutral backdrop, timeless heritage atmosphere",
    ],
  },
  {
    key: "coldgirl",
    label: "Cold Girl",
    tokens: [
      "Cool-tone makeup styling, ash-pink, mauve and cool grey-brown palette, matte velvety skin finish",
      "cool-toned smoky eye, ash-pink blush, soft mauve lip, subtle high-point highlight on cheekbones, brow bone and cupid's bow",
      "sleek modern hair, edgy contemporary outfit, minimalist silver accessories",
      "cool composed expression with a confident detached gaze, cool-toned cinematic lighting, muted soft blue-grey backdrop, modern moody atmosphere",
    ],
  },
  {
    key: "kpop",
    label: "K-Pop",
    tokens: [
      "K-pop idol styling, glossy plump lips, soft sculpted contour, glittery inner-corner highlight, dewy skin",
      "glossy hair with face-framing layers, trendy stylish outfit, delicate accessories",
      "soft confident expression, gentle closed-lip smile",
      "soft beauty lighting, clean studio glow, smooth pastel backdrop",
    ],
  },
  {
    key: "casual",
    label: "Casual",
    tokens: [
      "minimal natural styling, fresh clear skin, soft tinted lips",
      "relaxed natural hair, simple everyday outfit",
      "warm friendly soft smile, gentle natural gaze",
      "soft natural daylight, airy bright tone, clean light backdrop",
    ],
  },
] as const;

export type GenderKey = (typeof CHARACTER_GENDERS)[number]["key"];
export type CountryKey = (typeof CHARACTER_COUNTRIES)[number]["key"];
export type VibeKey = (typeof CHARACTER_VIBES)[number]["key"];

export function countryLabel(key: string | undefined): string | null {
  if (!key) return null;
  return CHARACTER_COUNTRIES.find((c) => c.key === key)?.label ?? null;
}

export function vibeLabel(key: string | undefined): string | null {
  if (!key) return null;
  return CHARACTER_VIBES.find((v) => v.key === key)?.label ?? null;
}
