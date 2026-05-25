import { useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";

import { patchNode } from "../../../api/client";
import { cn } from "../../../lib/utils";

type ResizeCorner = "tr" | "bl" | "br";

const ARC_PATH = "M 36 22 A 14 14 0 0 1 22 36";
const CORNER_POSITION: Record<ResizeCorner, React.CSSProperties> = {
  br: { bottom: 0, right: 0, transform: "translate(50%, 50%)" },
  bl: { bottom: 0, left: 0, transform: "translate(-50%, 50%)" },
  tr: { top: 0, right: 0, transform: "translate(50%, -50%)" },
};
const CORNER_ROTATION: Record<ResizeCorner, string> = {
  br: "",
  bl: "rotate(90, 24, 24)",
  tr: "rotate(-90, 24, 24)",
};

export interface ResizeHandleProps {
  forceVisible?: boolean;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  currentWidth: number;
  nodeId?: string;
  corners?: ResizeCorner[];
}

function ResizeCornerHandle({
  corner,
  currentWidth,
  minWidth,
  maxWidth,
  forceVisible,
  nodeId,
  onResize,
  onResizeEnd,
}: Required<Pick<ResizeHandleProps, "currentWidth" | "minWidth" | "maxWidth" | "forceVisible" | "onResize" | "onResizeEnd">> & {
  corner: ResizeCorner;
  nodeId?: string;
}) {
  const { getZoom, getNode, setNodes } = useReactFlow();
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    startNodeX: number | null;
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startNodeX = corner === "bl" && nodeId ? (getNode(nodeId)?.position.x ?? null) : null;
    dragStateRef.current = {
      startX: e.clientX,
      startWidth: currentWidth,
      startNodeX,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveWidth(Math.round(currentWidth));
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const delta = (e.clientX - s.startX) / s.zoom;
    const desiredWidth = corner === "bl" ? s.startWidth - delta : s.startWidth + delta;
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, desiredWidth));
    onResize(nextWidth);
    setLiveWidth(Math.round(nextWidth));

    if (corner === "bl" && nodeId && s.startNodeX !== null) {
      const nextX = s.startNodeX + (s.startWidth - nextWidth);
      setNodes((nodes) =>
        nodes.map((node) => (node.id === nodeId ? { ...node, position: { ...node.position, x: nextX } } : node)),
      );
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const delta = (e.clientX - s.startX) / s.zoom;
    const desiredWidth = corner === "bl" ? s.startWidth - delta : s.startWidth + delta;
    const finalWidth = Math.max(minWidth, Math.min(maxWidth, Math.round(desiredWidth)));
    dragStateRef.current = null;
    setIsDragging(false);
    setLiveWidth(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    onResizeEnd(finalWidth);

    if (corner === "bl" && nodeId && s.startNodeX !== null) {
      const dbId = parseInt(nodeId, 10);
      if (!isNaN(dbId)) {
        const finalX = s.startNodeX + (s.startWidth - finalWidth);
        patchNode(dbId, { x: Math.round(finalX) }).catch(() => {});
      }
    }
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center",
        isDragging ? "[&_path]:opacity-100" : forceVisible && isHovered ? "[&_path]:opacity-50" : "[&_path]:opacity-0",
        "[&_path]:transition-opacity [&_path]:duration-100",
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        ...CORNER_POSITION[corner],
        width: 64,
        height: 64,
        background: "transparent",
        touchAction: "none",
      }}
    >
      {liveWidth !== null && (
        <div
          className="absolute pointer-events-none rounded-full border text-[10px] font-mono leading-none px-2 py-1 tabular-nums animate-fade-in"
          style={{
            bottom: corner === "tr" ? undefined : "calc(100% + 6px)",
            top: corner === "tr" ? "calc(100% + 6px)" : undefined,
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
        viewBox="0 0 48 48"
        style={{
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          overflow: "visible",
        }}
      >
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
        <path
          d={ARC_PATH}
          transform={CORNER_ROTATION[corner]}
          stroke="rgba(255,255,255,0.95)"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

export function ResizeHandle({
  minWidth,
  maxWidth,
  onResize,
  onResizeEnd,
  currentWidth,
  forceVisible = false,
  nodeId,
  corners = ["br"],
}: ResizeHandleProps) {
  return (
    <>
      {corners.map((corner) => (
        <ResizeCornerHandle
          key={corner}
          corner={corner}
          currentWidth={currentWidth}
          minWidth={minWidth}
          maxWidth={maxWidth}
          forceVisible={forceVisible}
          nodeId={nodeId}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      ))}
    </>
  );
}
