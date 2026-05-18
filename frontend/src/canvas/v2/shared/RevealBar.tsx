/**
 * RevealBar - bottom control row that slides in on hover/selected.
 *
 * Magnific pattern: cards stay visually clean; the controls only
 * appear when the user expresses intent (hover) or commits to the
 * card (selected). Three nodes implemented this exact transition
 * inline. One place to tune timing or easing now.
 *
 * Caller wraps the picker chips, count steppers, instruction inputs,
 * and Run button as children. The bar reserves vertical space only
 * when revealed (max-h trick, not display:none) so the layout
 * doesn''t flicker as opacity transitions in.
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
        "transition-all duration-200 overflow-hidden",
        show ? "max-h-40 opacity-100 mt-3" : "max-h-0 opacity-0 mt-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
