import type { FlowNode } from "../../store/board";

export interface HelperLineResults {
  horizontal?: number;
  vertical?: number;
  snapPosition: { x: number; y: number };
}

interface NodeVisualBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  paddingLeft: number;
  paddingRight: number;
  offsetTop: number;
}

/**
 * Get absolute position of a node on the canvas.
 * Accounts for relative grouping positioning when parentId is present.
 */
export function getAbsolutePosition(node: FlowNode, allNodes: FlowNode[]): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let current = node;
  while (current.parentId) {
    const parent = allNodes.find((n) => n.id === current.parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    current = parent;
  }
  return { x, y };
}

/**
 * Calculates the exact visual stroke boundary of the card body for a node.
 * Bypasses external header titles and sidebar/handle paddings.
 */
export function getNodeVisualBounds(node: FlowNode, allNodes: FlowNode[]): NodeVisualBounds {
  const absPos = getAbsolutePosition(node, allNodes);
  const type = node.data?.type;

  let paddingLeft = 20;
  let paddingRight = 20;
  let offsetTop = 0;

  // Custom layout nodes render the header titles in the static block flow,
  // causing the card body stroke to be pushed down by ~24px.
  if (type === "reference" || type === "video" || type === "variant" || type === "add_reference") {
    paddingLeft = 20;
    paddingRight = 20;
    offsetTop = 24;
  } else if (type === "group") {
    // GroupNodeShell renders full-bleed without padding or header offsets
    paddingLeft = 0;
    paddingRight = 0;
    offsetTop = 0;
  } else {
    // Default NodeShell wrapper (note, text, upload, assistant, list)
    // Renders header absolutely at -top-6, so card body top starts at top: 0
    paddingLeft = 20;
    paddingRight = 20;
    offsetTop = 0;
  }

  const measuredW = node.measured?.width ?? node.data.nodeWidth ?? 260;
  const measuredH = node.measured?.height ?? node.data.nodeHeight ?? 200;

  const left = absPos.x + paddingLeft;
  const right = absPos.x + measuredW - paddingRight;
  const top = absPos.y + offsetTop;
  const bottom = absPos.y + measuredH;

  return {
    left,
    right,
    top,
    bottom,
    centerX: left + (right - left) / 2,
    centerY: top + (bottom - top) / 2,
    width: right - left,
    height: bottom - top,
    paddingLeft,
    paddingRight,
    offsetTop,
  };
}

/**
 * Calculates snapping position and alignment guides when dragging a node.
 * Aligns using visual card stroke bounds rather than wrapper DOM bounds.
 */
export function getDragHelperLines(
  draggedNode: FlowNode,
  allNodes: FlowNode[],
  snapDistance = 8
): HelperLineResults {
  const result: HelperLineResults = {
    snapPosition: { x: draggedNode.position.x, y: draggedNode.position.y },
  };

  // Only snap to other root nodes (non-groups and not grouped)
  const otherNodes = allNodes.filter(
    (n) => n.id !== draggedNode.id && n.data?.type !== "group" && !n.parentId
  );

  const draggedBounds = getNodeVisualBounds(draggedNode, allNodes);
  const draggedW = draggedNode.measured?.width ?? draggedNode.data.nodeWidth ?? 260;
  const draggedH = draggedNode.measured?.height ?? draggedNode.data.nodeHeight ?? 200;

  let minDiffX = snapDistance;
  let minDiffY = snapDistance;

  for (const other of otherNodes) {
    const otherBounds = getNodeVisualBounds(other, allNodes);

    // --- Vertical Guides (X Axis snap) ---
    // 1. Left aligned: dragged card left === other card left
    let diff = Math.abs(draggedBounds.left - otherBounds.left);
    if (diff < minDiffX) {
      minDiffX = diff;
      result.vertical = otherBounds.left;
      result.snapPosition.x = otherBounds.left - draggedBounds.paddingLeft;
    }
    // 2. Right aligned: dragged card right === other card right
    diff = Math.abs(draggedBounds.right - otherBounds.right);
    if (diff < minDiffX) {
      minDiffX = diff;
      result.vertical = otherBounds.right;
      result.snapPosition.x = otherBounds.right - (draggedW - draggedBounds.paddingRight);
    }
    // 3. Left-to-Right aligned: dragged card left === other card right
    diff = Math.abs(draggedBounds.left - otherBounds.right);
    if (diff < minDiffX) {
      minDiffX = diff;
      result.vertical = otherBounds.right;
      result.snapPosition.x = otherBounds.right - draggedBounds.paddingLeft;
    }
    // 4. Right-to-Left aligned: dragged card right === other card left
    diff = Math.abs(draggedBounds.right - otherBounds.left);
    if (diff < minDiffX) {
      minDiffX = diff;
      result.vertical = otherBounds.left;
      result.snapPosition.x = otherBounds.left - (draggedW - draggedBounds.paddingRight);
    }

    // --- Horizontal Guides (Y Axis snap) ---
    // 1. Top aligned: dragged card top === other card top
    diff = Math.abs(draggedBounds.top - otherBounds.top);
    if (diff < minDiffY) {
      minDiffY = diff;
      result.horizontal = otherBounds.top;
      result.snapPosition.y = otherBounds.top - draggedBounds.offsetTop;
    }
    // 2. Bottom aligned: dragged card bottom === other card bottom
    diff = Math.abs(draggedBounds.bottom - otherBounds.bottom);
    if (diff < minDiffY) {
      minDiffY = diff;
      result.horizontal = otherBounds.bottom;
      result.snapPosition.y = otherBounds.bottom - draggedH;
    }
    // 3. Top-to-Bottom aligned: dragged card top === other card bottom
    diff = Math.abs(draggedBounds.top - otherBounds.bottom);
    if (diff < minDiffY) {
      minDiffY = diff;
      result.horizontal = otherBounds.bottom;
      result.snapPosition.y = otherBounds.bottom - draggedBounds.offsetTop;
    }
    // 4. Bottom-to-Top aligned: dragged card bottom === other card top
    diff = Math.abs(draggedBounds.bottom - otherBounds.top);
    if (diff < minDiffY) {
      minDiffY = diff;
      result.horizontal = otherBounds.top;
      result.snapPosition.y = otherBounds.top - draggedH;
    }
  }

  return result;
}

/**
 * Calculates snapping and guides during node resize (scaling).
 * Aligns the resizing edge to visual card stroke boundaries of other nodes.
 */
export function getResizeHelperLines(
  proposedValue: number, // proposed absolute X coordinate of the changing card stroke border
  nodeId: string,
  allNodes: FlowNode[],
  snapDistance = 8
): { snappedValue: number; vertical?: number } {
  const otherNodes = allNodes.filter(
    (n) => n.id !== nodeId && n.data?.type !== "group" && !n.parentId
  );

  let snappedValue = proposedValue;
  let vertical: number | undefined = undefined;
  let minDiff = snapDistance;

  for (const other of otherNodes) {
    const otherBounds = getNodeVisualBounds(other, allNodes);
    const targets = [otherBounds.left, otherBounds.right];

    for (const target of targets) {
      const diff = Math.abs(proposedValue - target);
      if (diff < minDiff) {
        minDiff = diff;
        vertical = target;
        snappedValue = target;
      }
    }
  }

  return { snappedValue, vertical };
}

/**
 * Calculates snapping and guides for the bottom edge during node resize (scaling).
 * Aligns the resizing bottom edge to visual card stroke boundaries of other nodes.
 */
export function getResizeHelperLinesY(
  proposedBottom: number, // proposed absolute Y coordinate of the bottom card stroke border
  nodeId: string,
  allNodes: FlowNode[],
  snapDistance = 8
): { snappedBottom: number; horizontal?: number } {
  const otherNodes = allNodes.filter(
    (n) => n.id !== nodeId && n.data?.type !== "group" && !n.parentId
  );

  let snappedBottom = proposedBottom;
  let horizontal: number | undefined = undefined;
  let minDiff = snapDistance;

  for (const other of otherNodes) {
    const otherBounds = getNodeVisualBounds(other, allNodes);
    const targets = [otherBounds.top, otherBounds.bottom];

    for (const target of targets) {
      const diff = Math.abs(proposedBottom - target);
      if (diff < minDiff) {
        minDiff = diff;
        horizontal = target;
        snappedBottom = target;
      }
    }
  }

  return { snappedBottom, horizontal };
}

/**
 * Convert hex or rgba color to an `rgba(r, g, b, alpha)` string with the specified alpha.
 */
export function hexToRgba(color: string, alpha: number): string {
  if (color.startsWith("rgba")) {
    return color.replace(/[\d\.]+\)$/, `${alpha})`);
  }
  const cleaned = color.startsWith("#") ? color.slice(1) : color;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Returns the accent color for a node based on its type or user customizations.
 */
export function getNodeColor(node: FlowNode): string {
  const type = (node.data?.type || node.type) as string;
  if (type === "group") {
    const rawColor = node.data?.groupColor;
    return rawColor && rawColor !== "transparent" ? rawColor : "#7c5cff";
  }
  if (type === "note") {
    const noteColor = node.data?.noteColor as string | undefined;
    const NOTE_BORDER_COLORS: Record<string, string> = {
      grey: "#475569",
      red: "#f87171",
      orange: "#fb923c",
      yellow: "#f59e0b",
      green: "#10b981",
      teal: "#14b8a6",
      blue: "#3b82f6",
      purple: "#8b5cf6",
    };
    return (noteColor && NOTE_BORDER_COLORS[noteColor]) || "#7c5cff";
  }
  // Standard V2 node types
  if (type === "text") return "#a78bfa"; // Soft purple
  if (type === "video") return "#f43f5e"; // Soft rose
  if (type === "variant") return "#fb923c"; // Soft orange/amber
  if (type === "assistant") return "#34d399"; // Soft green
  if (type === "list") return "#818cf8"; // Soft indigo
  if (type === "upload" || type === "reference" || type === "image") {
    return "#60a5fa"; // Soft blue
  }
  return "#7c5cff"; // Default accent
}
