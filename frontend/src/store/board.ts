import { create } from "zustand";
import type { Edge, Node } from "@xyflow/react";
import {
  listBoards,
  createBoard,
  getBoard,
  registerIdMapping,
  uuidToNumericId,
  patchBoard as apiPatchBoard,
  deleteBoard as apiDeleteBoard,
  createNode,
  patchNode,
  deleteNode,
  createEdge,
  deleteEdge,
  groupNodes as apiGroupNodes,
  ungroupNodes as apiUngroupNodes,
  type Board,
  type NodeType,
  type NodeStatus as ApiNodeStatus,
  type EdgeDTO,
  type NodeDTO as ApiNodeDTO,
} from "../api/client";

export type { NodeType };

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error" | "partial";

// Storyboard ï¿½ see .omc/plans/storyboard-image-node.md ï¿½4.1.
// Each shot is either a root (parentShotIdx=null ? gen_image) or a
// continuation (parentShotIdx=j<idx ? edit_image(base=shots[j].mediaId)).
// Sibling continuations dispatch in parallel after their parent finishes.
export type ShotStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "blocked"; // parent failed ? cannot dispatch until parent retried

export interface StoryboardShot {
  idx: number;
  prompt: string;
  parentShotIdx: number | null;
  mediaId?: string;
  assetId?: string;
  storageKey?: string;
  status: ShotStatus;
  error?: string;
}

export type StoryboardGrid = "2x2" | "2x3" | "2x4";

export interface FlowboardNodeData extends Record<string, unknown> {
  type: NodeType;
  shortId: string;
  title: string;
  status?: NodeStatus;
  prompt?: string;
  thumbnailUrl?: string;
  mediaId?: string;
  // Per-variant media ids in dispatch order. `null` entries are
  // positional placeholders for variants that failed (e.g. Veo content
  // filter blocked one of the 4 i2v clips while the other 3 succeeded);
  // keeping the slot preserves alignment with the upstream image's
  // variants for poster/edge-pin lookups.
  mediaIds?: (string | null)[];
  assetIds?: (string | null)[];
  storageKeys?: (string | null)[];
  flowMediaId?: string;
  flowMediaIds?: (string | null)[];
  // Per-slot error code, aligned to `mediaIds` indexing. `null` for
  // succeeded slots, an error string (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION")
  // for blocked ones. ResultViewer reads this to render the exact
  // filter reason on the blocked tile instead of falling through to
  // the previous variant.
  slotErrors?: (string | null)[];
  variantCount?: number;
  // The aspect-ratio enum the asset was generated / uploaded at ï¿½ used to
  // default-match downstream gen dialogs (e.g. a 9:16 visual_asset feeds
  // into a downstream image / video that defaults to 9:16). Values are
  // Flow's IMAGE_ASPECT_RATIO_* enum strings since that's what the upload
  // route + gen worker produce. Video targets map them onto the matching
  // VIDEO_ASPECT_RATIO_* enum at dialog-open time.
  aspectRatio?: string;
  // Pixel dimensions of the uploaded / generated image. Persisted so
  // the node can display the correct aspect-ratio immediately on
  // reload without waiting for the <img> onLoad event. The upload
  // route already returns `width` / `height` in its response; we
  // just need to stamp them here.
  imageWidth?: number;
  imageHeight?: number;
  nodeHeight?: number;
  // AI-generated factual description of mediaId (set by /api/vision/describe).
  // Spliced into auto-prompts on downstream nodes for richer context.
  // `null` is the explicit "clear this key" sentinel - undefined would
  // be dropped by JSON.stringify and leave the stale brief in place.
  // Used by uploads and by `setRefType` (clear-on-tag-change) to
  // force a fresh re-describe under the new vision profile.
  aiBrief?: string | null;
  aiBriefStatus?: "pending" | "done" | "failed";
  // Transient status while auto-prompt / auto-prompt-batch runs against
  // this node - set to "pending" while the
  // backend is composing the prompt, cleared on success/failure. Not
  // persisted to the DB; it's a few-second UX flag so the node can
  // render a visible "busy" treatment that blocks duplicate dispatches.
  autoPromptStatus?: "pending" | "done" | "failed";
  // ISO timestamp persisted when a generation completes successfully.
  // Powers the "5 phï¿½t tru?c" relative-time display in ResultViewer.
  // Uploads also stamp this so the timestamp reflects "when the asset
  // landed on the node" regardless of source.
  renderedAt?: string;
  // Model used to produce the rendered media. Populated on completion
  // of gen_image / edit_image (`imageModel`, e.g. "NANO_BANANA_PRO") or
  // gen_video (`videoQuality`, e.g. "fast" / "lite" / "quality"). Absent
  // on uploads (no model involved) and on nodes generated before this
  // feature shipped ï¿½ ResultViewer falls back to current settings as
  // plain text in that case so the user knows it's an estimate.
  imageModel?: string;
  videoQuality?: string;
  videoModel?: string;
  omniFlashDuration?: number;
  soundEnabled?: boolean;
  cameraMode?: string;
  startImageMediaId?: string;
  endImageMediaId?: string;
  listItems?: Array<Record<string, unknown>>;
  listViewMode?: "grid" | "list";
  listIntakeMode?: "keep" | "replace";
  listSelectionMode?: boolean;
  listSelectedIndexes?: number[];
  // Character-builder selections ï¿½ persisted on dispatch so the detail
  // panel can show "Country / Vibe / Gender" pills under METADATA. Keys
  // (`vn`, `clean`, `female`) match the constants in
  // `src/constants/character.ts`; viewer maps key ? display label.
  charCountry?: string;
  charVibe?: string;
  charGender?: string;
  // -- Concepta fork (concept node) -------------------------------------
  // Style preset (Stylized 3D / Anime / Realistic / ï¿½) and type
  // preset (Humanoid / Vehicle / Building / Weapon / ï¿½) chosen by
  // the user on a Concept node. Backend's auto-prompt synth reads
  // these to pick the right system prompt clauses (see
  // `services/concept/subject.py`). Keys match
  // `frontend/src/constants/concept.ts`.
  styleKey?: string;
  typeKey?: string;
  // Multi-view node ï¿½ preset key + per-angle metadata. Mirrors
  // `frontend/src/constants/concept.ts > MULTIVIEW_PRESETS`. The
  // dispatcher fans out as one root + N-1 edits in
  // `worker/processor.py:_handle_gen_multiview`.
  multiviewPreset?: string;
  angles?: string[];
  /** Per-angle error codes parallel to mediaIds. Null = ok. */
  angleErrors?: (string | null)[];
  // Part node ï¿½ region key (head / weapon / outfit_top / ï¿½). Mirrors
  // `agent/flowboard/services/concept/part.py:_PART_REGIONS`.
  // Frontend resolves the label via `GET /api/concepta/part-regions`.
  regionKey?: string;
  // Variant node ï¿½ picked axis + the user's free-text instruction
  // (e.g. axis=color + instruction="deep crimson and gold trim").
  // Backend composes the dispatched prompt from these via
  // `services/concept/variant.py:build_variant_prompt`.
  axisKey?: string;
  variantInstruction?: string;
  // User-resized node width in px. NodeResizeControl writes this on
  // resize-end; the V2 NodeShell reads it as `width` so the card
  // takes whatever footprint the user picked. Falls back to the
  // per-component default (Concept 300, Reference 260) when absent.
  nodeWidth?: number;
  error?: string;
  // Storyboard-only fields (type === "Storyboard"). See plan ï¿½4.1.
  shots?: StoryboardShot[];
  shotCount?: number; // 1..8; mirrors shots.length
  narrativeSeed?: string; // user free-text feeding the planner
  storyboardGrid?: StoryboardGrid;

  // Group node fields (type === "group"). The frame container that
  // owns child nodes via parent_id. `groupColor` drives the header /
  // border tint, `locked` cascades a draggable=false flag onto every
  // child so the whole cluster moves as one unit (or not at all).
  groupColor?: string;
  locked?: boolean;
}

export type FlowNode = Node<FlowboardNodeData>;

// Per-edge data we attach to ReactFlow's `Edge.data` so dispatch and
// edge-rendering paths can read it without a round-trip through the
// backend. `sourceVariantIdx` mirrors `EdgeDTO.source_variant_idx`.
export interface FlowboardEdgeData extends Record<string, unknown> {
  sourceVariantIdx?: number | null;
}

type ToolMode = "select" | "pan" | "cut";

type BoardSnapshot = {
  nodes: FlowNode[];
  edges: Edge<FlowboardEdgeData>[];
};

/** Map an EdgeDTO from the backend into ReactFlow's Edge shape, carrying
 * the variant pin through `data` so dispatch + edge UI can read it. */
function edgeFromDto(dto: {
  id: number;
  source_id: number;
  target_id: number;
  source_handle?: string | null;
  target_handle?: string | null;
  source_variant_idx?: number | null;
}): Edge<FlowboardEdgeData> {
  return {
    id: String(dto.id),
    source: String(dto.source_id),
    target: String(dto.target_id),
    sourceHandle: dto.source_handle ?? undefined,
    targetHandle: dto.target_handle ?? undefined,
    data: { sourceVariantIdx: dto.source_variant_idx ?? null },
  };
}

function defaultTargetHandleForConnection(sourceNode?: FlowNode, targetNode?: FlowNode): string | undefined {
  if (!sourceNode || !targetNode) return undefined;
  const sourceType = sourceNode.type ?? sourceNode.data?.type;
  const listItems = Array.isArray(sourceNode.data?.listItems) ? sourceNode.data.listItems : [];
  const isTextSource = sourceType === "text" || (sourceType === "list" && listItems.length > 0 && listItems[0]?.kind === "text");

  if (targetNode.data?.type === "video") {
    return isTextSource ? "target-text" : "target-start-image";
  }
  if (targetNode.data?.type === "list") {
    return isTextSource ? "target-text" : "target-image";
  }
  if (targetNode.data?.type !== "reference" && targetNode.data?.type !== "variant") {
    return "target";
  }
  return isTextSource ? "target-text" : "target-image";
}

function defaultSourceHandleForConnection(sourceNode?: FlowNode, targetNode?: FlowNode, targetHandle?: string): string {
  const sourceType = sourceNode?.type ?? sourceNode?.data?.type;
  if (sourceType === "list") {
    return targetHandle === "target-text" || targetNode?.data?.type === "text" ? "source-text" : "source-image";
  }
  return "source";
}
function cloneSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return {
    nodes: structuredClone(snapshot.nodes),
    edges: structuredClone(snapshot.edges),
  };
}

function snapshotSignature(snapshot: BoardSnapshot): string {
  return JSON.stringify({
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      parentId: node.parentId ?? null,
      extent: node.extent ?? null,
      zIndex: node.zIndex ?? null,
      data: node.data,
      style: node.style ?? null,
    })),
    edges: snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      data: edge.data ?? null,
    })),
  });
}

function snapshotFromState(nodes: FlowNode[], edges: Edge<FlowboardEdgeData>[]): BoardSnapshot {
  return cloneSnapshot({ nodes, edges });
}

function snapshotFromDetail(detail: { nodes: ApiNodeDTO[]; edges: EdgeDTO[] }): BoardSnapshot {
  return {
    nodes: applyGroupLockCascade(sortNodesParentFirst(detail.nodes.map((dto) => nodeFromDto(dto)))),
    edges: detail.edges.map(edgeFromDto),
  };
}

function stripNodeDataForPersistence(data: FlowboardNodeData): Record<string, unknown> {
  const { type: _type, shortId: _shortId, status: _status, ...persisted } = data;
  return structuredClone(persisted);
}

function nodeFrame(node: FlowNode): { w?: number; h?: number } {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return {
    w: typeof style.width === "number" ? style.width : undefined,
    h: typeof style.height === "number" ? style.height : undefined,
  };
}

async function reconcileSnapshotToBackend(
  boardId: number,
  current: BoardSnapshot,
  target: BoardSnapshot,
): Promise<void> {
  for (const edge of current.edges) {
    const dbId = parseInt(edge.id, 10);
    if (!Number.isNaN(dbId)) {
      try {
        await deleteEdge(dbId);
      } catch {
        // Best effort; missing edge after a prior delete is fine.
      }
    }
  }

  const targetNodeIds = new Set(target.nodes.map((node) => node.id));
  const nodesToDelete = current.nodes
    .filter((node) => !targetNodeIds.has(node.id))
    .sort((a, b) => Number(Boolean(b.parentId)) - Number(Boolean(a.parentId)));

  for (const node of nodesToDelete) {
    const dbId = parseInt(node.id, 10);
    if (!Number.isNaN(dbId)) {
      try {
        await deleteNode(dbId);
      } catch {
        // Ignore cascading/group delete races.
      }
    }
  }

  const currentNodeIds = new Set(current.nodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  for (const node of target.nodes) {
    if (currentNodeIds.has(node.id)) idMap.set(node.id, node.id);
  }

  for (const node of sortNodesParentFirst(target.nodes)) {
    const persistedData = stripNodeDataForPersistence(node.data);
    const parentId =
      node.parentId && idMap.get(node.parentId)
        ? parseInt(idMap.get(node.parentId)!, 10)
        : null;
    const frame = nodeFrame(node);

    if (currentNodeIds.has(node.id)) {
      const dbId = parseInt(node.id, 10);
      if (Number.isNaN(dbId)) continue;
      await patchNode(dbId, {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        w: frame.w,
        h: frame.h,
        status: node.data.status,
        parent_id: parentId,
        data: persistedData,
      });
      continue;
    }

    const created = await createNode({
      board_id: boardId,
      type: node.data.type,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      w: frame.w,
      h: frame.h,
      parent_id: parentId,
      data: persistedData,
    });
    idMap.set(node.id, String(created.id));
    if (node.data.status && node.data.status !== created.status) {
      await patchNode(created.id, { status: node.data.status });
    }
  }

  for (const edge of target.edges) {
    const sourceId = idMap.get(edge.source) ?? edge.source;
    const targetId = idMap.get(edge.target) ?? edge.target;
    const sourceDbId = parseInt(sourceId, 10);
    const targetDbId = parseInt(targetId, 10);
    if (Number.isNaN(sourceDbId) || Number.isNaN(targetDbId)) continue;
    await createEdge({
      board_id: boardId,
      source_id: sourceDbId,
      target_id: targetDbId,
      source_handle: edge.sourceHandle ?? "source",
      target_handle: edge.targetHandle ?? undefined,
      source_variant_idx: (edge.data?.sourceVariantIdx as number | null | undefined) ?? null,
    });
  }
}

// -- React Flow internal-update bridge --------------------------------
// React Flow caches each node's handle positions in absolute screen
// coords; flipping a node's `parentId` (= switching coordinate
// space) invalidates that cache but RF only refreshes it when
// `updateNodeInternals(ids)` is called explicitly. The hook lives in
// React land, so we let Board.tsx hand the function to the store on
// mount and the group / ungroup actions call back through this ref.
let updateNodeInternalsRef: ((ids: string[]) => void) | null = null;
export function registerUpdateNodeInternals(fn: ((ids: string[]) => void) | null) {
  updateNodeInternalsRef = fn;
}
function flushNodeInternals(ids: string[]) {
  if (!updateNodeInternalsRef || ids.length === 0) return;
  // Defer 100ms so React Flow has applied the node array change
  // (parentId / position) before we ask it to remeasure handles.
  setTimeout(() => {
    if (updateNodeInternalsRef) {
      updateNodeInternalsRef(ids);
    }
  }, 100);
}

// -- Tiny per-node debounce (no external deps) -----------------------------
const positionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncePosition(rfId: string, fn: () => void, delay = 150) {
  const existing = positionTimers.get(rfId);
  if (existing !== undefined) clearTimeout(existing);
  positionTimers.set(rfId, setTimeout(() => {
    positionTimers.delete(rfId);
    fn();
  }, delay));
}

// -- Type-to-title lookup ---------------------------------------------------
const TYPE_TITLE: Partial<Record<NodeType, string>> = {
  note: "Note",
  reference: "Image Generator",
  variant: "Variant",
  video: "Video Generator",
  upload: "Upload",
  list: "List",
  text: "Text",
  add_reference: "Add Reference",
  group: "Group",
  Storyboard: "Storyboard",
};

/**
 * Map a node DTO from the backend (`getBoard().nodes[i]`) into the
 * client-side FlowNode shape. Centralised so the three load paths
 * (`loadInitialBoard`, `switchBoard`, `refreshBoardState`) stay in
 * lock-step ï¿½ adding a new persisted field used to mean editing 3
 * places, which had bitrot risk every time we extended the schema.
 */
type NodeDTO = {
  id: number;
  type: NodeType;
  short_id: string;
  x: number;
  y: number;
  // Persisted width / height. Only consumed for `group` containers
  // (regular nodes self-size from their content). Stored on the
  // Node row so the frame keeps its dimensions across reloads.
  w?: number;
  h?: number;
  data: Record<string, unknown>;
  status: ApiNodeStatus;
  parent_id?: number | null;
};

function nodeFromDto(
  n: NodeDTO,
  fallbackData?: Partial<FlowboardNodeData>,
): FlowNode {
  const d =
    n.data && typeof n.data === "object" && !Array.isArray(n.data)
      ? n.data
      : {};
  const parentId = n.parent_id ?? undefined;
  const groupLocked = (d["locked"] as boolean | undefined) ?? false;
  // Group containers persist their own (w, h) on the Node row -
  // surface them as `style` so React Flow renders the frame at the
  // exact size we stored. Regular nodes self-size from content and
  // ignore this field.
  const baseFlowNode: Partial<FlowNode> = parentId !== undefined
    ? { parentId: String(parentId), extent: "parent" as const }
    : {};
  if (n.type === "group" && n.w && n.h) {
    baseFlowNode.style = { width: n.w, height: n.h };
    // Group frame sits beneath children + edges so it never
    // obscures handles or wires running between siblings.
    baseFlowNode.zIndex = -1;
  } else {
    // Regular nodes live above edges. Group frames are the only node
    // type intentionally allowed below the edge layer.
    baseFlowNode.zIndex = 1;
  }
  if (parentId !== undefined) {
    // Children stack above the frame so their handles + edges
    // remain interactive even when the group has a tinted body.
    baseFlowNode.zIndex = 1;
  }
  return {
    id: String(n.id),
    type: n.type,
    position: { x: n.x, y: n.y },
    ...baseFlowNode,
    // When the group itself (or any locked child) is locked we
    // disable React Flow drag at the node level. Selection +
    // toolbars stay interactive; only positional drift is gated.
    draggable: groupLocked ? false : undefined,
    data: {
      // When a caller already has a richer local copy of the node
      // (for example right before a group / ungroup response rewrites
      // only parent/position), keep those keys as a fallback and let
      // the freshly persisted DTO win for any field it explicitly
      // returned.
      ...fallbackData,
      // Pass-through every field the backend persisted so newly added
      // node-data keys (model selections, aspect ratio, refType, tags,
      // future settings...) survive a reload without each new feature
      // having to register itself in this whitelist. The explicit
      // overrides below still win for typed fields like `type` /
      // `shortId` / `status` that come from sibling NodeDTO columns,
      // not from the JSON `data` blob.
      ...d,
      type: n.type,
      shortId: n.short_id,
      title: (d["title"] as string | undefined) ?? TYPE_TITLE[n.type] ?? "Node",
      status: n.status,
      prompt: d["prompt"] as string | undefined,
      thumbnailUrl: d["thumbnailUrl"] as string | undefined,
      mediaId: d["mediaId"] as string | undefined,
      mediaIds: d["mediaIds"] as (string | null)[] | undefined,
      slotErrors: d["slotErrors"] as (string | null)[] | undefined,
      variantCount: d["variantCount"] as number | undefined,
      aspectRatio: d["aspectRatio"] as string | undefined,
      aspectKey: d["aspectKey"] as string | undefined,
      aspectRatioOverride: d["aspectRatioOverride"] as string | undefined,
      imageWidth: d["imageWidth"] as number | undefined,
      imageHeight: d["imageHeight"] as number | undefined,
      aiBrief: d["aiBrief"] as string | null | undefined,
      aiBriefStatus: d["aiBriefStatus"] as FlowboardNodeData["aiBriefStatus"],
      autoPromptStatus:
        d["autoPromptStatus"] as FlowboardNodeData["autoPromptStatus"],
      renderedAt: d["renderedAt"] as string | undefined,
      imageModel: d["imageModel"] as string | undefined,
      modelKey: d["modelKey"] as string | undefined,
      videoQuality: d["videoQuality"] as string | undefined,
      videoModel: d["videoModel"] as string | undefined,
      omniFlashDuration: d["omniFlashDuration"] as number | undefined,
      soundEnabled: d["soundEnabled"] as boolean | undefined,
      cameraMode: d["cameraMode"] as string | undefined,
      startImageMediaId: d["startImageMediaId"] as string | undefined,
      endImageMediaId: d["endImageMediaId"] as string | undefined,
      // Legacy character builder (still loaded for old boards)
      charCountry: d["charCountry"] as string | undefined,
      charVibe: d["charVibe"] as string | undefined,
      charGender: d["charGender"] as string | undefined,
      storyboardGrid: d["storyboardGrid"] as StoryboardGrid | undefined,
      // Concepta fork
      styleKey: d["styleKey"] as string | undefined,
      typeKey: d["typeKey"] as string | undefined,
      // Multi-view metadata ï¿½ angles + per-angle errors carry through
      // the dispatch loop. The root angle gets the ? marker in the
      // tile UI; angle errors render as ? slot fail badges.
      multiviewPreset: d["multiviewPreset"] as string | undefined,
      angles: d["angles"] as string[] | undefined,
      angleErrors: d["angleErrors"] as (string | null)[] | undefined,
      // Part / Variant metadata
      regionKey: d["regionKey"] as string | undefined,
      axisKey: d["axisKey"] as string | undefined,
      variantInstruction: d["variantInstruction"] as string | undefined,
      refType: d["refType"] as string | undefined,
      // Group node fields
      groupColor: d["groupColor"] as string | undefined,
      locked: d["locked"] as boolean | undefined,
      // User-resized width persisted per node ï¿½ read here so a refresh
      // doesn't snap the node back to its default size.
      nodeWidth: d["nodeWidth"] as number | undefined,
      error: d["error"] as string | undefined,
    },
  };
}

/**
 * Cascade `data.locked` from each group node down to its children by
 * flipping every interactive flag (draggable / selectable /
 * connectable) to false. Run after mapping a board response so every
 * load path (initial / switch / refresh) ends up with a consistent
 * lock state. Children do not persist their own `data.locked`, so
 * without this pass a locked group would silently lose its grip on
 * its children after every reload.
 */
function applyGroupLockCascade(nodes: FlowNode[]): FlowNode[] {
  const lockedGroupIds = new Set(
    nodes.filter((n) => n.data.type === "group" && n.data.locked === true).map((n) => n.id),
  );
  if (lockedGroupIds.size === 0) return nodes;
  return nodes.map((n) => {
    if (n.parentId && lockedGroupIds.has(n.parentId)) {
      return {
        ...n,
        draggable: false,
        selectable: false,
        connectable: false,
      };
    }
    return n;
  });
}

/**
 * React Flow v12 requires every parent node to appear BEFORE any of
 * its children in the `nodes` array; otherwise it cannot resolve the
 * parent reference at the time it processes the child and falls back
 * to treating the relative `(x, y)` as absolute - which is exactly
 * what was making grouped clusters drift on reload. The backend
 * returns rows in created_at order, which has no guarantee of
 * parent-first ordering, so we re-sort here.
 */
function sortNodesParentFirst(nodes: FlowNode[]): FlowNode[] {
  // One-pass partition: roots / groups first (preserving relative
  // order), then every child appended. Stable sort keeps non-group
  // ordering intact for downstream code that relies on it.
  const roots: FlowNode[] = [];
  const children: FlowNode[] = [];
  for (const n of nodes) {
    if (n.parentId !== undefined) children.push(n);
    else roots.push(n);
  }
  return [...roots, ...children];
}

// -- Persisted active-board id ---------------------------------------------
// Survives page reloads so refreshing on project #4 doesn't kick the user
// back to project #1. localStorage is fine here ï¿½ single-user, single-host.
const ACTIVE_BOARD_KEY = "flowboard.activeBoardId";

function projectIdFromLocation(): number | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/project\/([^/]+)(?:\/)?$/);
  if (!match) return null;
  const raw = decodeURIComponent(match[1]);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    const mapped = uuidToNumericId(raw);
    registerIdMapping(mapped, raw);
    return mapped;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function setProjectLocation(id: number | null): void {
  if (typeof window === "undefined") return;
  const nextPath = id === null ? "/" : `/project/${id}`;
  if (window.location.pathname === nextPath) return;
  window.history.pushState({}, "", nextPath);
}

function loadPersistedBoardId(): number | null {
  const routeId = projectIdFromLocation();
  if (routeId !== null) return routeId;
  try {
    const raw = localStorage.getItem(ACTIVE_BOARD_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistBoardId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_BOARD_KEY);
    else localStorage.setItem(ACTIVE_BOARD_KEY, String(id));
  } catch {
    // Storage disabled / quota exceeded ï¿½ non-fatal, just lose persistence.
  }
}

// -- Store ------------------------------------------------------------------
interface BoardState {
  currentView: "spaces" | "canvas";
  toolMode: ToolMode;
  boardId: number | null;
  boardName: string;
  // Lightweight summary list rendered by the ProjectSidebar ï¿½ full node /
  // edge content lives only on the active board to keep memory bounded.
  boards: Board[];
  nodes: FlowNode[];
  edges: Edge[];
  loading: boolean;
  error: string | null;
  historyPast: BoardSnapshot[];
  historyFuture: BoardSnapshot[];
  historyPresent: BoardSnapshot | null;
  historySuspend: boolean;
  showAuthModal: boolean;
  setShowAuthModal(val: boolean): void;
  showExtensionModal: boolean;
  setShowExtensionModal(val: boolean): void;

  setView(view: "spaces" | "canvas"): void;
  setToolMode(mode: ToolMode): void;
  selectProject(id: number): Promise<void>;
  commitHistorySnapshot(): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  loadInitialBoard(): Promise<void>;
  refreshBoardState(): Promise<void>;
  refreshBoardList(): Promise<void>;
  renameBoard(name: string): Promise<void>;
  renameBoardById(id: number, name: string): Promise<void>;
  // Switch the active board: load detail, replace nodes/edges, reset
  // poll-state on the generation store.
  switchBoard(id: number): Promise<void>;
  // Create a new board, switch to it, return id.
  createNewBoard(name: string): Promise<number | null>;
  createBoardFromSnapshot(name: string, snapshot: BoardSnapshot): Promise<number | null>;
  duplicateBoardById(id: number, name?: string): Promise<number | null>;
  // Delete a board. If it's the active one, switch to first remaining
  // board (or create a fresh "Untitled" if list ends up empty).
  deleteBoardById(id: number): Promise<void>;

  // Returns the new node's rfId on success, or null if creation failed.
  // Callers that need to wire up an edge immediately (e.g. drop-popover
  // shortcut) need the id back synchronously.
  addNodeOfType(type: NodeType, position: { x: number; y: number }): Promise<string | null>;
  // Spawn a brand-new add_reference node from a saved Reference. Used by
  // both the panel click-to-spawn path and the canvas drop-to-spawn path.
  // The new node lands with status="done" + mediaId + aiBrief already
  // populated so its thumbnail loads immediately and it can be used as a
  // downstream ref without any extra round-trip.
  addReferenceNode(
    ref: {
      mediaId: string;
      aiBrief?: string | null;
      aspectRatio?: string | null;
      kind: string;
      label: string;
    },
    position: { x: number; y: number },
  ): Promise<string | null>;
  persistNodePosition(rfId: string, position: { x: number; y: number }): Promise<void>;
  deleteNodeByRfId(rfId: string): Promise<void>;
  addEdgeFromConnection(source: string, target: string, sourceHandle?: string, targetHandle?: string): Promise<void>;
  deleteEdgeByRfId(rfId: string): Promise<void>;
  // Spawn an empty sibling node next to `rfId` with the same type and the
  // same upstream edges. Returns the new node's rfId so callers can focus
  // / open the generation dialog on it. Used by ResultViewer's
  // "New variant +" ï¿½ gives the user a fresh canvas to gen another shot
  // sharing the original's source refs.
  cloneNodeWithUpstream(rfId: string): Promise<string | null>;

  // Group operations -----------------------------------------------
  // Pack the supplied root nodes into a fresh `group` container.
  // Returns the new group rfId on success, or null when the
  // selection is invalid (empty / contains a node that already has
  // a parent / contains a group). The store recomputes the
  // bounding box client-side so the new group sits exactly around
  // the rendered nodes.
  groupNodes(rfIds: string[]): Promise<string | null>;
  // Inverse of `groupNodes`: detach every child, restore their
  // absolute coordinates, then drop the group node.
  ungroupNodes(groupRfId: string): Promise<void>;
  // Update the group accent color (palette pick from the toolbar).
  updateGroupColor(groupRfId: string, color: string): Promise<void>;
  // Toggle the lock flag on a group; cascades draggable=false to
  // every child so the entire cluster freezes in place.
  toggleGroupLock(groupRfId: string): Promise<void>;
  // Inline-rename helper for the group header.
  renameGroup(groupRfId: string, title: string): Promise<void>;
  // Duplicate a group plus every child + every internal edge. The
  // clone lands offset by (60, 60) so the user can immediately see
  // it next to the original. Returns the new group rfId.
  duplicateGroup(groupRfId: string): Promise<string | null>;
  // Cascade-delete a group and every child (backend handles the
  // children automatically; we mirror the state update here).
  deleteGroupCascade(groupRfId: string): Promise<void>;
  // Persist a new (width, height) for a group after the user
  // finishes a NodeResizer drag. Updates local React Flow state
  // immediately and PATCHes the row so the size survives reloads.
  persistGroupSize(groupRfId: string, width: number, height: number): Promise<void>;
  // Re-parent a node to a group (or remove it from its parent group if parentRfId is undefined)
  reparentNode(nodeRfId: string, parentRfId: string | undefined, absX: number, absY: number): Promise<void>;

  updateNodeData(rfId: string, partial: Partial<FlowboardNodeData>): void;
  /** Merge `partial` into edge.data ï¿½ used to refresh the local cache
   * after a PATCH /api/edges/{id} so the badge updates without waiting
   * for a full board refresh. */
  updateEdgeData(edgeId: string, partial: Partial<FlowboardEdgeData>): void;
  setNodes(nodes: FlowNode[]): void;
  setEdges(edges: Edge[]): void;
  clearError(): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  currentView: projectIdFromLocation() !== null ? "canvas" : "spaces",
  toolMode: "select",
  boardId: null,
  boardName: "",
  boards: [],
  nodes: [],
  edges: [],
  loading: false,
  error: null,
  historyPast: [],
  historyFuture: [],
  historyPresent: null,
  historySuspend: false,
  showAuthModal: false,
  setShowAuthModal(val) { set({ showAuthModal: val }); },
  showExtensionModal: false,
  setShowExtensionModal(val) { set({ showExtensionModal: val }); },

  setView(view) {
    set({ currentView: view });
    if (view === "spaces") setProjectLocation(null);
    if (view === "canvas" && get().boardId !== null) setProjectLocation(get().boardId);
  },

  setToolMode(mode) {
    set({ toolMode: mode });
  },

  async selectProject(id) {
    await get().switchBoard(id);
    set({ currentView: "canvas" });
    setProjectLocation(id);
  },

  commitHistorySnapshot() {
    const state = get();
    if (state.historySuspend) return;
    const current = snapshotFromState(state.nodes, state.edges);
    const signature = snapshotSignature(current);
    const present = state.historyPresent;
    if (present && snapshotSignature(present) === signature) return;
    set((s) => ({
      historyPast: s.historyPresent
        ? [...s.historyPast.slice(-39), cloneSnapshot(s.historyPresent)]
        : s.historyPast,
      historyFuture: [],
      historyPresent: current,
    }));
  },

  async undo() {
    const state = get();
    if (state.boardId === null || state.historyPast.length === 0 || state.historyPresent === null) return;
    const current = snapshotFromState(state.nodes, state.edges);
    const target = cloneSnapshot(state.historyPast[state.historyPast.length - 1]);
    const nextPast = state.historyPast.slice(0, -1);
    const nextFuture = [cloneSnapshot(state.historyPresent), ...state.historyFuture].slice(0, 40);
    set({ historySuspend: true });
    try {
      await reconcileSnapshotToBackend(state.boardId, current, target);
      const detail = await getBoard(state.boardId);
      const restored = snapshotFromDetail(detail);
      set({
        nodes: restored.nodes,
        edges: restored.edges,
        historyPast: nextPast,
        historyFuture: nextFuture,
        historyPresent: cloneSnapshot(restored),
        historySuspend: false,
      });
    } catch (error) {
      console.error("undo failed", error);
      set({ historySuspend: false, error: "Undo failed" });
    }
  },

  async redo() {
    const state = get();
    if (state.boardId === null || state.historyFuture.length === 0 || state.historyPresent === null) return;
    const current = snapshotFromState(state.nodes, state.edges);
    const target = cloneSnapshot(state.historyFuture[0]);
    const nextFuture = state.historyFuture.slice(1);
    const nextPast = [...state.historyPast.slice(-39), cloneSnapshot(state.historyPresent)];
    set({ historySuspend: true });
    try {
      await reconcileSnapshotToBackend(state.boardId, current, target);
      const detail = await getBoard(state.boardId);
      const restored = snapshotFromDetail(detail);
      set({
        nodes: restored.nodes,
        edges: restored.edges,
        historyPast: nextPast,
        historyFuture: nextFuture,
        historyPresent: cloneSnapshot(restored),
        historySuspend: false,
      });
    } catch (error) {
      console.error("redo failed", error);
      set({ historySuspend: false, error: "Redo failed" });
    }
  },

  async loadInitialBoard() {
    set({ loading: true, error: null });
    try {
      const boards = await listBoards();
      // Prefer the user's last-active board if it still exists; fall back
      // to the first board in the list. Without this, refresh always
      // snapped back to boards[0] regardless of what was selected before.
      const persistedId = loadPersistedBoardId();
      const board =
        (persistedId !== null && boards.find((b) => b.id === persistedId)) ||
        boards[0];
      if (!board) {
        persistBoardId(null);
        set({
          boardId: null,
          boardName: "",
          boards: [],
          nodes: [],
          edges: [],
          loading: false,
          currentView: "spaces",
          historyPast: [],
          historyFuture: [],
          historyPresent: null,
          historySuspend: false,
        });
        setProjectLocation(null);
        return;
      }
      const detail = await getBoard(board.id);
      const snapshot = snapshotFromDetail(detail);

      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        boards,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        loading: false,
        historyPast: [],
        historyFuture: [],
        historyPresent: cloneSnapshot(snapshot),
        historySuspend: false,
      });
      persistBoardId(detail.board.id);
      if (projectIdFromLocation() !== null) set({ currentView: "canvas" });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshBoardList() {
    try {
      const boards = await listBoards();
      set({ boards });
    } catch {
      // non-fatal
    }
  },

  async switchBoard(id) {
    if (id === get().boardId) return;
    set({ loading: true, error: null });
    try {
      const detail = await getBoard(id);
      const snapshot = snapshotFromDetail(detail);
      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        loading: false,
        historyPast: [],
        historyFuture: [],
        historyPresent: cloneSnapshot(snapshot),
        historySuspend: false,
      });
      persistBoardId(detail.board.id);
      setProjectLocation(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createNewBoard(name) {
    try {
      const board = await createBoard(name || "Untitled");
      // Add to list (front of list so the newly-created project shows up
      // at the top of the sidebar) and switch to it.
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async createBoardFromSnapshot(name, snapshot) {
    try {
      const board = await createBoard(name?.trim() || "Untitled space");
      const idMap = new Map<string, number>();
      const sourceNodes = sortNodesParentFirst(snapshot.nodes);

      for (const node of sourceNodes) {
        const persistedData = stripNodeDataForPersistence(node.data);
        const frame = nodeFrame(node);
        const created = await createNode({
          board_id: board.id,
          type: node.data.type,
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
          w: frame.w,
          h: frame.h,
          parent_id:
            node.parentId && idMap.has(node.parentId)
              ? idMap.get(node.parentId) ?? null
              : null,
          data: persistedData,
        });
        idMap.set(node.id, created.id);
        if (node.data.status && node.data.status !== created.status) {
          await patchNode(created.id, { status: node.data.status });
        }
      }

      for (const edge of snapshot.edges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) continue;
        await createEdge({
          board_id: board.id,
          source_id: nextSource,
          target_id: nextTarget,
          kind: "default",
          source_handle: edge.sourceHandle ?? null,
          target_handle: edge.targetHandle ?? null,
          source_variant_idx: edge.data?.sourceVariantIdx ?? null,
        });
      }

      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async duplicateBoardById(id, name) {
    try {
      const detail = await getBoard(id);
      const board = await createBoard(name?.trim() || `${detail.board.name || "Untitled space"} (Copy)`);
      const idMap = new Map<number, number>();
      const sourceNodes = sortNodesParentFirst(detail.nodes.map((dto) => nodeFromDto(dto)));

      for (const node of sourceNodes) {
        const sourceDbId = parseInt(node.id, 10);
        if (Number.isNaN(sourceDbId)) continue;
        const persistedData = stripNodeDataForPersistence(node.data);
        const frame = nodeFrame(node);
        const created = await createNode({
          board_id: board.id,
          type: node.data.type,
          x: Math.round(node.position.x + 40),
          y: Math.round(node.position.y + 40),
          w: frame.w,
          h: frame.h,
          parent_id:
            node.parentId && idMap.has(parseInt(node.parentId, 10))
              ? idMap.get(parseInt(node.parentId, 10)) ?? null
              : null,
          data: persistedData,
        });
        idMap.set(sourceDbId, created.id);
        if (node.data.status && node.data.status !== created.status) {
          await patchNode(created.id, { status: node.data.status });
        }
      }

      for (const edge of detail.edges) {
        const nextSource = idMap.get(edge.source_id);
        const nextTarget = idMap.get(edge.target_id);
        if (!nextSource || !nextTarget) continue;
        await createEdge({
          board_id: board.id,
          source_id: nextSource,
          target_id: nextTarget,
          kind: edge.kind,
          source_handle: edge.source_handle,
          target_handle: edge.target_handle,
          source_variant_idx: edge.source_variant_idx,
        });
      }

      set((s) => ({ boards: [board, ...s.boards] }));
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async deleteBoardById(id) {
    try {
      await apiDeleteBoard(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const remaining = get().boards.filter((b) => b.id !== id);
    set({ boards: remaining });
    // If we just deleted the active board, switch to the first remaining
    // board ï¿½ or create a fresh "Untitled" if none left.
    if (get().boardId === id) {
      if (remaining.length > 0) {
        await get().switchBoard(remaining[0].id);
      } else {
        persistBoardId(null);
        set({
          currentView: "spaces",
          boardId: null,
          boardName: "",
          nodes: [],
          edges: [],
          loading: false,
          historyPast: [],
          historyFuture: [],
          historyPresent: null,
          historySuspend: false,
        });
        setProjectLocation(null);
      }
    }
  },

  async refreshBoardState() {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      const snapshot = snapshotFromDetail(detail);
      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        historyPast: [],
        historyFuture: [],
        historyPresent: cloneSnapshot(snapshot),
        historySuspend: false,
      });
    } catch {
      // ignore ï¿½ leave state alone, next poll will retry
    }
  },

  async renameBoard(name: string) {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const updated = await apiPatchBoard(boardId, name);
      set((s) => ({
        boardName: updated.name,
        boards: s.boards.map((b) =>
          b.id === boardId ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch {
      // non-fatal; keep local name
    }
  },

  async renameBoardById(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const updated = await apiPatchBoard(id, trimmed);
      set((s) => ({
        boardName: s.boardId === id ? updated.name : s.boardName,
        boards: s.boards.map((b) =>
          b.id === id ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async addNodeOfType(type, position) {
    const { boardId, nodes } = get();
    if (boardId === null) return null;
    const title = type === "list"
      ? `List #${nodes.filter((node) => (node.data.type ?? node.type) === "list").length + 1}`
      : TYPE_TITLE[type];
    // Per-type seed data. `add_reference` MUST land with an explicit
    // `refType` so the auto-brief vision call routes through the
    // material-mode prompt for material tags. Without this, freshly
    // created nodes fall through `data.refType === undefined` and
    // the brief gets the default annotator prompt that names the
    // pictured object ("daggers", "sword") - which then leaks into
    // auto-prompt synth.
    const seedData: Record<string, unknown> = { title };
    if (type === "add_reference") {
      seedData.refType = "texture";
    }
    if (type === "list") {
      seedData.listViewMode = "grid";
      seedData.listIntakeMode = "replace";
      seedData.listSelectionMode = false;
      seedData.listSelectedIndexes = [];
      seedData.nodeWidth = 580;
    }
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: seedData,
      });
      const node = nodeFromDto(dto);
      set((s) => ({ nodes: [...s.nodes, node] }));

      // -- Auto-connect (Concepta workflow UX) ----------------------
      // When the user drops a downstream node type (multiview / part /
      // variant) and there's exactly ONE selected concept-bearing node
      // on the canvas, auto-wire an edge from that concept to the new
      // node. Saves the user from having to manually drag an edge
      // every time ï¿½ the most common workflow is "select concept ?
      // add Part" and the edge is implied.
      //
      // Rules:
      //   - Only fires for downstream types that NEED an upstream
      //     (multiview, part, variant). Reference + Concept are roots.
      //   - Only fires when exactly 1 node is selected AND that node
      //     is a valid upstream type (concept / multiview / part /
      //     variant / reference ï¿½ anything with media output).
      //   - Does NOT fire if the user already has an edge to this new
      //     node (e.g. from the drop-popover path which wires its own).
      const DOWNSTREAM_TYPES: Set<NodeType> = new Set(["variant"]);
      const VALID_UPSTREAM_TYPES: Set<NodeType> = new Set([
        "reference",
        "upload",
        "add_reference",
        "variant",
        "list",
      ]);
      if (DOWNSTREAM_TYPES.has(type)) {
        const selected = nodes.filter((n) => n.selected);
        if (selected.length === 1 && VALID_UPSTREAM_TYPES.has(selected[0].data.type)) {
          // Check no edge already exists (defensive ï¿½ drop-popover
          // path creates its own edge before calling addNodeOfType).
          const existingEdge = get().edges.find(
            (e) => e.source === selected[0].id && e.target === node.id,
          );
          if (!existingEdge) {
            await get().addEdgeFromConnection(selected[0].id, node.id);
          }
        }
      }

      return node.id;
    } catch (err) { console.error("addNodeOfType failed:", err);
      // surface silently for now
    }
    return null;
  },

  async addReferenceNode(ref, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = ref.label || "Reference";
    try {
      const dto = await createNode({
        board_id: boardId,
        type: "add_reference",
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: {
          title,
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          status: "done",
          renderedAt: new Date().toISOString(),
        },
      });
      // Mirror addNodeOfType's local-state insertion, but propagate the
      // rich data fields so the add_reference body renders the thumbnail
      // straight away (instead of falling into the empty-state CTA).
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: "done",
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          renderedAt: new Date().toISOString(),
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return node.id;
    } catch (err) {
      console.error("addReferenceNode failed", { mediaId: ref.mediaId, err });
    }
    return null;
  },

  async persistNodePosition(rfId, position) {
    debouncePosition(rfId, async () => {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) return;
      try {
        await patchNode(dbId, { x: Math.round(position.x), y: Math.round(position.y) });
      } catch {
        // ignore persist failures
      }
    });
  },

  async deleteNodeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    // Cancel any pending debounced patch for this node (it would 404 after delete).
    const pending = positionTimers.get(rfId);
    if (pending !== undefined) {
      clearTimeout(pending);
      positionTimers.delete(rfId);
    }
    // Also cancel any in-flight generation poll ï¿½ otherwise the poll loop
    // keeps pinging the server about a node that no longer exists.
    // Dynamic import to avoid a circular store dependency at module init.
    try {
      const { useGenerationStore } = await import("./generation");
      useGenerationStore.getState().cancelGeneration(rfId);
    } catch {
      // If the module isn't loaded yet (tree-shaken test path), ignore.
    }
    try {
      await deleteNode(dbId);
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== rfId),
        edges: s.edges.filter((e) => e.source !== rfId && e.target !== rfId),
      }));
    } catch {
      // ignore
    }
  },

  async addEdgeFromConnection(source, target, sourceHandle?, targetHandle?) {
    const { boardId, nodes } = get();
    if (boardId === null) return;
    const sourceId = parseInt(source, 10);
    const targetId = parseInt(target, 10);
    if (isNaN(sourceId) || isNaN(targetId)) return;
    const resolvedTargetHandle =
      targetHandle && targetHandle.trim()
        ? targetHandle
        : defaultTargetHandleForConnection(
            nodes.find((n) => n.id === source),
            nodes.find((n) => n.id === target),
          );
    const resolvedSourceHandle = sourceHandle || defaultSourceHandleForConnection(
      nodes.find((n) => n.id === source),
      nodes.find((n) => n.id === target),
      resolvedTargetHandle,
    );
    try {
      const dto = await createEdge({
        board_id: boardId,
        source_id: sourceId,
        target_id: targetId,
        source_handle: resolvedSourceHandle,
        target_handle: resolvedTargetHandle,
      });
      const edge = edgeFromDto(dto);
      if (!edge.sourceHandle) edge.sourceHandle = resolvedSourceHandle;
      if (!edge.targetHandle && resolvedTargetHandle) edge.targetHandle = resolvedTargetHandle;
      set((s) => ({ edges: [...s.edges, edge] }));
    } catch {
      // ignore
    }
  },

  async cloneNodeWithUpstream(rfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const src = nodes.find((n) => n.id === rfId);
    if (!src) return null;

    // Position the clone to the lower-right of the source so it doesn't
    // overlap. Title gets a " (variant)" suffix if not already present so
    // it's easy to tell apart at a glance.
    const offset = { x: 60, y: 60 };
    const newPos = {
      x: Math.round(src.position.x + offset.x),
      y: Math.round(src.position.y + offset.y),
    };
    const baseTitle = src.data.title ?? TYPE_TITLE[src.data.type];
    const newTitle = baseTitle.endsWith("(variant)")
      ? baseTitle
      : `${baseTitle} (variant)`;

    let nodeDto;
    try {
      nodeDto = await createNode({
        board_id: boardId,
        type: src.data.type,
        x: newPos.x,
        y: newPos.y,
        data: { title: newTitle },
      });
    } catch {
      return null;
    }

    const newNode: FlowNode = {
      id: String(nodeDto.id),
      type: nodeDto.type,
      position: { x: nodeDto.x, y: nodeDto.y },
      data: {
        type: nodeDto.type,
        shortId: nodeDto.short_id,
        title: (nodeDto.data["title"] as string | undefined) ?? newTitle,
        status: nodeDto.status,
      },
    };
    set((s) => ({ nodes: [...s.nodes, newNode] }));

    // Replicate upstream edges: every (upstream ? src) becomes (upstream ? clone).
    const upstreamEdges = edges.filter((e) => e.target === rfId);
    for (const upstreamEdge of upstreamEdges) {
      const sourceId = parseInt(upstreamEdge.source, 10);
      if (isNaN(sourceId)) continue;
      try {
        const eDto = await createEdge({
          board_id: boardId,
          source_id: sourceId,
          target_id: nodeDto.id,
          source_handle: upstreamEdge.sourceHandle ?? "source",
          target_handle: upstreamEdge.targetHandle ?? defaultTargetHandleForConnection(
            nodes.find((n) => n.id === upstreamEdge.source),
            newNode,
          ),
        });
        const newEdge = edgeFromDto(eDto);
        set((s) => ({ edges: [...s.edges, newEdge] }));
      } catch {
        // best-effort ï¿½ partial edge replication still useful
      }
    }
    return newNode.id;
  },

  // -- Group operations ----------------------------------------------
  async groupNodes(rfIds) {
    const { boardId, nodes } = get();
    if (boardId === null || rfIds.length === 0) return null;

    // Validate selection: every node must exist, must be at the board
    // root (no nested groups), and must not itself be a group.
    const selected = rfIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is FlowNode => Boolean(n));
    if (selected.length === 0) return null;
    if (selected.some((n) => n.parentId !== undefined)) return null;
    if (selected.some((n) => n.data.type === "group")) return null;

    // Compute bounding box from React Flow node positions. We use the
    // persisted `nodeWidth` (or the default per-type width) for x extent
    // because `n.measured` is async-populated and undefined right after
    // a fresh load. Height defaults to 200 as a reasonable lower bound
    // ï¿½ the resulting box gets a generous bottom padding so labels and
    // toolbars stay inside the frame.
    // Uniform breathing room around every child. The 40px gap is
    // generous enough to leave a clearly clickable margin between
    // the frame border and the outermost child node, even after the
    // header bar is overlaid on top.
    const GROUP_PADDING = 40;
    const minX = Math.min(...selected.map((n) => n.position.x));
    const minY = Math.min(...selected.map((n) => n.position.y));
    const maxX = Math.max(
      ...selected.map((n) => n.position.x + (n.measured?.width ?? n.data.nodeWidth ?? 280)),
    );
    const maxY = Math.max(
      ...selected.map((n) => n.position.y + (n.measured?.height ?? 200)),
    );
    const groupX = Math.round(minX - GROUP_PADDING);
    const groupY = Math.round(minY - GROUP_PADDING);
    const groupW = Math.round(maxX - minX + GROUP_PADDING * 2);
    const groupH = Math.round(maxY - minY + GROUP_PADDING * 2);

    let response;
    try {
      response = await apiGroupNodes({
        board_id: boardId,
        child_ids: selected.map((n) => parseInt(n.id, 10)).filter((n) => !isNaN(n)),
        child_positions: selected
          .map((n) => ({ id: parseInt(n.id, 10), x: Math.round(n.position.x), y: Math.round(n.position.y) }))
          .filter((p) => !isNaN(p.id)),
        title: "Group",
        x: groupX,
        y: groupY,
        w: groupW,
        h: groupH,
      });
    } catch {
      return null;
    }

    const groupRfId = String(response.group.id);
    const groupNode: FlowNode = {
      ...nodeFromDto(response.group),
      // Groups sit at z-index -1 so edges and child nodes always
      // render on top of the frame background.
      zIndex: -1,
    };
    // Backend rewrote children with relative coords; mirror locally so
    // the React Flow render matches the persisted state without waiting
    // for a full board refresh.
    const childUpdates = new Map<string, FlowNode>();
    for (const child of response.children) {
      const existingChild = nodes.find((n) => n.id === String(child.id));
      const mapped = nodeFromDto(child, existingChild?.data);
      childUpdates.set(String(child.id), {
        ...(existingChild ?? {}),
        ...mapped,
        data: { ...(existingChild?.data ?? {}), ...mapped.data },
        // Explicit extent + draggable so RF knows the child is
        // constrained to its parent frame from the first render.
        extent: "parent" as const,
        draggable: !(groupNode.data.locked ?? false),
        // Children sit above the group frame so their handles are
        // never obscured by the group background.
        zIndex: 1,
      });
    }
    set((s) => {
      // React Flow requires parents to appear BEFORE their children in
      // the array; place the new group at the front of the list and
      // splice updated children right after it.
      const others = s.nodes.filter((n) => !childUpdates.has(n.id));
      const updatedChildren = s.nodes
        .filter((n) => childUpdates.has(n.id))
        .map((n) => ({ ...n, ...childUpdates.get(n.id)!, selected: false }));
      return {
        nodes: [...others, groupNode, ...updatedChildren],
      };
    });
    // Ask React Flow to recalculate handle positions for every child
    // now that their coordinate space has changed (relative to parent).
    flushNodeInternals([groupRfId, ...Array.from(childUpdates.keys())]);
    return groupRfId;
  },

  async ungroupNodes(groupRfId) {
    const groupId = parseInt(groupRfId, 10);
    if (isNaN(groupId)) return;
    let response;
    try {
      response = await apiUngroupNodes(groupId);
    } catch {
      return;
    }
    const childUpdates = new Map<string, FlowNode>();
    for (const child of response.children) {
      const existingChild = get().nodes.find((n) => n.id === String(child.id));
      const mapped = nodeFromDto(child, existingChild?.data);
      childUpdates.set(String(child.id), {
        ...(existingChild ?? {}),
        ...mapped,
        data: { ...(existingChild?.data ?? {}), ...mapped.data },
        // Detached - drop parent-extent + restore default draggable
        // so the freed children behave like normal root nodes.
        parentId: undefined,
        extent: undefined,
        draggable: undefined,
        selectable: undefined,
        connectable: undefined,
        zIndex: undefined,
      });
    }
    set((s) => ({
      nodes: s.nodes
        .filter((n) => n.id !== groupRfId)
        .map((n) => (childUpdates.has(n.id) ? { ...n, ...childUpdates.get(n.id)! } : n)),
    }));
    flushNodeInternals(Array.from(childUpdates.keys()));
  },

  async updateGroupColor(groupRfId, color) {
    const dbId = parseInt(groupRfId, 10);
    if (isNaN(dbId)) return;
    // Optimistic local update first so the palette feels instant.
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === groupRfId ? { ...n, data: { ...n.data, groupColor: color } } : n,
      ),
    }));
    try {
      await patchNode(dbId, { data: { groupColor: color } });
    } catch {
      // surface silently ï¿½ local state already reflects the choice
    }
  },

  async toggleGroupLock(groupRfId) {
    const { nodes } = get();
    const group = nodes.find((n) => n.id === groupRfId);
    if (!group) return;
    const nextLocked = !(group.data.locked ?? false);
    const childIds = nodes.filter((n) => n.parentId === groupRfId).map((n) => n.id);
    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id === groupRfId) {
          // Group itself: keep selectable so the user can still pick
          // it and toggle the lock back off via the toolbar.
          return {
            ...n,
            draggable: nextLocked ? false : undefined,
            data: { ...n.data, locked: nextLocked },
          };
        }
        if (childIds.includes(n.id)) {
          // Cascade: every interactive flag follows the parent so
          // children are fully frozen (no drag, no click-select,
          // no edge dragging out of their handles).
          return {
            ...n,
            draggable: nextLocked ? false : undefined,
            selectable: nextLocked ? false : undefined,
            connectable: nextLocked ? false : undefined,
          };
        }
        return n;
      }),
    }));
    const dbId = parseInt(groupRfId, 10);
    if (!isNaN(dbId)) {
      try {
        await patchNode(dbId, { data: { locked: nextLocked } });
      } catch {
        // ignore ï¿½ local state already reflects the toggle
      }
    }
  },

  async renameGroup(groupRfId, title) {
    const trimmed = title.trim() || "Group";
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === groupRfId ? { ...n, data: { ...n.data, title: trimmed } } : n,
      ),
    }));
    const dbId = parseInt(groupRfId, 10);
    if (!isNaN(dbId)) {
      try {
        await patchNode(dbId, { data: { title: trimmed } });
      } catch {
        // ignore
      }
    }
  },

  async duplicateGroup(groupRfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const group = nodes.find((n) => n.id === groupRfId);
    if (!group || group.data.type !== "group") return null;
    const children = nodes.filter((n) => n.parentId === groupRfId);

    const offset = { x: 60, y: 60 };
    // Carry the original group's dimensions through the clone so
    // the duplicate frame surrounds its child copies with the same
    // breathing room rather than collapsing back to the default
    // 240x160 fallback.
    const groupStyle = (group.style ?? {}) as { width?: number; height?: number };
    const cloneW = group.measured?.width ?? groupStyle.width ?? 320;
    const cloneH = group.measured?.height ?? groupStyle.height ?? 200;
    let groupDto;
    try {
      groupDto = await createNode({
        board_id: boardId,
        type: "group",
        x: Math.round(group.position.x + offset.x),
        y: Math.round(group.position.y + offset.y),
        w: cloneW,
        h: cloneH,
        data: {
          title: `${group.data.title ?? "Group"} (copy)`,
          groupColor: group.data.groupColor,
          locked: false,
        },
      });
    } catch {
      return null;
    }

    // Map old child rfId -> new child rfId so we can replicate any
    // edges that ran entirely between siblings inside the group.
    const childIdMap = new Map<string, string>();
    const newChildNodes: FlowNode[] = [];
    for (const child of children) {
      try {
        const childDto = await createNode({
          board_id: boardId,
          type: child.data.type,
          x: Math.round(child.position.x),
          y: Math.round(child.position.y),
          parent_id: groupDto.id,
          data: { ...child.data, locked: false },
        });
        const newChild = nodeFromDto(childDto);
        newChildNodes.push(newChild);
        childIdMap.set(child.id, newChild.id);
      } catch {
        // best-effort ï¿½ keep going so we at least get a partial copy
      }
    }

    // Replicate edges whose BOTH endpoints landed inside the group.
    const internalEdges = edges.filter(
      (e) => childIdMap.has(e.source) && childIdMap.has(e.target),
    );
    const newEdges: Edge[] = [];
    for (const e of internalEdges) {
      const newSource = childIdMap.get(e.source)!;
      const newTarget = childIdMap.get(e.target)!;
      try {
        const eDto = await createEdge({
          board_id: boardId,
          source_id: parseInt(newSource, 10),
          target_id: parseInt(newTarget, 10),
          source_handle: e.sourceHandle ?? "source",
          target_handle: e.targetHandle ?? defaultTargetHandleForConnection(
            newChildNodes.find((n) => n.id === newSource),
            newChildNodes.find((n) => n.id === newTarget),
          ),
        });
        newEdges.push(edgeFromDto(eDto));
      } catch {
        // ignore individual edge failures
      }
    }

    const newGroupNode = nodeFromDto(groupDto);
    set((s) => ({
      nodes: [...s.nodes, newGroupNode, ...newChildNodes],
      edges: [...s.edges, ...newEdges],
    }));
    return newGroupNode.id;
  },

  async persistGroupSize(groupRfId, width, height) {
    const dbId = parseInt(groupRfId, 10);
    if (isNaN(dbId)) return;
    const w = Math.round(width);
    const h = Math.round(height);
    // Optimistic local update first - keeps the next paint anchored
    // to the size React Flow already showed during the drag.
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === groupRfId
          ? { ...n, style: { ...(n.style ?? {}), width: w, height: h } }
          : n,
      ),
    }));
    try {
      await patchNode(dbId, { w, h });
    } catch {
      // ignore - local state still reflects the resize
    }
  },

  async reparentNode(nodeRfId, parentRfId, absX, absY) {
    const { nodes } = get();
    const node = nodes.find((n) => n.id === nodeRfId);
    if (!node) return;

    const dbId = parseInt(nodeRfId, 10);
    if (isNaN(dbId)) return;

    let targetX = absX;
    let targetY = absY;
    let parentIdVal: number | null = null;
    let groupExpanded = false;
    let groupPatchPromise: Promise<any> | null = null;
    const otherChildrenPatches: Promise<any>[] = [];

    if (parentRfId !== undefined) {
      const parent = nodes.find((n) => n.id === parentRfId);
      if (parent) {
        parentIdVal = parseInt(parentRfId, 10);
        if (isNaN(parentIdVal)) return;

        // Current group info
        const gX = parent.position.x;
        const gY = parent.position.y;
        const groupStyle = (parent.style ?? {}) as { width?: number; height?: number };
        const gW = parent.measured?.width ?? groupStyle.width ?? 320;
        const gH = parent.measured?.height ?? groupStyle.height ?? 200;

        // Child node size
        const nodeStyle = (node.style ?? {}) as { width?: number; height?: number };
        const nodeW = node.measured?.width ?? nodeStyle.width ?? node.data.nodeWidth ?? 260;
        const nodeH = node.measured?.height ?? nodeStyle.height ?? 200;

        // Desired new boundaries (with 40px padding)
        const PADDING = 40;
        const newGX = Math.min(gX, absX - PADDING);
        const newGY = Math.min(gY, absY - PADDING);
        const newGRight = Math.max(gX + gW, absX + nodeW + PADDING);
        const newGBottom = Math.max(gY + gH, absY + nodeH + PADDING);
        const newGW = newGRight - newGX;
        const newGH = newGBottom - newGY;

        const dx = gX - newGX;
        const dy = gY - newGY;

        targetX = absX - newGX;
        targetY = absY - newGY;

        const sizeChanged = newGW !== gW || newGH !== gH || dx !== 0 || dy !== 0;

        if (sizeChanged) {
          groupExpanded = true;
          // Optimistically update other children relative coordinates and group position/size
          set((s) => {
            const updated = s.nodes.map((n) => {
              if (n.id === parentRfId) {
                // Update parent group position and style size
                return {
                  ...n,
                  position: { x: newGX, y: newGY },
                  style: { ...(n.style ?? {}), width: newGW, height: newGH },
                };
              }
              if (n.parentId === parentRfId && n.id !== nodeRfId) {
                // Shift existing children
                return {
                  ...n,
                  position: { x: n.position.x + dx, y: n.position.y + dy },
                };
              }
              if (n.id === nodeRfId) {
                // Update newly parented child
                return {
                  ...n,
                  parentId: parentRfId,
                  extent: "parent" as const,
                  position: { x: targetX, y: targetY },
                  zIndex: 1,
                };
              }
              return n;
            });
            return { nodes: sortNodesParentFirst(updated) };
          });

          // Create background patch promises for group size/position
          groupPatchPromise = (async () => {
            try {
              await patchNode(parentIdVal!, {
                x: Math.round(newGX),
                y: Math.round(newGY),
                w: Math.round(newGW),
                h: Math.round(newGH),
              });
            } catch (err) {
              console.error("Failed to patch group dimensions:", err);
            }
          })();

          // Create background patch promises for other shifted children
          const otherChildren = nodes.filter((n) => n.parentId === parentRfId && n.id !== nodeRfId);
          for (const c of otherChildren) {
            const cId = parseInt(c.id, 10);
            if (!isNaN(cId)) {
              otherChildrenPatches.push(
                patchNode(cId, {
                  x: Math.round(c.position.x + dx),
                  y: Math.round(c.position.y + dy),
                }).catch((err) => {
                  console.error("Failed to patch shifted child position:", err);
                })
              );
            }
          }
        } else {
          // No group expansion needed
          targetX = absX - gX;
          targetY = absY - gY;
        }
      }
    }

    if (!groupExpanded) {
      set((s) => {
        const updated = s.nodes.map((n) => {
          if (n.id === nodeRfId) {
            return {
              ...n,
              parentId: parentRfId,
              extent: parentRfId !== undefined ? ("parent" as const) : undefined,
              position: { x: targetX, y: targetY },
              // Detached nodes must return to the normal node layer
              // above edges; grouped children stay there as well.
              zIndex: 1,
            };
          }
          return n;
        });
        return { nodes: sortNodesParentFirst(updated) };
      });
    }

    // React Flow coordinate change invalidates handle caches, so we flush internals
    flushNodeInternals([nodeRfId]);

    // Send PATCH for the target node to backend in the background
    const nodePatchPromise = (async () => {
      try {
        await patchNode(dbId, {
          parent_id: parentIdVal,
          x: Math.round(targetX),
          y: Math.round(targetY),
        });
      } catch (err) {
        console.error("Failed to reparent node:", err);
        // Revert in case of error
        await get().refreshBoardState();
      }
    })();

    // Run all background promises asynchronously
    void Promise.all([
      ...(groupPatchPromise ? [groupPatchPromise] : []),
      ...otherChildrenPatches,
      nodePatchPromise,
    ]);
  },

  async deleteGroupCascade(groupRfId) {
    const dbId = parseInt(groupRfId, 10);
    if (isNaN(dbId)) return;
    try {
      await deleteNode(dbId);
    } catch {
      return;
    }
    set((s) => {
      const removed = new Set<string>([groupRfId]);
      for (const n of s.nodes) {
        if (n.parentId === groupRfId) removed.add(n.id);
      }
      return {
        nodes: s.nodes.filter((n) => !removed.has(n.id)),
        edges: s.edges.filter(
          (e) => !removed.has(e.source) && !removed.has(e.target),
        ),
      };
    });
  },

  async deleteEdgeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    try {
      await deleteEdge(dbId);
      set((s) => ({ edges: s.edges.filter((e) => e.id !== rfId) }));
    } catch {
      // ignore
    }
  },

  updateNodeData: (rfId, partial) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === rfId ? { ...n, data: { ...n.data, ...partial } } : n,
      ),
    })),
  updateEdgeData: (edgeId, partial) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...(e.data ?? {}), ...partial } }
          : e,
      ),
    })),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearError: () => set({ error: null }),
}));

if (typeof window !== "undefined") {
  (window as any).useBoardStore = useBoardStore;
}

