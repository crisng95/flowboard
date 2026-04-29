import { describeMedia, patchNode } from "./client";
import { useBoardStore } from "../store/board";

// Best-effort background vision call. Updates `data.aiBrief` on success;
// silently no-ops on failure (vision is a quality-of-life feature, not a
// blocker for the upload flow). Idempotent — won't re-call if a brief
// already exists for the same mediaId.
export async function requestAutoBrief(rfId: string, mediaId: string): Promise<void> {
  const { nodes } = useBoardStore.getState();
  const node = nodes.find((n) => n.id === rfId);
  if (!node) return;
  if (
    node.data.aiBrief &&
    typeof node.data.aiBrief === "string" &&
    node.data.aiBrief.length > 0 &&
    // If the brief was for the same media we can skip; if media changed,
    // we want a fresh brief.
    node.data.mediaId === mediaId
  ) {
    return;
  }

  useBoardStore.getState().updateNodeData(rfId, { aiBriefStatus: "pending" });

  try {
    const res = await describeMedia(mediaId);
    useBoardStore.getState().updateNodeData(rfId, {
      aiBrief: res.description,
      aiBriefStatus: "done",
    });
    // Persist so the brief survives reload — re-running vision per session
    // would burn CLI invocations for no reason. Backend merges `data` so
    // only the delta needs to ship.
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        data: { aiBrief: res.description },
      }).catch(() => {
        // local in-memory state is still correct for this session
      });
    }
  } catch {
    useBoardStore.getState().updateNodeData(rfId, { aiBriefStatus: "failed" });
  }
}
