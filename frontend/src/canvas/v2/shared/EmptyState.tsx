/**
 * EmptyState - centered icon + heading + sub-text + optional CTA.
 *
 * Pattern shared between Concept / Multi-view / Part / Variant empty
 * states. Each node currently inlines a slightly different version of
 * the same layout; this primitive locks the visual rhythm (icon size,
 * spacing, type scale) so all empty states feel consistent and a
 * future style tweak edits one file.
 *
 * The CTA is optional. When present, clicking it bubbles to the
 * caller via `onAction`; the parent decides whether to scroll the
 * controls into view, open a picker, or trigger generation.
 */
import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "../../../lib/utils";

export interface EmptyStateProps {
  Icon: LucideIcon;
  title: string;
  hint?: string;
  /** When set, renders a small accent button below the hint. */
  actionLabel?: string;
  onAction?: () => void;
  /** Tweak the vertical breathing room. Default 200 matches Concept. */
  minHeight?: number;
  className?: string;
}

export function EmptyState({
  Icon,
  title,
  hint,
  actionLabel,
  onAction,
  minHeight = 200,
  className,
}: EmptyStateProps) {
  function handleAction(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onAction?.();
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center px-4 py-10",
        className,
      )}
      style={{ minHeight }}
    >
      <Icon size={36} strokeWidth={1.2} className="text-ink-placeholder mb-4" />
      <p className="text-sm font-medium text-ink-primary mb-1">{title}</p>
      {hint && <p className="text-2xs text-ink-placeholder">{hint}</p>}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={handleAction}
          className={cn(
            "mt-4 inline-flex items-center gap-1.5 h-7 px-3 rounded-full",
            "text-2xs font-medium border",
            "bg-accent/10 border-accent/40 text-white",
            "hover:bg-accent/20 transition-colors",
          )}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
