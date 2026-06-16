import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodes,
  type EdgeProps,
} from "@xyflow/react";

import type { FlowNode } from "../store/board";
import { getNodeColor, hexToRgba } from "./utils/helperLines";

/**
 * Edge variant: thin static wire + animated gradient spark.
 *
 * The spark uses stroke-dasharray + a linear gradient stroke (source → target
 * direction) so it picks up colour as it sweeps along the edge, creating a
 * smooth comet/energy-flow look. Two sparks run with a half-period offset so
 * there is always something moving on the wire.
 */
export function VariantEdge({
  id,
  source: _source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const nodes = useNodes<FlowNode>();
  const targetNode = nodes.find((n) => n.id === target);
  const isRunning =
    targetNode?.data.status === "running" ||
    targetNode?.data.status === "queued";

  const pin = (data?.sourceVariantIdx ?? null) as number | null;

  const sourceNode = nodes.find((n) => n.id === _source);
  const sourceNodeColor = sourceNode ? getNodeColor(sourceNode) : "#7c5cff";
  const edgeColor = hexToRgba(sourceNodeColor, isRunning ? 0.32 : 0.18);
  const { stroke: _unused, ...cleanStyle } = style || {};

  const gradientId = `ef-grad-${id}`;
  const glowId     = `ef-glow-${id}`;

  return (
    <>
      <defs>
        {/*
          Spark gradient aligned with the edge direction (source → target).
          Transparent color at both ends → bright near-white at 65%.
        */}
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%"   stopColor={hexToRgba(sourceNodeColor, 0.0)}  />
          <stop offset="35%"  stopColor={hexToRgba(sourceNodeColor, 0.7)} />
          <stop offset="65%"  stopColor="rgba(255,255,255,1.0)" />
          <stop offset="100%" stopColor={hexToRgba(sourceNodeColor, 0.1)}  />
        </linearGradient>

        {/* Soft glow behind the spark */}
        <filter id={glowId} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ── Static wire via BaseEdge ─────────────────────────────────
           BaseEdge renders both the visual stroke AND a transparent
           interaction path (interactionWidth=24) so the edge remains
           clickable / selectable / deletable via ReactFlow internals.
      ────────────────────────────────────────────────────────────── */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: edgeColor,
          strokeWidth: isRunning ? 2 : 3.5,
          strokeLinecap: "round",
          transition: "stroke 0.35s ease, stroke-width 0.35s ease",
          ...cleanStyle,
        }}
        markerEnd={markerEnd}
        interactionWidth={24}
      />

      {/* ── Animated gradient spark — only when running ──────────────── */}
      {isRunning && (
        <path
          d={edgePath}
          stroke={`url(#${gradientId})`}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
          strokeDasharray="70 280"
          className="energy-flow-spark"
          filter={`url(#${glowId})`}
        />
      )}

      {/* ── Variant pin chip ─────────────────────────────────────────── */}
      {pin !== null && pin >= 0 && (
        <EdgeLabelRenderer>
          <div
            className="variant-edge-pin"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            v{pin + 1}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}