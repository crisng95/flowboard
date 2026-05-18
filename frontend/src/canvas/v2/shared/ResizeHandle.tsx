/**
 * ResizeHandle â€” DOM-anchored corner resize affordance.
 *
 * Why custom (not @xyflow/react NodeResizeControl):
 *   RF v12 pins NodeResizeControl to its internally-tracked
 *   `node.width Ã— node.height`. Our V2 cards are content-sized â€”
 *   width is set explicitly via `nodeWidth`, but height auto-flows
 *   from `aspect-ratio` CSS on the slot. RF's tracked height stays
 *   stale by 100s of px during a resize, and the upstream handle
 *   floats off the real corner mid-drag.
 *
 *   Custom anchor via `position: absolute; bottom: 0; right: 0`
 *   binds to the rendered corner of the parent. No internal
 *   dimension tracking â†’ no stale anchor â†’ arc stays glued.
 *
 * Hit detection:
 *   - 36Ã—36 wrapper box anchored at the corner pixel (centered via
 *     `translate(50%, 50%)`)
 *   - Inner SVG paints two paths sharing the same arc curve:
 *       1. Wide invisible 12px stroke â€” receives pointer events
 *          (pointerEvents="stroke"), gives a forgiving grab zone
 *       2. Visible 3px stroke â€” pointer events disabled, decoration
 *   - Wrapper triggers `:hover` for the fade-in CSS without itself
 *     capturing the drag (drag starts on the hit path's pointerdown)
 *   - Default cursor stays at all times â€” the user wanted no
 *     cursor-mode-swap to nwse-resize
 *
 * Drag mechanics:
 *   - pointerdown captures the pointer (survives fast cursor motion
 *     leaving the wrapper)
 *   - pointermove computes:
 *         delta_world = (clientX - startX) / zoom
 *         width = startWidth + delta_world  (clamped)
 *     Dividing by RF's current zoom keeps resize 1:1 with cursor
 *     motion regardless of canvas zoom level. Without this, at
 *     zoom 0.5 the user would have to drag 200px to grow the node
 *     by 100px on screen â€” feels laggy.
 *   - pointerup releases capture, persists final width via callback
 */
import { useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";

import { cn } from "../../../lib/utils";

export interface ResizeHandleProps {
  minWidth: number;
  maxWidth: number;
  /** Live width during drag â€” called every pointermove. */
  onResize: (width: number) => void;
  /** Final width on pointerup â€” persist here. */
  onResizeEnd: (width: number) => void;
  /** Current width to start the drag from. */
  currentWidth: number;
}

export function ResizeHandle({
  minWidth,
  maxWidth,
  onResize,
  onResizeEnd,
  currentWidth,
}: ResizeHandleProps) {
  // RF zoom â€” read from the same hook the canvas uses so we get the
  // live value, not a snapshot from render time. Hook is called once
  // per render; the actual zoom is read inside the handlers via the
  // closure.
  const { getZoom } = useReactFlow();

  const [isDragging, setIsDragging] = useState(false);
  // Live width readout while dragging - tiny floating pill anchored
  // just above the handle. Cosmetic only; the actual resize math is
  // independent of this pill.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    /** Captured zoom at drag-start. We could re-read zoom on every
     *  pointermove, but capturing once gives smoother feel â€” if the
     *  user happened to scroll-wheel zoom mid-resize the math would
     *  jump. Locking to drag-start matches Figma / Magnific UX. */
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startX: e.clientX,
      startWidth: currentWidth,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveWidth(Math.round(currentWidth));
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    // Screen-space delta â†’ world (canvas) delta. See header comment
    // for the rationale.
    const delta = (e.clientX - s.startX) / s.zoom;
    const next = Math.max(minWidth, Math.min(maxWidth, s.startWidth + delta));
    onResize(next);
    setLiveWidth(Math.round(next));
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const delta = (e.clientX - s.startX) / s.zoom;
    const final = Math.max(minWidth, Math.min(maxWidth, s.startWidth + delta));
    dragStateRef.current = null;
    setIsDragging(false);
    setLiveWidth(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // releasing a capture that wasn't set throws on some browsers
    }
    onResizeEnd(final);
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center group",
        // Fade EVERY path inside on wrapper hover. The invisible
        // hit-stroke is rgba(0,0,0,0) so its opacity transition is
        // a no-op visually; only the white 3px decoration responds.
        "[&_path]:opacity-0 group-hover:[&_path]:opacity-100",
        "[&_path]:transition-opacity [&_path]:duration-100",
        // !important keeps the arc visible during drag jitter (the
        // cursor briefly leaves the 36Ã—36 wrapper while the user is
        // still mid-resize).
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        bottom: 0,
        right: 0,
        // 36Ã—36 hover/hit zone. Larger than the previous 28Ã—28 so
        // the arc registers a hover sooner â€” the user reported
        // having to nudge the cursor onto the arc itself before it
        // showed. With 36px, anywhere within the corner region
        // triggers the fade, and the inner 12px hit stroke is still
        // forgiving enough to grab without pixel-hunting.
        width: 36,
        height: 36,
        transform: "translate(50%, 50%)",
        // Default cursor â€” no mode-swap to nwse-resize. The arc
        // itself is the grab affordance; the cursor doesn't repeat it.
        background: "transparent",
        touchAction: "none",
      }}
    >
      {liveWidth !== null && (
        <div
          className="absolute pointer-events-none rounded-full border text-[10px] font-mono leading-none px-2 py-1 tabular-nums animate-fade-in"
          style={{
            // Anchor a hair above the corner so it doesn''t collide
            // with the resize arc itself. Centered horizontally on
            // the wrapper.
            bottom: "calc(100% + 6px)",
            right: "50%",
            transform: "translateX(50%)",
            backgroundColor: "#1c1f27",
            borderColor: "rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.9)",
            whiteSpace: "nowrap",
          }}
          aria-live="polite"
        >
          {liveWidth}px
        </div>
      )}
      <svg
        viewBox="0 0 36 36"
        style={{
          width: "100%",
          height: "100%",
          // SVG host non-interactive so empty pixels of the
          // bounding box don't intercept clicks. Only the inner
          // hit-path re-enables pointer events.
          pointerEvents: "none",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          overflow: "visible",
        }}
      >
        {/* Wide invisible hit stroke â€” receives the drag.
            12px stroke around a 9-radius arc = generous grab zone
            hugging the curve, no pixel-hunt. */}
        <path
          d="M 28 18 A 10 10 0 0 1 18 28"
          stroke="rgba(0,0,0,0)"
          strokeWidth="14"
          strokeLinecap="round"
          fill="none"
          pointerEvents="stroke"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* Visible decoration â€” pointer events disabled so the wide
            hit path above always wins. */}
        <path
          d="M 28 18 A 10 10 0 0 1 18 28"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}


