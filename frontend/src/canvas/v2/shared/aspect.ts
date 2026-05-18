/**
 * Aspect-ratio helper for V2 nodes.
 *
 * Backend tags every uploaded / generated image with one of three
 * canonical Flow aspect enums (`IMAGE_ASPECT_RATIO_SQUARE` / `PORTRAIT`
 * / `LANDSCAPE`). The legacy V1 NodeCard ignored this and forced its
 * own grid layout — that's what made V2 cards crop the image when the
 * source was portrait but the slot was square.
 *
 * V2 nodes call `cssAspect(node.data.aspectRatio)` to resize the media
 * slot to match the actual image so `object-fit: cover` doesn't crop
 * meaningful detail. Empty / processing / error states fall back to a
 * default per node type (Concept = 3:4 portrait, Reference = 1:1).
 */

export type FlowAspectEnum =
  | "IMAGE_ASPECT_RATIO_SQUARE"
  | "IMAGE_ASPECT_RATIO_PORTRAIT"
  | "IMAGE_ASPECT_RATIO_LANDSCAPE"
  | string;

export type CssAspect = "1 / 1" | "3 / 4" | "16 / 9" | "4 / 3" | "9 / 16";

/**
 * Map a Flow aspect enum to a CSS `aspect-ratio` value.
 *
 * Flow's three canonical enums round to the production aspect ratios
 * Veo / Imagen actually emit: square = 1:1, portrait = 3:4, landscape
 * = 16:9. We keep the CSS values as the strings React inline-style
 * accepts so `style={{ aspectRatio: ... }}` works directly.
 *
 * Unknown enum strings fall through to the `fallback` parameter so a
 * future enum value (or stale data) doesn't crash the layout.
 */
export function cssAspect(
  enumValue: FlowAspectEnum | undefined,
  fallback: CssAspect = "1 / 1",
): CssAspect {
  switch (enumValue) {
    case "IMAGE_ASPECT_RATIO_SQUARE":
      return "1 / 1";
    case "IMAGE_ASPECT_RATIO_PORTRAIT":
      return "3 / 4";
    case "IMAGE_ASPECT_RATIO_LANDSCAPE":
      return "16 / 9";
    default:
      return fallback;
  }
}

/**
 * Pick a sensible default slot aspect when no media is loaded yet.
 * Concept nodes default portrait (humanoid / creature / robot are
 * vertically biased); Reference nodes default square; downstream
 * detail nodes (Part / Variant) default square.
 *
 * Once media is set on the node, the per-image aspect (via
 * `cssAspect(data.aspectRatio)`) overrides the default so the slot
 * tracks the real image.
 */
export function defaultEmptyAspect(
  nodeKind: "concept" | "reference" | "multiview" | "part" | "variant",
): CssAspect {
  switch (nodeKind) {
    case "concept":
      return "3 / 4";
    case "reference":
    case "part":
    case "variant":
      return "1 / 1";
    case "multiview":
      // Strip layout — wider than it is tall.
      return "16 / 9";
    default:
      return "1 / 1";
  }
}
