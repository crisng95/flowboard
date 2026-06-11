/**
 * RunButton - the Magnific-style accent gradient circle that
 * dispatches a node''s primary action ("generate", "run").
 *
 * Three node types had this exact button copy-pasted, including the
 * gradient stops, shadow, hover scale, and disabled cursor. One
 * place to tweak the gradient or motion now.
 *
 * Surface-only: the parent owns the click handler and the disabled
 * predicate (e.g. "no axis picked yet", "already running"). This
 * component does not fetch; it just renders.
 */
import { Play, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "../../../lib/utils";

export interface RunButtonProps {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  busy?: boolean;
  /** Override the default Play icon. */
  icon?: LucideIcon;
  busyIcon?: LucideIcon;
}

export function RunButton({
  onClick,
  disabled = false,
  label = "Run",
  busy = false,
  icon: Icon = Play,
  busyIcon: BusyIcon = RefreshCw,
}: RunButtonProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (disabled) return;
    onClick();
  }

  function stopInteraction(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  return (
    <button
      type="button"
      onMouseDown={stopInteraction}
      onDoubleClick={stopInteraction}
      onClick={handleClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "shrink-0 size-8 rounded-full inline-flex items-center justify-center",
        "nodrag nowheel",
        "transition-all duration-150",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        "hover:scale-105 active:scale-95",
        busy && "animate-pulse-soft",
      )}
      style={{
        background:
          "linear-gradient(135deg, #9d80ff 0%, #7c5cff 50%, #5e3ee5 100%)",
        boxShadow: "0 4px 14px rgba(124,92,255,0.4)",
      }}
    >
      {busy ? (
        <BusyIcon size={14} className="animate-spin text-white" strokeWidth={2} />
      ) : (
        <Icon size={14} fill="white" stroke="white" strokeWidth={0} />
      )}
    </button>
  );
}
