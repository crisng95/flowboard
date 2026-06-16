/**
 * useNodeWidth - shared resize-handle wiring.
 *
 * Every Concepta node persists a user-resized `nodeWidth` on its
 * data blob, clamped to per-node min/max bounds, with the same
 * pattern: live-update the store on drag, patch the backend on
 * release. Five copies of this exact code lived in the node
 * components before this hook existed; centralising prevents drift
 * the next time we tweak the persistence contract.
 *
 * Returns the current effective width plus the two callbacks the
 * shared <ResizeHandle> expects.
 */
import { useCallback, useState, useEffect } from "react";

import { patchNode } from "../../../api/client";
import { useBoardStore, type FlowboardNodeData } from "../../../store/board";

export interface UseNodeWidthOptions {
  nodeId: string;
  data: FlowboardNodeData;
  min: number;
  max: number;
  fallback: number;
}

export interface UseNodeWidthResult {
  width: number;
  onResize: (next: number) => void;
  onResizeEnd: (next: number) => void;
}

export function useNodeWidth({
  nodeId,
  data,
  min,
  max,
  fallback,
}: UseNodeWidthOptions): UseNodeWidthResult {
  const storeWidth = (data.nodeWidth as number | undefined) ?? fallback;
  const [localWidth, setLocalWidth] = useState<number>(storeWidth);

  // Sync with store width changes (e.g. from undo/redo, initial load)
  useEffect(() => {
    setLocalWidth(storeWidth);
  }, [storeWidth]);

  const onResize = useCallback(
    (next: number) => {
      setLocalWidth(next);
    },
    [],
  );

  const onResizeEnd = useCallback(
    (next: number) => {
      const clamped = Math.max(min, Math.min(max, Math.round(next)));
      setLocalWidth(clamped);
      useBoardStore.getState().updateNodeData(nodeId, { nodeWidth: clamped });
      const dbId = parseInt(nodeId, 10);
      if (!Number.isNaN(dbId)) {
        patchNode(dbId, { data: { nodeWidth: clamped } }).catch(() => {});
      }
    },
    [nodeId, min, max],
  );

  return { width: localWidth, onResize, onResizeEnd };
}
