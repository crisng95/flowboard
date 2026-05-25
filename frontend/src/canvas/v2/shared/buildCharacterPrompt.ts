// Shared character prompt builder — used by both AddReferenceNode
// (character builder in the library modal) and GenerationDialog
// (legacy character node generation flow).
//
// Extracted so the exact same prompt template is used regardless of
// which UI surface triggers the generation. Keep in sync with the
// framing anchors and negative locks documented in the original
// GenerationDialog implementation.

import {
  CHARACTER_GENDERS,
  CHARACTER_COUNTRIES,
  CHARACTER_VIBES,
  type GenderKey,
  type CountryKey,
  type VibeKey,
} from "../../../constants/character";

export interface CharacterConfig {
  gender: GenderKey | null;
  country: CountryKey | null;
  vibe: VibeKey;
  extras: string;
}

export function buildCharacterPrompt(config: CharacterConfig): string {
  const g = CHARACTER_GENDERS.find((x) => x.key === config.gender)?.tag;
  const c = CHARACTER_COUNTRIES.find((x) => x.key === config.country)?.tag;
  const subject = [c, g].filter(Boolean).join(" ") || "person";
  const vibeTokens = CHARACTER_VIBES.find((v) => v.key === config.vibe)?.tokens ?? [];
  const tail = config.extras.trim();
  // Pose anchor is front-loaded (right after subject) because diffusion
  // models weight earlier tokens more — vibe tokens like "editorial /
  // magazine beauty" otherwise pull toward fashion 3/4 turns. The trailing
  // negatives reinforce the lock so the headshot stays usable as a
  // character reference across every downstream shot.
  return [
    `Studio portrait headshot of a ${subject} character`,
    "subject directly faces the camera, head perfectly straight with zero tilt and zero turn",
    "shoulders square to camera, axially symmetric pose, nose centered, both eyes equally visible at the same height",
    ...vibeTokens,
    tail || null,
    "head and shoulders framing, centered composition, sharp focus on face",
    "strictly front-on orientation, no head tilt, no head turn, no profile angle, no three-quarter view, no over-the-shoulder pose",
    "no glasses, no hat, no mask, no occlusion, nothing covering the face",
    "photorealistic, ultra-detailed, consistent character reference",
  ]
    .filter(Boolean)
    .join(", ");
}
