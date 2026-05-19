/**
 * persistNodeData - shared helper for the data-edit pattern repeated
 * across every Concepta node:
 *   1. Optimistic in-memory update via the board store
 *   2. Async patchNode call to persist the change to the backend
 *
 * Settings drawers in particular call this on every field change so
 * customisations survive page reload. Using one helper means the
 * persistence contract (which keys go to the store vs the backend)
 * stays consistent across all nodes.
 */
import { patchNode } from "../../../api/client";
import { useBoardStore, type FlowboardNodeData } from "../../../store/board";

export function persistNodeData(
  nodeId: string,
  patch: Partial<FlowboardNodeData>,
): void {
  useBoardStore.getState().updateNodeData(nodeId, patch);
  const dbId = parseInt(nodeId, 10);
  if (Number.isNaN(dbId)) return;
  patchNode(dbId, { data: patch as Record<string, unknown> }).catch(() => {});
}