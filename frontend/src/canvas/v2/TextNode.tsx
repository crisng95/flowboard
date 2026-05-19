import { useCallback, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import { Type } from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useBoardStore } from "../../store/board";
import { cn } from "../../lib/utils";
import { persistNodeData } from "./shared/persistNodeData";

const NODE_WIDTH = 320;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;

export function TextNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const text = (data.prompt as string | undefined) ?? "";
  const shortId = data.shortId as string | undefined;

  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMouseEnter = useCallback(() => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHovered(true);
  }, []);
  const onMouseLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHovered(false), HOVER_LEAVE_DELAY);
  }, []);
  const showControls = hovered || !!selected;

  const edges = useEdges();
  const hasSourceEdge = edges.some((e) => e.source === rfId);
  const connection = useConnection();
  const isConnecting = connection.inProgress && connection.fromNode?.id === rfId;
  const showHandle = showControls || hasSourceEdge || isConnecting;

  function setText(value: string) {
    useBoardStore.getState().updateNodeData(rfId, { prompt: value });
    persistNodeData(rfId, { prompt: value });
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width: NODE_WIDTH, padding: "0 16px 0 0" }}
    >
      {/* External header */}
      <div className="flex items-center gap-1.5 mb-2 pl-1">
        <Type size={12} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-primary font-medium leading-none">Text</span>
        {shortId && <span className="font-mono text-2xs text-ink-placeholder leading-none">#{shortId}</span>}
      </div>

      {/* Card */}
      <div
        data-selected={selected || undefined}
        className={cn(
          "relative transition-all duration-300 ease-out",
          "border-[3px] border-white/[0.14] shadow-lg",
          selected && "ring-2 ring-accent/50",
        )}
        style={{ borderRadius: BORDER_RADIUS, backgroundColor: "#1a1a1a" }}
      >
        <div className="px-4 py-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder='Try "Happy dog with sunglasses and floating ring"'
            rows={4}
            className="img-gen-prompt w-full bg-transparent text-sm text-white placeholder:text-white/40 resize-none outline-none border-0 leading-relaxed"
          />
        </div>
      </div>

      {/* Source handle (output) - right side, 48px from top */}
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className={cn(
          "!absolute !-right-0 !top-[48px] !h-7 !w-7 !border-0 !bg-transparent",
          "transition-opacity duration-300 ease-out",
          showHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none",
        )}
      >
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-300 ease-out"
          style={{
            backgroundColor: "#2b2b2b",
            borderColor: hasSourceEdge ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Type size={11} strokeWidth={2} />
        </div>
      </Handle>
    </div>
  );
}