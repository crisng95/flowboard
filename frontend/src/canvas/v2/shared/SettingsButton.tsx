/**
 * SettingsButton - gear icon that opens the per-node settings drawer.
 *
 * Lives in the reveal bar of every node, mirroring Magnific''s gear
 * affordance. Clicking toggles the drawer for the node it''s rendered
 * inside; the drawer itself (`SettingsDrawer`) is portaled into the
 * card''s right edge by the consumer.
 *
 * Visually mirrors `IconChip` so the reveal bar stays consistent.
 */
import { Settings as SettingsIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "../../../lib/utils";
import { useNodeSettingsStore } from "../../../store/nodeSettings";

export interface SettingsButtonProps {
  nodeId: string;
  /** Override label - default "Open settings". */
  label?: string;
  className?: string;
}

export function SettingsButton({
  nodeId,
  label = "Open settings",
  className,
}: SettingsButtonProps) {
  const isOpen = useNodeSettingsStore((s) => s.openFor === nodeId);
  const toggle = useNodeSettingsStore((s) => s.toggle);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    toggle(nodeId);
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
      title={label}
      aria-label={label}
      aria-expanded={isOpen}
      className={cn(
        "shrink-0 size-7 inline-flex items-center justify-center rounded-full",
        "nodrag nowheel",
        "text-2xs transition-all duration-150",
        "border",
        isOpen
          ? "bg-accent/10 border-accent/40 text-white"
          : "bg-white/[0.03] border-white/[0.08] text-ink-muted hover:bg-white/[0.07] hover:text-ink-primary",
        className,
      )}
    >
      <SettingsIcon size={12} strokeWidth={1.75} />
    </button>
  );
}
