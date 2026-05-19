/**
 * SettingsDrawer - slide-in panel anchored to the right edge of a node.
 *
 * Magnific''s gear surface: when the user opens settings, a small
 * card appears beside the node carrying advanced controls (custom
 * system prompt, aspect ratio override, mode toggle, ...). The
 * primary affordances stay on the node itself - this drawer is for
 * power-user knobs that don''t fit the everyday flow.
 *
 * Layout:
 *   - Absolutely positioned to the right of the parent (the node
 *     wrapper). Caller renders it as a sibling inside the node so
 *     z-ordering follows React Flow''s node z-index.
 *   - Closes on Escape and on backdrop click (no backdrop here -
 *     React Flow stops mouse events). Caller can wire outside-click
 *     via the store''s `close()` if needed.
 *
 * The component is presentation-only. Each node owns its form fields
 * and persistence. The drawer itself just supplies the chrome.
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { useNodeSettingsStore } from "../../../store/nodeSettings";

export interface SettingsDrawerProps {
  nodeId: string;
  title: string;
  /** Subtitle rendered under the title. Optional context hint. */
  hint?: string;
  children: ReactNode;
  /** Width override (default 280px). */
  width?: number;
}

export function SettingsDrawer({
  nodeId,
  title,
  hint,
  children,
  width = 280,
}: SettingsDrawerProps) {
  const isOpen = useNodeSettingsStore((s) => s.openFor === nodeId);
  const close = useNodeSettingsStore((s) => s.close);

  // Escape closes only when this drawer is the active one. Bind once
  // at mount; the closure reads `openFor` via the store inside the
  // handler so we don''t have to re-bind on every render.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (useNodeSettingsStore.getState().openFor !== nodeId) return;
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodeId, close]);

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "absolute top-0 left-full ml-3",
        "rounded-2xl border",
        "animate-fade-in",
      )}
      style={{
        width,
        backgroundColor: "#16181d",
        borderColor: "rgba(255,255,255,0.08)",
        boxShadow:
          "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 48px -12px rgba(0,0,0,0.7)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-primary leading-tight truncate">
            {title}
          </p>
          {hint && (
            <p className="text-2xs text-ink-placeholder mt-0.5 leading-snug">
              {hint}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
          aria-label="Close settings"
          className="shrink-0 size-6 inline-flex items-center justify-center rounded-full text-ink-muted hover:text-ink-primary hover:bg-white/[0.05] transition-colors"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>

      <div className="px-4 pb-4 pt-1 space-y-4">{children}</div>
    </div>
  );
}