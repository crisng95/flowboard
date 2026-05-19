import { type ConnectionLineComponentProps, getBezierPath } from "@xyflow/react";

/**
 * Custom connection line — dashed stroke with flowing animation.
 * Shown while the user drags from a handle to create a new edge.
 */
export function DashedConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke="rgba(124, 92, 255, 0.8)"
        strokeWidth={2.5}
        strokeDasharray="8 6"
        strokeLinecap="round"
        className="animated-dash"
      />
    </g>
  );
}