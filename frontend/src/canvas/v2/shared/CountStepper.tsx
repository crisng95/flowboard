/**
 * CountStepper - rounded pill with -/N/+ buttons.
 *
 * Lives in shared because the next batch of nodes (Pose count,
 * iteration sweeps, batch generations) will reuse this exact widget.
 * Hard-clamps client-side; caller owns persistence.
 */
import { Minus, Plus } from "lucide-react";
import type { MouseEvent } from "react";

export interface CountStepperProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}

export function CountStepper({
  value,
  min = 1,
  max = 4,
  onChange,
  disabled = false,
}: CountStepperProps) {
  function step(delta: number, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const next = Math.max(min, Math.min(max, value + delta));
    if (next !== value) onChange(next);
  }

  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div
      className="inline-flex items-center gap-0.5 h-7 px-1 rounded-full border border-white/[0.08]"
      style={{ backgroundColor: "rgba(255,255,255,0.02)" }}
      role="group"
      aria-label="Count"
    >
      <button
        type="button"
        disabled={disabled || atMin}
        onClick={(event) => step(-1, event)}
        aria-label="Decrease"
        className="size-5 inline-flex items-center justify-center rounded-md hover:bg-white/[0.08] disabled:opacity-30 text-ink-muted"
      >
        <Minus size={10} />
      </button>
      <span className="text-2xs font-medium text-ink-primary tabular-nums w-4 text-center">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || atMax}
        onClick={(event) => step(1, event)}
        aria-label="Increase"
        className="size-5 inline-flex items-center justify-center rounded-md hover:bg-white/[0.08] disabled:opacity-30 text-ink-muted"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}
