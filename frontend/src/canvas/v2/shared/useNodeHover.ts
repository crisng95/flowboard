/**
 * useNodeHover - shared hover/selected reveal state.
 *
 * Magnific pattern: bottom control bar stays hidden until the user
 * hovers the card OR selects it. Selected = sticky reveal so a tap
 * on touch surfaces still exposes the controls. Three node types
 * implemented this exact local state inline; this hook deduplicates
 * the wiring and keeps the "reveal" rule in one place.
 */
import { useState } from "react";

export interface UseNodeHoverResult {
  hovered: boolean;
  showControls: boolean;
  /** Spread these on the card wrapper element. */
  bind: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
}

export function useNodeHover(selected: boolean | undefined): UseNodeHoverResult {
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    showControls: hovered || !!selected,
    bind: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
  };
}
