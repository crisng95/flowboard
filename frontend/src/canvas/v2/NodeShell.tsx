/**
 * NodeShell — V2 base wrapper, rebuilt to match Magnific Spaces.
 *
 * Handle pattern mirrors ImageGeneratorNode exactly:
 *   - Wrapper has 20px horizontal padding → card body is inset 20px from edges.
 *   - Handles use !absolute !-right-0 / !-left-0 !top-[48px] so they sit
 *     exactly 20px outside the card body, floating in the gap.
 *   - Handles fade in/out on hover (opacity transition).
 *   - Handles stay visible when an edge is connected (accent border glow).
 *   - Handles stay visible while a connection drag is in progress.
 */
import { Handle, Position, useEdges, useConnection } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useState, useRef } from "react";

import { cn } from "../../lib/utils";
import { HandleBadge } from "./shared/HandleBadge";

interface HandleSpec {
  id: string;
  icon: LucideIcon;
  label?: string;
}

export interface NodeShellProps {
  id?: string;
  Icon: LucideIcon;
  title: string;
  shortId?: string;
  children: ReactNode;
  /** Apply default p-3 padding to the card body. false = full-bleed. */
  padded?: boolean;
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
  selected?: boolean;
  className?: string;
  width?: number;
  targetHandle?: HandleSpec;
  sourceHandle?: HandleSpec;
  status?: "idle" | "queued" | "running" | "done" | "error";
}

const STATUS_DOT_CLASS: Record<NonNullable<NodeShellProps["status"]>, string> = {
  idle: "bg-transparent",
  queued: "bg-status-queued",
  running: "bg-status-running animate-pulse-soft",
  done: "bg-status-done",
  error: "bg-status-error",
};

export function NodeShell({
  id,
  Icon,
  title,
  shortId,
  children,
  padded = true,
  toolbarLeft,
  toolbarRight,
  selected = false,
  className,
  width = 320,
  targetHandle,
  sourceHandle,
  status = "idle",
}: NodeShellProps) {
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseEnter = () => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
  };

  const onMouseLeave = () => {
    leaveTimer.current = setTimeout(() => setHovered(false), 200);
  };

  const showControls = hovered || !!selected;

  // Sniff edges + active connection — mirrors ImageGeneratorNode logic exactly.
  const edges = useEdges();
  const connection = useConnection();

  // Show source handle when: hovered/selected, source has an edge, or this node
  // is initiating a connection drag.
  const hasSourceEdge = !!(id && sourceHandle && edges.some((e) => e.source === id));
  const isConnectingFrom = !!(id && connection.inProgress && connection.fromNode?.id === id);
  const showSourceHandle = showControls || hasSourceEdge || isConnectingFrom;

  // Show target handle when: hovered/selected, target has an edge, or ANY
  // connection drag is in progress (so the user can drop onto this handle).
  const hasTargetEdge = !!(id && targetHandle && edges.some((e) => e.target === id));
  const showTargetHandle = showControls || hasTargetEdge || connection.inProgress;

  return (
    // 20px horizontal padding pushes the card body inward from the wrapper edges.
    // Handles are positioned with !-right-0 / !-left-0 at the wrapper boundary,
    // sitting exactly 20px outside the card border — identical to ImageGeneratorNode.
    <div
      className="relative font-sans"
      style={{ width, padding: "0 20px 0 20px" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* External title — 24px from wrapper left aligns with card body left edge */}
      <div className="absolute -top-6 left-[24px] flex items-center gap-1.5">
        <Icon size={12} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs font-normal text-ink-primary leading-none">
          {title}
        </span>
        {status !== "idle" && (
          <span
            className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[status])}
            aria-label={`Status: ${status}`}
          />
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
        data-status={status !== "idle" ? status : undefined}
        className={cn("node-surface relative", className)}
      >
        {(toolbarLeft || toolbarRight) && (
          <div
            className={cn(
              "flex items-center justify-between",
              padded ? "px-3 pt-3" : "px-3 pt-2.5 absolute inset-x-0 top-0 z-10",
            )}
          >
            <div className="flex items-center gap-0.5">{toolbarLeft}</div>
            <div className="flex items-center gap-0.5">{toolbarRight}</div>
          </div>
        )}
        <div
          className={cn(
            padded ? "p-3" : "",
            (toolbarLeft || toolbarRight) && padded ? "pt-2" : "",
          )}
        >
          {children}
        </div>
      </div>

      {/* SOURCE handle — right side.
          !absolute !-right-0 !top-[48px] matches ImageGeneratorNode exactly.
          48px from top keeps it near the top of the card regardless of card height.
          Border glows accent-purple when an edge is connected (matching ImageGeneratorNode). */}
      {sourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          id={sourceHandle.id}
          className={cn(
            "!absolute !-right-0 !top-[20px] !h-7 !w-7 !border-0 !bg-transparent group/handle",
            "transition-opacity duration-300 ease-out",
            showSourceHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none",
          )}
        >
          <HandleBadge
            icon={sourceHandle.icon}
            active={hasSourceEdge}
            label={sourceHandle.label}
            side="right"
          />
        </Handle>
      )}

      {/* TARGET handle — left side.
          !absolute !-left-0 !top-[48px] mirrors right handle symmetrically.
          Border glows accent-purple when an edge is connected. */}
      {targetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          id={targetHandle.id}
          className={cn(
            "!absolute !-left-0 !top-[20px] !h-7 !w-7 !border-0 !bg-transparent group/handle",
            "transition-opacity duration-300 ease-out",
            showTargetHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none",
          )}
        >
          <HandleBadge
            icon={targetHandle.icon}
            active={hasTargetEdge}
            label={targetHandle.label}
            side="left"
          />
        </Handle>
      )}
    </div>
  );
}
