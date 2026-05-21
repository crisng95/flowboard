/**
 * RevealBar — bottom control overlay, Magnific-style.
 *
 * v2 behaviour: absolute overlay at the card bottom. The card does NOT
 * grow on hover — controls slide up from the bottom edge, overlaying
 * the lower portion of the content. This matches Magnific Spaces exactly.
 *
 * Positioning: `absolute bottom-0 left-0 right-0` positions relative to
 * the nearest `relative` ancestor, which is `node-surface` in NodeShell.
 * The p-3 content wrapper between them has no `position` set, so the
 * overlay correctly goes edge-to-edge at the card bottom.
 *
 * No `overflow:hidden` needed on the card — the overlay's own
 * `rounded-b-[14px]` matches the card's 16px radius (minus 1.5px border).
 * PickerDropdowns inside the bar can still extend beyond the card bounds.
 */
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";

export interface RevealBarProps {
  show: boolean;
  children: ReactNode;
  className?: string;
}

export function RevealBar({ show, children, className }: RevealBarProps) {
  return (
    <div
      className={cn(
        // Absolute overlay — edge-to-edge at card bottom.
        "absolute bottom-0 left-0 right-0 z-20",
        // Match card's 16px radius on the bottom corners (minus 1.5px border).
        "rounded-b-[14px]",
        // Generous top padding so the gradient has room to fade.
        "px-3 pb-3 pt-10",
        // Slide up + fade in. translate-y-2 = 8px offset when hidden.
        "transition-all duration-200 ease-out",
        show
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-2 pointer-events-none",
        className,
      )}
      style={{
        // Dark gradient: opaque at bottom for control readability,
        // transparent at top so the image bleeds through naturally.
        background:
          "linear-gradient(to top, rgba(15,15,15,0.97) 50%, rgba(15,15,15,0.6) 75%, transparent)",
      }}
    >
      {children}
    </div>
  );
}
