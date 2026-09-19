import { describeMedia, patchNode } from "./client";
import { useBoardStore } from "../store/board";

// Best-effort background vision call. Updates `data.aiBrief` on success;
// silently no-ops on failure (vision is a quality-of-life feature, not a
// blocker for the upload flow). Idempotent — won't re-call if a brief
// already exists for the same mediaId.
//
// Prompt-first rule: when a node already carries a `prompt` (typed by the
// user, or auto-generated for a generation result), that prompt is the
// authoritative description for downstream synth — vision adds nothing
// and would just burn an LLM call. We skip and leave aiBrief unset.
// Vision only runs for upload-only nodes that never receive a prompt.
export async function requestAutoBrief(rfId: string, mediaId: string): Promise<void> {
  const { nodes } = useBoardStore.getState();
  const node = nodes.find((n) => n.id === rfId);
  if (!node) return;
  if (
    typeof node.data.prompt === "string" &&
    node.data.prompt.trim().length > 0
  ) {
    return;
  }
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

  // Pass the node id so the backend can write the brief itself. That is
  // what makes this survive a reload: the server does NOT cancel on client
  // disconnect, so refreshing mid-call used to leave a finished vision
  // result sitting in a Request row with nobody to apply it, because this
  // function — the only writer — died with the page.
  const dbId = parseInt(rfId, 10);
  const nodeDbId = isNaN(dbId) ? undefined : dbId;

  try {
    const res = await describeMedia(mediaId, nodeDbId);
    useBoardStore.getState().updateNodeData(rfId, {
      aiBrief: res.description,
      aiBriefStatus: "done",
    });
    // Belt-and-braces, exactly like the generation poll's PATCH (see
    // store/generation.ts): the backend already merged this same value
    // onto the node before it settled the request row, and that write is
    // now the authoritative one. This re-sends the identical value, so
    // the two cannot disagree — and it only runs when this tab survived
    // the call, which is the case the backend write also covers.
    if (nodeDbId !== undefined) {
      patchNode(nodeDbId, {
        data: { aiBrief: res.description },
      }).catch(() => {
        // local in-memory state is still correct for this session
      });
    }
  } catch {
    useBoardStore.getState().updateNodeData(rfId, { aiBriefStatus: "failed" });
  }
}
