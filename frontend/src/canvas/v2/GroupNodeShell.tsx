/**
 * GroupNodeShell - frame container for the Node Group feature.
 *
 * Visually matches the existing V2 nodes (Reference, Text...):
 *   - Reuses `.node-surface` for the background / border / shadow /
 *     selected styling so the group sits in the same visual family
 *     as every other card on the canvas. The only group-specific
 *     touch is a subtle accent border tint that follows `groupColor`.
 *   - Title floats OUTSIDE the card at the top-left, exactly the way
 *     `NodeShell.tsx` places its label - icon + small text + optional
 *     status dot. This keeps the cluster header consistent with every
 *     individual node header in the workspace.
 *
 * Pointer-event model:
 *   - The card body itself stays `pointer-events: none` so drag-select
 *     gestures can pass straight through the group to the children
 *     and the canvas pane.
 *   - Four thin transparent edge strips along the border re-enable
 *     pointer events on the perimeter so the user can still grab and
 *     drag the group from any side.
 *   - The external title pill stays interactive too (drag-by-label,
 *     double-click rename).
 */
import { useEffect, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { Layers, Lock } from "lucide-react";

import { useBoardStore, type FlowNode } from "../../store/board";
import { patchNode } from "../../api/client";
import { GroupToolbar } from "./GroupToolbar";
import { cn } from "../../lib/utils";

const DEFAULT_COLOR = "#7c5cff";
// Width of the invisible click zones along each edge
const EDGE_HIT_WIDTH = 10;

const MIN_WIDTH = 200;
const MIN_HEIGHT = 140;
const MAX_WIDTH = 4000;
const MAX_HEIGHT = 4000;

/* ═══════════════════════════════════════════════════════════════════════════
   CORNER RESIZE HANDLE
   ═══════════════════════════════════════════════════════════════════════════ */
type Corner = "tl" | "tr" | "bl" | "br";

/** SVG arc path for bottom-right corner (the canonical shape). Other
 *  corners rotate the SVG via `transform`. */
const ARC_PATH = "M 36 22 A 14 14 0 0 1 22 36";

/** Position + transform for each corner so the 48×48 hit-zone sits
 *  centered on the card corner. */
const CORNER_POSITION: Record<Corner, React.CSSProperties> = {
  br: { bottom: 0, right: 0, transform: "translate(50%, 50%)" },
  bl: { bottom: 0, left: 0, transform: "translate(-50%, 50%)" },
  tr: { top: 0, right: 0, transform: "translate(50%, -50%)" },
  tl: { top: 0, left: 0, transform: "translate(-50%, -50%)" },
};

/** SVG rotation so the arc faces the correct corner. */
const CORNER_ROTATION: Record<Corner, string> = {
  br: "",
  bl: "rotate(90, 24, 24)",
  tr: "rotate(-90, 24, 24)",
  tl: "rotate(180, 24, 24)",
};

function GroupCornerHandle({
  corner,
  nodeId,
  locked,
  forceVisible,
}: {
  corner: Corner;
  nodeId: string;
  locked: boolean;
  forceVisible: boolean;
}) {
  const { getZoom, getNode, setNodes } = useReactFlow();
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null);
  const persistGroupSize = useBoardStore((s) => s.persistGroupSize);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startNodeX: number;
    startNodeY: number;
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    const node = getNode(nodeId);
    if (!node) return;

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: node.measured?.width ?? (node.width as number) ?? 400,
      startH: node.measured?.height ?? (node.height as number) ?? 300,
      startNodeX: node.position.x,
      startNodeY: node.position.y,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveSize({
      w: Math.round(dragRef.current.startW),
      h: Math.round(dragRef.current.startH),
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s) return;
    const dx = (e.clientX - s.startX) / s.zoom;
    const dy = (e.clientY - s.startY) / s.zoom;

    // Calculate desired dimensions based on corner
    let desiredW = s.startW;
    let desiredH = s.startH;
    switch (corner) {
      case "br": desiredW = s.startW + dx; desiredH = s.startH + dy; break;
      case "bl": desiredW = s.startW - dx; desiredH = s.startH + dy; break;
      case "tr": desiredW = s.startW + dx; desiredH = s.startH - dy; break;
      case "tl": desiredW = s.startW - dx; desiredH = s.startH - dy; break;
    }

    // Clamp
    const newW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, desiredW));
    const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, desiredH));

    // Position offset: move origin so the opposite corner stays fixed
    let newX = s.startNodeX;
    let newY = s.startNodeY;
    if (corner === "bl" || corner === "tl") newX = s.startNodeX + (s.startW - newW);
    if (corner === "tr" || corner === "tl") newY = s.startNodeY + (s.startH - newH);

    setLiveSize({ w: Math.round(newW), h: Math.round(newH) });

    setNodes((nodes) =>
      nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              position: { x: newX, y: newY },
              style: { ...(n.style ?? {}), width: newW, height: newH },
            }
          : n,
      ),
    );
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s) return;
    const dx = (e.clientX - s.startX) / s.zoom;
    const dy = (e.clientY - s.startY) / s.zoom;

    let desiredW = s.startW;
    let desiredH = s.startH;
    switch (corner) {
      case "br": desiredW = s.startW + dx; desiredH = s.startH + dy; break;
      case "bl": desiredW = s.startW - dx; desiredH = s.startH + dy; break;
      case "tr": desiredW = s.startW + dx; desiredH = s.startH - dy; break;
      case "tl": desiredW = s.startW - dx; desiredH = s.startH - dy; break;
    }

    const finalW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(desiredW)));
    const finalH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(desiredH)));

    let finalX = s.startNodeX;
    let finalY = s.startNodeY;
    if (corner === "bl" || corner === "tl") finalX = s.startNodeX + (s.startW - finalW);
    if (corner === "tr" || corner === "tl") finalY = s.startNodeY + (s.startH - finalH);

    dragRef.current = null;
    setIsDragging(false);
    setLiveSize(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    // Persist dimensions
    void persistGroupSize(nodeId, finalW, finalH);

    // Persist position if it changed
    if (corner !== "br") {
      const dbId = parseInt(nodeId, 10);
      if (!isNaN(dbId)) {
        patchNode(dbId, { x: Math.round(finalX), y: Math.round(finalY) }).catch(() => {});
      }
    }
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center group",
        isDragging
          ? "[&_path]:opacity-100"
          : forceVisible
          && isHovered
          ? "[&_path]:opacity-50"
          : "[&_path]:opacity-0",
        "[&_path]:transition-opacity [&_path]:duration-100",
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        ...CORNER_POSITION[corner],
        width: 64,
        height: 64,
        background: "transparent",
        touchAction: "none",
        pointerEvents: "auto",
      }}
    >
      {/* Live size badge */}
      {liveSize !== null && (
        <div
          className="absolute pointer-events-none rounded-full border text-[10px] font-mono leading-none px-2 py-1 tabular-nums animate-fade-in"
          style={{
            bottom: corner === "tl" || corner === "tr" ? undefined : "calc(100% + 6px)",
            top: corner === "tl" || corner === "tr" ? "calc(100% + 6px)" : undefined,
            right: "50%",
            transform: "translateX(50%)",
            backgroundColor: "#1c1f27",
            borderColor: "rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.9)",
            whiteSpace: "nowrap",
            zIndex: 100,
          }}
          aria-live="polite"
        >
          {liveSize.w} × {liveSize.h}px
        </div>
      )}
      <svg
        viewBox="0 0 48 48"
        style={{
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          overflow: "visible",
        }}
      >
        {/* Invisible fat hit-target arc */}
        <path
          d={ARC_PATH}
          transform={CORNER_ROTATION[corner]}
          stroke="rgba(0,0,0,0)"
          strokeWidth="18"
          strokeLinecap="round"
          fill="none"
          pointerEvents="stroke"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* Visible thin arc */}
        <path
          d={ARC_PATH}
          transform={CORNER_ROTATION[corner]}
          stroke="rgba(255,255,255,0.95)"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
          pointerEvents="none"
          opacity={0.9}
        />
      </svg>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP NODE SHELL
   ═══════════════════════════════════════════════════════════════════════════ */
export function GroupNodeShell({ id, data, selected, width, height }: NodeProps<FlowNode>) {
  const renameGroup = useBoardStore((s) => s.renameGroup);
  const allNodes = useBoardStore((s) => s.nodes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const rawColor = data.groupColor || DEFAULT_COLOR;
  const color = rawColor === "transparent" ? "#f5f5f5" : rawColor;
  const locked = data.locked === true;
  const title = data.title || "Group";
  const shortId = data.shortId;
  const childCount = allNodes.filter((n) => n.parentId === id).length;
  const w = width ?? "100%";
  const h = height ?? "100%";

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing]);

  function startEdit() {
    if (locked) return;
    setDraft(title);
    setEditing(true);
  }

  function commitEdit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== title) {
      void renameGroup(id, draft);
    }
  }

  const showHandles = !!selected;

  return (
    <div
      className="relative font-sans"
      style={{ width: w, height: h }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* External title - icon + label + lock pill + node count */}
      <div
        className="absolute -top-6 left-1 flex items-center gap-1.5"
        style={{
          pointerEvents: "auto",
          opacity: selected || hovered ? 1 : 0.75,
          cursor: locked ? "not-allowed" : "grab",
          transition: "opacity 150ms ease",
        }}
      >
        <Layers size={12} strokeWidth={1.5} style={{ color }} />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") inputRef.current?.blur();
              if (e.key === "Escape") setEditing(false);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="bg-transparent text-xs font-normal outline-none border-0 leading-none"
            style={{ color: "#f5f5f5", width: Math.max(60, draft.length * 7) }}
          />
        ) : (
          <button
            type="button"
            onDoubleClick={startEdit}
            onPointerDown={(e) => e.stopPropagation()}
            className="bg-transparent border-0 text-xs font-normal text-ink-primary leading-none truncate"
            style={{ cursor: locked ? "not-allowed" : "text", maxWidth: 200 }}
            title={locked ? "Group is locked" : "Double-click to rename"}
          >
            {title}
          </button>
        )}
        {locked && (
          <Lock size={10} strokeWidth={2} style={{ color, opacity: 0.85 }} />
        )}
        {childCount > 0 && (
          <span
            className="text-2xs leading-none px-1.5 py-0.5 rounded-full"
            style={{
              backgroundColor: hexWithAlpha(color, 0.15),
              color: hexWithAlpha(color, 0.9),
              border: `1px solid ${hexWithAlpha(color, 0.3)}`,
            }}
          >
            {childCount}
          </span>
        )}
        {shortId && (
          <span className="font-mono text-2xs text-ink-placeholder leading-none">
            #{shortId}
          </span>
        )}
      </div>

      {/* Card body */}
      <div
        data-selected={selected || undefined}
        className={cn("node-surface node-surface-no-border absolute inset-0")}
        style={{
          background: `linear-gradient(0deg, ${hexWithAlpha(rawColor, 0.10)}, ${hexWithAlpha(rawColor, 0.10)}), #151515`,
          pointerEvents: "none",
        }}
      >
        {/* Edge hit zones - 4 transparent strips along the border. */}
        <EdgeStrip
          style={{ top: 0, left: 0, right: 0, height: EDGE_HIT_WIDTH, cursor: locked ? "not-allowed" : "grab" }}
        />
        <EdgeStrip
          style={{ bottom: 0, left: 0, right: 0, height: EDGE_HIT_WIDTH, cursor: locked ? "not-allowed" : "grab" }}
        />
        <EdgeStrip
          style={{ top: 0, bottom: 0, left: 0, width: EDGE_HIT_WIDTH, cursor: locked ? "not-allowed" : "grab" }}
        />
        <EdgeStrip
          style={{ top: 0, bottom: 0, right: 0, width: EDGE_HIT_WIDTH, cursor: locked ? "not-allowed" : "grab" }}
        />
      </div>

      {/* 3-corner resize handles (arc style matching TextNode, omitting tl to avoid title occlusion) */}
      {!locked && (
        <>
          <GroupCornerHandle corner="br" nodeId={id} locked={locked} forceVisible={showHandles} />
          <GroupCornerHandle corner="bl" nodeId={id} locked={locked} forceVisible={showHandles} />
          <GroupCornerHandle corner="tr" nodeId={id} locked={locked} forceVisible={showHandles} />
        </>
      )}

      <GroupToolbar groupRfId={id} color={rawColor} locked={locked} selected={!!selected} />
    </div>
  );
}

/**
 * Invisible hit strip used to opt one of the four group edges back
 * into pointer-events while the body around it stays transparent.
 */
function EdgeStrip({ style }: { style: React.CSSProperties }) {
  return (
    <div
      className="absolute"
      style={{
        ...style,
        background: "transparent",
        pointerEvents: "auto",
      }}
    />
  );
}

/**
 * Convert a 6-digit hex color to an `rgba(r, g, b, alpha)` string.
 */
function hexWithAlpha(hex: string, alpha: number): string {
  if (hex === "transparent") return "rgba(0,0,0,0)";
  const fallback = `rgba(124, 92, 255, ${alpha})`;
  if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
