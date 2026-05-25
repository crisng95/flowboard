import { useCallback, useRef, useState } from "react";
import { type NodeProps, useReactFlow } from "@xyflow/react";
import { Type } from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useBoardStore } from "../../store/board";
import { NodeShell } from "./NodeShell";
import { cn } from "../../lib/utils";
import { persistNodeData } from "./shared/persistNodeData";

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 160;

interface DualResizeHandleProps {
  forceVisible?: boolean;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  currentWidth: number;
  currentHeight: number;
  onResize: (width: number, height: number) => void;
  onResizeEnd: (width: number, height: number) => void;
}

function DualResizeHandle({
  minWidth,
  maxWidth,
  minHeight,
  maxHeight,
  currentWidth,
  currentHeight,
  onResize,
  onResizeEnd,
  forceVisible = false,
}: DualResizeHandleProps) {
  const { getZoom } = useReactFlow();
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: currentWidth,
      startHeight: currentHeight,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveSize({ w: Math.round(currentWidth), h: Math.round(currentHeight) });
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const deltaY = (e.clientY - s.startY) / s.zoom;
    const nextW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    const nextH = Math.max(minHeight, Math.min(maxHeight, s.startHeight + deltaY));
    onResize(nextW, nextH);
    setLiveSize({ w: Math.round(nextW), h: Math.round(nextH) });
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const deltaY = (e.clientY - s.startY) / s.zoom;
    const finalW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    const finalH = Math.max(minHeight, Math.min(maxHeight, s.startHeight + deltaY));
    dragStateRef.current = null;
    setIsDragging(false);
    setLiveSize(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    onResizeEnd(finalW, finalH);
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center group",
        isDragging ? "[&_path]:opacity-100" : forceVisible && isHovered ? "[&_path]:opacity-50" : "[&_path]:opacity-0",
        "[&_path]:transition-opacity [&_path]:duration-100",
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        bottom: 0,
        right: 0,
        width: 64,
        height: 64,
        transform: "translate(50%, 50%)",
        background: "transparent",
        touchAction: "none",
      }}
    >
      {liveSize !== null && (
        <div
          className="absolute pointer-events-none rounded-full border text-[10px] font-mono leading-none px-2 py-1 tabular-nums animate-fade-in"
          style={{
            bottom: "calc(100% + 6px)",
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
        <path
          d="M 36 22 A 14 14 0 0 1 22 36"
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
          d="M 36 22 A 14 14 0 0 1 22 36"
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

export function TextNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const text = (data.prompt as string | undefined) ?? "";
  const shortId = data.shortId as string | undefined;

  const width = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;
  const height = (data.nodeHeight as number | undefined) ?? DEFAULT_HEIGHT;

  const onResize = useCallback(
    (nextW: number, nextH: number) => {
      useBoardStore.getState().updateNodeData(rfId, { nodeWidth: nextW, nodeHeight: nextH });
    },
    [rfId],
  );

  const onResizeEnd = useCallback(
    (nextW: number, nextH: number) => {
      const clampedW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(nextW)));
      const clampedH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(nextH)));
      persistNodeData(rfId, { nodeWidth: clampedW, nodeHeight: clampedH });
    },
    [rfId],
  );

  function setText(value: string) {
    useBoardStore.getState().updateNodeData(rfId, { prompt: value });
    persistNodeData(rfId, { prompt: value });
  }

  return (
    <div className={cn("relative", selected && "node-selected")}>
      <NodeShell
        id={rfId}
        Icon={Type}
        title={data.title || "Text"}
        shortId={shortId}
        selected={selected}
        width={width}
        sourceHandle={{ id: "source", icon: Type, label: "Prompt Text" }}
        padded={true}
      >
        <div
          className="flex flex-col py-1"
          style={{
            height: height ? `${height - 24}px` : undefined,
            minHeight: `${MIN_HEIGHT}px`,
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder='Try "Happy dog with sunglasses and floating ring"'
            className="nodrag nowheel img-gen-prompt w-full h-full bg-transparent text-sm text-white placeholder:text-white/40 resize-none outline-none border-0 leading-relaxed"
          />
        </div>

        <DualResizeHandle
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          minHeight={MIN_HEIGHT}
          maxHeight={MAX_HEIGHT}
          currentWidth={width}
          currentHeight={height}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          forceVisible={!!selected}
        />
      </NodeShell>
    </div>
  );
}
