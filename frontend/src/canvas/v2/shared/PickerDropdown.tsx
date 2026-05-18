/**
 * PickerDropdown — portaled dropdown for in-node selectors.
 *
 * Why a portal: V2 nodes live inside React Flow's `<ReactFlow>` host,
 * which has `overflow: hidden` on its inner viewport. Any absolutely-
 * positioned dropdown inside a node gets clipped at the viewport
 * edge, which made Concept's Style/Type pickers unreadable. Rendering
 * via `createPortal(…, document.body)` escapes the clip rect entirely,
 * and we re-anchor to the trigger via getBoundingClientRect() so it
 * still feels attached to the node.
 *
 * Anchoring strategy:
 *   - Compute the trigger's viewport-relative rect on open
 *   - Render the menu with `position: fixed`, top/left set from that rect
 *   - Cap the menu height (`max-h`) and let the user scroll inside it
 *   - Close on outside-click, Escape, or canvas pan/zoom (we listen on
 *     window resize + scroll-on-document)
 *
 * Behaviour intentionally NOT covered (would need tracking the canvas
 * transform): keeping the menu glued to the trigger while the user
 * pans/zooms with the menu open. We just close instead — simpler,
 * matches Magnific's actual UX in the reference screenshots.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../../lib/utils";

export interface PickerItem {
  key: string;
  label: string;
  hint?: string;
}

export interface PickerDropdownProps {
  anchorRef: React.RefObject<HTMLElement>;
  isOpen: boolean;
  onClose: () => void;
  items: PickerItem[];
  activeKey?: string;
  onPick: (key: string) => void;
  /** Tailwind override for the menu width — `min-w-[…]` etc. */
  className?: string;
}

interface AnchorPosition {
  top: number;
  left: number;
  /** Width of the trigger so the menu can match it visually. */
  triggerWidth: number;
}

const MENU_GAP = 6; // px between trigger bottom and menu top

export function PickerDropdown({
  anchorRef,
  isOpen,
  onClose,
  items,
  activeKey,
  onPick,
  className,
}: PickerDropdownProps) {
  const [pos, setPos] = useState<AnchorPosition | null>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  // Re-measure on open. Without this the first render has stale
  // coords from the previous open position (or none at all).
  useEffect(() => {
    if (!isOpen) {
      setPos(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.bottom + MENU_GAP,
      left: rect.left,
      triggerWidth: rect.width,
    });
  }, [isOpen, anchorRef]);

  // Outside click + Escape close. Window-resize / scroll close — the
  // simpler alternative to recomputing on every frame, and matches
  // the desktop UX of "close any floater when the layout shifts".
  useEffect(() => {
    if (!isOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (portalRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onWindowChange = () => onClose();
    // Capture on the document so React-Flow's drag handlers can't
    // swallow the click. Listening on window for resize/scroll uses
    // bubble — fine because we just want any layout-affecting event
    // to dismiss.
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onWindowChange, true); // capture so canvas pan triggers
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onWindowChange, true);
    };
  }, [isOpen, anchorRef, onClose]);

  if (!isOpen || !pos) return null;

  return createPortal(
    <div
      ref={portalRef}
      // position:fixed so the menu floats above EVERY ancestor's
      // overflow:hidden. zIndex stays in our app range (the React-Flow
      // controls/minimap are 5-6, modals are 200-240, so 1000 is
      // comfortably above without colliding).
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        minWidth: Math.max(pos.triggerWidth, 200),
        zIndex: 1000,
      }}
      className={cn(
        "rounded-xl shadow-glass animate-scale-in",
        // Increase max-h to fit the longer Type list (8 items × ~50px =
        // ~400px). Below this we relied on `scrollbar-none` which
        // *hid* the scrollbar — items past index 5 became invisible
        // because users had no cue to scroll. Showing the bar instead
        // keeps the affordance clear without truncating the list.
        "max-h-[440px] overflow-y-auto",
        className,
      )}
      onMouseDown={(e) => {
        // Stop the canvas drag handler from kicking in when the user
        // mouse-downs on the menu (otherwise picking an item would
        // also start panning the canvas).
        e.stopPropagation();
      }}
    >
      <div
        // Inline bg + border so the menu is fully opaque against any
        // canvas content; matches the node-surface tone.
        className="p-1 rounded-xl"
        style={{
          backgroundColor: "#1a1d25",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onPick(it.key)}
            className={cn(
              "w-full text-left px-2.5 py-2 rounded-lg",
              "transition-colors duration-100",
              "flex flex-col gap-0.5",
              activeKey === it.key
                ? "bg-accent/15 text-white"
                : "text-ink-primary hover:bg-white/[0.05]",
            )}
          >
            <span className="text-xs font-medium leading-tight">{it.label}</span>
            {it.hint && (
              <span className="text-2xs text-ink-muted leading-snug">{it.hint}</span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
