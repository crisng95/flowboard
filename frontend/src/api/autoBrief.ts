import { describeMedia, patchNode } from "./client";
import { useBoardStore } from "../store/board";
import { REF_STRUCTURAL_TAGS } from "../store/generation";

// Hybrid tags. Mirrors `_HYBRID_TAGS` in
// `flowboard/services/prompt_synth.py`; when one of these refs shares
// a target with a structural ref, the burn-and-bake rule demotes it
// to a material profile - and the vision brief must do the same so
// it does not narrate the pictured object.
const REF_HYBRID_TAGS = new Set(["photo", "3d_render"]);

// True when this hybrid `add_reference` shares any downstream target
// with a structural `add_reference`. Walks edges twice: outgoing
// from this node to enumerate targets, then incoming on each target
// to look for a structural sibling. Bounded by the (small) number of
// edges in a typical board.
function hybridSharesTargetWithStructure(rfId: string): boolean {
  const { nodes, edges } = useBoardStore.getState();
  const targetIds = edges.filter((e) => e.source === rfId).map((e) => e.target);
  if (targetIds.length === 0) return false;
  for (const tid of targetIds) {
    for (const e of edges) {
      if (e.target !== tid) continue;
      if (e.source === rfId) continue;
      const sibling = nodes.find((n) => n.id === e.source);
      if (!sibling || sibling.data.type !== "add_reference") continue;
      const siblingTag =
        typeof sibling.data.refType === "string" ? sibling.data.refType : null;
      if (siblingTag && REF_STRUCTURAL_TAGS.has(siblingTag)) return true;
    }
  }
  return false;
}

const REF_PREFIX: Record<string, string> = {
  texture: "[TEXTURE/MATERIAL REFERENCE]",
  sketch: "[SKETCH/LINEWORK REFERENCE]",
  photo: "[PHOTO REFERENCE]",
  mood: "[MOOD/COLOR PALETTE REFERENCE]",
  "3d_render": "[3D RENDER REFERENCE]",
  concept_art: "[CONCEPT ART/STYLE REFERENCE]",
};

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
    (node.data.aiBrief as string).length > 0 &&
    node.data.mediaId === mediaId
  ) {
    return;
  }

  useBoardStore.getState().updateNodeData(rfId, { aiBriefStatus: "pending" });

  try {
    // Forward the upstream `refType` so the backend vision service
    // can swap to its material-mode system prompt for material refs.
    // That mode strips object nouns (sword/dagger/blade/...) from
    // the brief; without it, those nouns leak into the auto-prompt
    // and re-introduce the composite bug downstream.
    // Defensive fallback: legacy `add_reference` nodes created before
    // we started seeding `data.refType` may have it undefined here.
    // Mirror the AddReferenceNode UI default ("texture") so those
    // nodes still route through the material-mode vision prompt -
    // otherwise the brief lands with object nouns ("daggers",
    // "sword") and re-introduces the composite bug downstream.
    let refType: string | null = null;
    let forceMaterialMode = false;
    if (node.data.type === "add_reference") {
      refType =
        typeof node.data.refType === "string" && node.data.refType.length > 0
          ? node.data.refType
          : "texture";
      // Hybrid tags switch to a material profile only when the same
      // target also has a structural ref upstream - that mirrors the
      // burn-and-bake rule applied later in prompt_synth.
      if (REF_HYBRID_TAGS.has(refType)) {
        forceMaterialMode = hybridSharesTargetWithStructure(rfId);
      }
    }
    const res = await describeMedia(mediaId, refType, forceMaterialMode);
    let description = res.description;

    // Prefix with refType context for add_reference nodes
    if (node.data.type === "add_reference" && typeof node.data.refType === "string") {
      const prefix = REF_PREFIX[node.data.refType as string] ?? "[REFERENCE]";
      description = `${prefix} ${description}`;
    }

    useBoardStore.getState().updateNodeData(rfId, {
      aiBrief: description,
      aiBriefStatus: "done",
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        data: { aiBrief: description },
      }).catch(() => {});
    }
  } catch {
    useBoardStore.getState().updateNodeData(rfId, { aiBriefStatus: "failed" });
  }
}
