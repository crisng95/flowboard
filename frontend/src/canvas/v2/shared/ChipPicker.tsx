/**
 * ChipPicker - the rounded "Label: Value v" pill used to surface a
 * dropdown choice (Style, Type, Region, Axis, Multi-view preset).
 *
 * Pattern unifies what was three near-identical components:
 *   - PickerChipButton (ConceptNode, Style + Type)
 *   - RegionChip       (PartNode)
 *   - AxisChip         (VariantNode)
 *
 * The chip itself only renders the trigger. Caller still owns the
 * <PickerDropdown> + open/close state, since the dropdown needs to
 * be portaled and anchored to this trigger''s ref.
 */
import { forwardRef } from "react";
import type { MouseEvent } from "react";

import { cn } from "../../../lib/utils";

export interface ChipPickerProps {
  /** Static label rendered first, e.g. "Style". */
  label: string;
  /** Currently selected value. Null/undefined renders "Pick". */
  value?: string | null;
  isOpen: boolean;
  onToggle: () => void;
  /** Disable click + dim. */
  disabled?: boolean;
}

export const ChipPicker = forwardRef<HTMLButtonElement, ChipPickerProps>(
  function ChipPicker({ label, value, isOpen, onToggle, disabled }, ref) {
    function handleClick(event: MouseEvent<HTMLButtonElement>) {
      event.stopPropagation();
      if (disabled) return;
      onToggle();
    }

    const filled = !!value;

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={cn(
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full",
          "text-2xs font-medium transition-all duration-150",
          "border",
          filled
            ? "bg-accent/10 border-accent/40 text-white hover:bg-accent/20"
            : "bg-white/[0.03] border-white/[0.08] text-ink-muted hover:bg-white/[0.07] hover:text-ink-primary",
          isOpen && "ring-2 ring-accent/30",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        <span className="text-ink-muted font-normal">{label}</span>
        <span className={cn(filled ? "text-white" : "text-ink-placeholder")}>
          {value ?? "Pick"}
        </span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          aria-hidden="true"
          className={cn("text-ink-muted transition-transform", isOpen && "rotate-180")}
        >
          <path
            d="M1 2.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
        </svg>
      </button>
    );
  },
);
