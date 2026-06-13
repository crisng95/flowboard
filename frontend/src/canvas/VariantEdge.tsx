import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodes,
  type EdgeProps,
} from "@xyflow/react";

import type { FlowNode } from "../store/board";

/**
 * Edge variant: draws the standard bezier line plus a small chip at the
 * midpoint when the edge has a variant pin.
 *
 * When the TARGET node is running/queued, the edge renders as an
 * animated dashed line to indicate data is flowing.
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



  return (
    <>
      {/* Background static line */}
      <BaseEdge
        id={id + "-bg"}
        path={edgePath}
        style={{
          ...style,
          stroke: "rgba(124, 92, 255, 0.12)",
          strokeWidth: 4.5,
        }}
      />
      {/* Animated beam foreground */}
      {isRunning && (
        <BaseEdge
          id={id}
          path={edgePath}
          style={{
            ...style,
            stroke: "#e9d5ff",
            strokeWidth: 5.5,
            strokeLinecap: "round" as const,
            filter: "drop-shadow(0 0 4px rgba(192, 132, 252, 0.9))",
          }}
          markerEnd={markerEnd}
          className="animated-beam-droplet"
        />
      )}
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