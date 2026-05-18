/**
 * Status normalisation - shared across all node types.
 *
 * The board store's NodeStatus union includes states this card-level
 * status dot does not visualise (e.g. legacy/intermediate values).
 * This helper collapses anything outside the visualised set to "idle"
 * so the dot stays predictable.
 */
import type { FlowboardNodeData } from "../../../store/board";

export type CardStatus = "idle" | "queued" | "running" | "done" | "error";

export function normaliseStatus(s: FlowboardNodeData["status"]): CardStatus {
  switch (s) {
    case "queued":
    case "running":
    case "done":
    case "error":
      return s;
    default:
      return "idle";
  }
}
