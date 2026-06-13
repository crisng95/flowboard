/**
 * IconChip — compact icon button used inside V2 node toolbars.
 *
 * Magnific-style 24×24 borderless button. Hover reveals a soft white
 * tint; active state (e.g. an in-progress mode) gets the accent.
 * `busy` swaps the icon for a spinner without resizing the button so
 * the toolbar layout doesn't shift when async work starts.
 *
 * Stops click propagation so toolbar interactions don't drag the
 * underlying React Flow node.
 */
import { Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../ui/tooltip";

export interface IconChipProps {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Tailwind override hook for niche cases (e.g. destructive chip). */
  className?: string;
  /** Tooltip side - default "top" */
  tooltipSide?: "top" | "bottom" | "left" | "right";
}

export function IconChip({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  busy,
  className,
  tooltipSide = "top",
}: IconChipProps) {
  return (
    <TooltipProvider delayDuration={600}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            disabled={disabled || busy}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClick?.();
            }}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md",
              "nodrag nowheel",
              "transition-all duration-150",
              "disabled:opacity-50 disabled:pointer-events-none",
              active
                ? "bg-accent/15 text-white"
                : "text-ink-muted hover:bg-white/[0.06] hover:text-ink-primary",
              className,
            )}
          >
            {busy ? (
              <Loader2 size={12} strokeWidth={2} className="animate-spin text-accent" />
            ) : (
              <Icon size={12} strokeWidth={1.75} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
