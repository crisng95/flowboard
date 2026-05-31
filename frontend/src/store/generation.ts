import { create } from "zustand";
import type { Edge } from "@xyflow/react";
import {
  ensureBoardProject,
  createRequest,
  createNode,
  createEdge,
  getRequest,
  patchNode,
  type RequestDTO,
} from "../api/client";
import { useBoardStore, type FlowNode } from "./board";
import { supabase } from "../cloud/supabase";
import { normalizeImageModelKey, useSettingsStore, type ImageModelKey } from "./settings";

type PollEntry = { requestId: number; timerId: ReturnType<typeof setTimeout> | null };

/**
 * commitNodeData — pair an in-memory node-data update with a best-effort
 * backend persist so the two don't silently diverge. Use this for state that
 * MUST survive a page reload (notably terminal error/timeout states, which
 * the original poll loops only wrote in-memory and thus lost on reload).
 *
 * The persist is fire-and-forget (the in-memory store is the source of truth
 * for the live session); failures are logged rather than swallowed silently so
 * divergence is at least observable in the console.
 */
function commitNodeData(rfId: string, patch: Record<string, unknown>): void {
  useBoardStore.getState().updateNodeData(rfId, patch);
  const dbId = parseInt(rfId, 10);
  if (Number.isNaN(dbId)) return;
  patchNode(dbId, { data: patch }).catch((err) => {
    console.warn(`[Flowboard] failed to persist node data for ${rfId}`, err);
  });
}

// Shared poll-loop constants/behaviour. The poll interval and network-retry
// cap used to be duplicated (with subtly different values + a zombie loop in
// refineImage). Centralising them keeps every poller cancellable and bounded.
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_NETWORK_RETRIES = 8;

type PollStoreApi = {
  get: () => GenerationState;
  set: (
    update: Partial<GenerationState> | ((s: GenerationState) => Partial<GenerationState>),
  ) => void;
};

/**
 * pollRequest — one cancellable, retry-capped poll loop shared by the
 * edit-derived (Part/Variant) and refine flows. Fixes the previous
 * refineImage "zombie" loop (no cancel guard, no retry cap) and the
 * edit-derived loop that mapped `canceled` → error instead of idle.
 *
 * Lifecycle / guarantees:
 *   - registers `active[rfId]` before the first tick and clears it on any
 *     terminal outcome (so cancelGeneration / node deletion stops it);
 *   - every tick first checks `active[rfId]` and bails if the entry was
 *     removed (cancel/delete) — no resurrection;
 *   - caps consecutive network errors at POLL_MAX_NETWORK_RETRIES;
 *   - `done` is delegated to `onDone(req)`; `failed`/`timeout` → onError;
 *     `canceled` → node idle (NOT error); `queued`/`running` → keep polling.
 *
 * `onDone` owns clearing `active[rfId]` for the success path (callers persist
 * node-specific result shapes there). All non-success terminal paths clear it
 * here.
 */
function pollRequest(
  store: PollStoreApi,
  rfId: string,
  requestId: number,
  handlers: {
    onDone: (req: RequestDTO) => void;
    onError: (errMsg: string) => void;
    firstDelayMs?: number;
  },
): void {
  const { get, set } = store;
  let networkRetries = 0;

  const clearActive = () =>
    set((s) => {
      const next = { ...s.active };
      delete next[rfId];
      return { active: next };
    });

  const reschedule = (delay: number) => {
    const timerId = setTimeout(tick, delay);
    set((s) => ({ active: { ...s.active, [rfId]: { requestId, timerId } } }));
  };

  async function tick() {
    // Cancelled (or node deleted) while we slept → stop, don't resurrect.
    if (get().active[rfId] === undefined) return;
    try {
      const req = await getRequest(requestId);
      networkRetries = 0;
      if (req.status === "running" || req.status === "queued") {
        useBoardStore.getState().updateNodeData(rfId, { status: "running" });
        reschedule(POLL_INTERVAL_MS);
      } else if (req.status === "done") {
        handlers.onDone(req);
      } else if (req.status === "canceled") {
        // User cancel — clear in-flight state, leave the node idle (NOT error).
        commitNodeData(rfId, { status: "idle" });
        clearActive();
      } else {
        // failed | timeout
        const errMsg =
          req.status === "timeout"
            ? `Timed out after 5 minutes (${req.error ?? "video_timeout"})`
            : (req.error ?? "generation_failed");
        commitNodeData(rfId, { status: "error", error: errMsg });
        handlers.onError(errMsg);
        clearActive();
      }
    } catch (err) {
      networkRetries += 1;
      if (networkRetries >= POLL_MAX_NETWORK_RETRIES) {
        const msg = err instanceof Error ? err.message : "network error";
        commitNodeData(rfId, { status: "error", error: msg });
        handlers.onError(msg);
        clearActive();
        return;
      }
      reschedule(POLL_INTERVAL_MS);
    }
  }

  // Register active BEFORE the first tick so the guard sees a live entry.
  set((s) => ({ active: { ...s.active, [rfId]: { requestId, timerId: null } } }));
  reschedule(handlers.firstDelayMs ?? POLL_INTERVAL_MS);
}

interface GenerationState {
  active: Record<string, PollEntry>;
  openDialog: { rfId: string | null; prompt: string };
  openViewer: { rfId: string | null; idx: number };
  projectId: string | null;
  // Auto-detected from Flow's createProject response — used as the
  // default tier for every dispatch so the UI no longer needs to ask.
  // Null until the first successful project bootstrap.
  paygateTier: "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null;
  error: string | null;

  openGenerationDialog(rfId: string, prompt: string): void;
  closeGenerationDialog(): void;
  openResultViewer(rfId: string, idx?: number): void;
  closeResultViewer(): void;

  ensureProjectId(): Promise<string | null>;

  dispatchGeneration(
    rfId: string,
    opts: {
      prompt: string;
      aspectRatio?: string;
      paygateTier?: string;
      kind?: "image" | "video";
      sourceMediaId?: string;
      // Multi-source overrides:
      //   - i2v batch: upstream image has N variants ? generate one video per variant.
      //     Backend sends N items in batchAsyncGenerate so all are dispatched together.
      //   - Paired dispatch (Mode A): explicit ref_media_ids for one slot in a
      //     prompt-image zip — bypasses collectUpstreamRefMediaIds so each new
      //     node uses exactly its assigned image rather than all upstream images.
      sourceMediaIds?: string[];
      variantCount?: number;
      imageModel?: ImageModelKey;
      // Per-variant prompts. When provided, each variant uses its own
      // prompt — required for batch auto-prompt to keep poses distinct
      // across the 4 generated images.
      prompts?: string[];
      skipSpawningNodes?: boolean;
    },
  ): Promise<void>;

  refineImage(
    rfId: string,
    opts: { prompt: string; refMediaIds?: string[]; aspectRatio?: string },
  ): Promise<void>;

  // Variant (Concepta) — alternate states of an upstream Concept /
  // Part / Multi-view. Backend fans out as N×1 edit_image with the
  // axis-specific prompt template + user-supplied instruction.
  dispatchVariant(
    rfId: string,
    opts: {
      axisKey: string; // "color" | "material" | "damage" | …
      instruction: string; // free-text appended to the axis template
      variantCount?: number; // 1..4; default 1
      aspectRatio?: string;
      paygateTier?: string;
    },
  ): Promise<void>;

  runNodeGraph(rfId: string): Promise<void>;

  cancelGeneration(rfId: string): void;
  clearError(): void;
}

const IMAGE_NODE_ASPECT_TO_FLOW = {
  "1:1": "IMAGE_ASPECT_RATIO_SQUARE",
  "3:4": "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR",
  "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE",
  "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
  "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT",
} as const;

const VIDEO_NODE_ASPECT_TO_FLOW = {
  "16:9": "VIDEO_ASPECT_RATIO_LANDSCAPE",
  "9:16": "VIDEO_ASPECT_RATIO_PORTRAIT",
} as const;

const VIDEO_CAMERA_INSTRUCTIONS = {
  static:
    "Camera: locked-off static frame, no zoom and no pan. Keep the full subject and any product clearly visible in the frame for the entire clip. Background and crop must not change.",
  dynamic:
    "Camera: subtle dolly or pan is allowed if it fits the scene, but subject motion is the main story.",
} as const;

const VARIANT_MODE_TO_AXIS_KEY: Record<string, string> = {
  Age: "age",
  Custom: "custom",
  Demographics: "demographics",
  Expressions: "expressions",
  Storyboard: "storyboard",
  Reframe: "reframe",
};

function gridToVariantCount(grid: string | undefined): number {
  if (!grid) return 9;
  const parts = grid.split("x");
  if (parts.length !== 2) return 9;
  const rows = parseInt(parts[0], 10);
  const cols = parseInt(parts[1], 10);
  if (Number.isNaN(rows) || Number.isNaN(cols)) return 9;
  return Math.max(1, rows * cols);
}

function primaryNodeType(node: { type?: string; data?: { type?: string } }): string | undefined {
  return node.data?.type ?? node.type;
}

function hasRenderableMedia(node: { data: Record<string, unknown> }): boolean {
  if (typeof node.data.mediaId === "string" && node.data.mediaId.length > 0) return true;
  if (Array.isArray(node.data.mediaIds)) {
    return node.data.mediaIds.some((mediaId) => typeof mediaId === "string" && mediaId.length > 0);
  }
  return false;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeListItemRecord(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  const kind = raw.kind === "video" || raw.kind === "text" || raw.kind === "image"
    ? raw.kind
    : cleanText(raw.text) && !cleanText(raw.mediaId) && !cleanText(raw.mediaUrl) && !cleanText(raw.imageUrl)
      ? "text"
      : cleanText(raw.mime)?.startsWith("video/")
        ? "video"
        : "image";

  return {
    ...raw,
    id: cleanText(raw.id) ?? cleanText(raw.mediaId) ?? cleanText(raw.mediaUrl) ?? `list-item-${index + 1}`,
    kind,
    title:
      cleanText(raw.title)
      ?? (kind === "text" ? `Text ${index + 1}` : kind === "video" ? `Video ${index + 1}` : `Image ${index + 1}`),
    text: cleanText(raw.text) ?? null,
    mediaId: cleanText(raw.mediaId) ?? null,
    flowMediaId: cleanText(raw.flowMediaId) ?? cleanText(raw.mediaId) ?? null,
    mediaUrl: cleanText(raw.mediaUrl) ?? cleanText(raw.imageUrl) ?? null,
    imageUrl: cleanText(raw.imageUrl) ?? null,
    mime: cleanText(raw.mime) ?? null,
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
    duration: typeof raw.duration === "number" ? raw.duration : null,
  };
}

function listItemSignature(item: Record<string, unknown>): string {
  const kind = cleanText(item.kind) ?? "image";
  if (kind === "text") {
    return `text:${cleanText(item.text) ?? cleanText(item.title) ?? cleanText(item.id) ?? ""}`;
  }
  const ref = cleanText(item.flowMediaId) ?? cleanText(item.mediaId) ?? cleanText(item.mediaUrl) ?? cleanText(item.imageUrl) ?? cleanText(item.id) ?? "";
  return `${kind}:${ref}`;
}

function dedupeListItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const next: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const signature = listItemSignature(item);
    if (seen.has(signature)) continue;
    seen.add(signature);
    next.push(item);
  }
  return next;
}

function collectListItemsFromNode(node: { id: string; data: Record<string, unknown> }): Array<Record<string, unknown>> {
  const rawItems = Array.isArray(node.data.listItems) ? node.data.listItems : [];
  if (rawItems.length > 0) {
    return dedupeListItems(rawItems
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item, index) => normalizeListItemRecord(item, index)));
  }

  const mediaIds = Array.isArray(node.data.mediaIds)
    ? node.data.mediaIds.filter((m): m is string => typeof m === "string" && m.length > 0)
    : cleanText(node.data.mediaId)
      ? [String(node.data.mediaId)]
      : [];
  const flowMediaIds = Array.isArray(node.data.flowMediaIds)
    ? node.data.flowMediaIds.filter((m): m is string => typeof m === "string" && m.length > 0)
    : cleanText(node.data.flowMediaId)
      ? [String(node.data.flowMediaId)]
      : [];
  const sourceType = primaryNodeType(node);

  return mediaIds.map((mediaId, index) => ({
    id: mediaId,
    kind: sourceType === "video" ? "video" : "image",
    title: cleanText(node.data.title) ?? `${sourceType === "video" ? "Video" : "Image"} ${index + 1}`,
    mediaId,
    flowMediaId: flowMediaIds[index] ?? mediaId,
    mime: cleanText(node.data.mime),
    width: typeof node.data.imageWidth === "number" ? node.data.imageWidth : undefined,
    height: typeof node.data.imageHeight === "number" ? node.data.imageHeight : undefined,
  }));
}

export function collectSelectedListMediaItems(node: { id: string; data: Record<string, unknown> }): Array<Record<string, unknown>> {
  const listItems = collectListItemsFromNode(node);
  const mediaItems = listItems.filter((item) => item.kind === "image" || item.kind === "video");
  const selectedIndexes = Array.isArray(node.data.listSelectedIndexes)
    ? node.data.listSelectedIndexes.map(Number).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  if (selectedIndexes.length > 0) {
    return listItems
      .filter((_, index) => selectedIndexes.includes(index))
      .filter((item) => item.kind === "image" || item.kind === "video");
  }

  const narrowedFlowMediaIds = Array.isArray(node.data.flowMediaIds)
    ? node.data.flowMediaIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const narrowedMediaIds = Array.isArray(node.data.mediaIds)
    ? node.data.mediaIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const looksNarrowed = (
    (narrowedFlowMediaIds.length > 0 && narrowedFlowMediaIds.length < mediaItems.length)
    || (narrowedMediaIds.length > 0 && narrowedMediaIds.length < mediaItems.length)
  );

  if (looksNarrowed) {
    const narrowedKeys = new Set<string>([
      ...narrowedFlowMediaIds,
      ...narrowedMediaIds,
    ]);
    const narrowedItems = mediaItems.filter((item) => {
      const flowId = typeof item.flowMediaId === "string" ? item.flowMediaId : null;
      const mediaId = typeof item.mediaId === "string" ? item.mediaId : null;
      return (flowId && narrowedKeys.has(flowId)) || (mediaId && narrowedKeys.has(mediaId));
    });
    if (narrowedItems.length > 0) {
      return narrowedItems;
    }
  }

  return mediaItems;
}

/**
 * Collect the text prompts from a list node, honoring `listSelectedIndexes`
 * when the user has narrowed the selection. A Prompt list keeps its text in
 * `listItems[]` (kind === "text"); `data.prompt` stays empty for lists, which
 * is why generator nodes that read `data.prompt` directly see nothing. Use
 * this so node UI and the dispatch engine agree on the exact prompts (and the
 * exact count shown by the batch badge).
 */
export function collectSelectedListTextPrompts(node: { id: string; data: Record<string, unknown> }): string[] {
  const listItems = collectListItemsFromNode(node);
  const selectedIndexes = Array.isArray(node.data.listSelectedIndexes)
    ? node.data.listSelectedIndexes.map(Number).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const source = selectedIndexes.length > 0
    ? listItems.filter((_, index) => selectedIndexes.includes(index))
    : listItems;
  return source
    .filter((item) => item.kind === "text")
    .map((item) => String(item.text || item.title || "").trim())
    .filter(Boolean);
}

function isMediaSourceType(type: string | undefined): boolean {
  return type === "reference" || type === "variant" || type === "video" || type === "upload" || type === "list" || type === "add_reference";
}

function isRunnableNodeType(type: string | undefined): boolean {
  return type === "reference" || type === "variant" || type === "video" || type === "list";
}

function isTextEdge(edge: { targetHandle?: string | null; source: string; target: string }, board: { nodes: any[]; edges: any[] }): boolean {
  if (edge.targetHandle === "target-text") return true;
  const srcNode = board.nodes.find((n) => n.id === edge.source);
  if (!srcNode) return false;
  const srcType = srcNode.data?.type ?? srcNode.type;
  if (srcType === "text") return true;
  if (srcType === "list") {
    const listItems = Array.isArray(srcNode.data?.listItems) ? srcNode.data.listItems : [];
    const isTextList = listItems.length > 0 && listItems[0]?.kind === "text";
    const hasTextIncoming = board.edges.some((e) => e.target === srcNode.id && e.targetHandle === "target-text");
    if (isTextList || hasTextIncoming) return true;
  }
  return false;
}

function getUpstreamTextPrompt(targetRfId: string): string {
  const board = useBoardStore.getState();
  const textEdge = board.edges.find((edge) => {
    if (edge.target !== targetRfId) return false;
    return isTextEdge(edge as any, board);
  });
  if (!textEdge) return "";
  const sourceNode = board.nodes.find((node) => node.id === textEdge.source);
  if (!sourceNode) return "";
  if (sourceNode.data.type === "list") {
    const listItems = collectListItemsFromNode(sourceNode as any);
    return listItems
      .filter((item) => item.kind === "text")
      .map((item) => String(item.text || item.title || "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return ((sourceNode.data.prompt as string | undefined) ?? "").trim();
}

async function waitForNodeSettled(
  get: () => GenerationState,
  rfId: string,
): Promise<"done" | "error" | "idle"> {
  return new Promise((resolve) => {
    const check = () => {
      const node = useBoardStore.getState().nodes.find((entry) => entry.id === rfId);
      const status = (node?.data.status as string | undefined) ?? "idle";
      const active = get().active[rfId];
      if (active || status === "queued" || status === "running") {
        setTimeout(check, 250);
        return;
      }
      if (status === "done" || status === "partial") {
        resolve("done");
        return;
      }
      if (status === "error") {
        resolve("error");
        return;
      }
      resolve("idle");
    };
    check();
  });
}

// Walk the board to collect mediaIds of every upstream media-bearing node
// (character / image / visual_asset) feeding into this image-target node.
// All of these are passed to Flow as IMAGE_INPUT_TYPE_REFERENCE inputs so the
// new image is composed from them.
//
// Per-edge variant pinning: each edge from a multi-variant source
// remembers exactly WHICH variant feeds the downstream — stored on
// `edge.data.sourceVariantIdx`. Resolution rules per edge:
//   1. If the edge has a pinned `sourceVariantIdx` AND the source has
//      a `mediaIds[idx]` entry there ? use it.
//   2. Else if the source has an active `mediaId` ? use it
//      (single-variant case; or multi-variant where the user hasn't
//      pinned yet — variant 0 is the natural default).
//   3. Else if the source has a non-empty `mediaIds[]` ? use index 0.
// One ref per edge means one Flow API call regardless of how many
// variants the upstream has — the user picks which variant feeds
// which downstream by clicking the variant tile (Stage 2 UX).
// Source types that contribute media ids to a downstream Flow request.
// Exported so chip-preview components in `GenerationDialog` /
// `ResultViewer` can build their lists from the same source of truth
// as the dispatcher; otherwise the preview drifts (or, worse, hides
// refs that we actually ship).
export const REF_DISPATCH_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  "Storyboard",
  "upload",
  "reference",
  "add_reference",
  "list",
]);
const REF_SOURCE_TYPES = REF_DISPATCH_TYPES;

// Reference-tag classification mirrors the backend split in
// `flowboard/agent/flowboard/services/prompt_synth.py`. We keep the
// two sets in sync by hand because the frontend constants file
// (`src/constants/concept.ts`) doesn't tag each ref with its role
// directly, and copy-pasting the small set is cheaper than threading
// a shared schema through the build.
//
// When the upstream graph mixes structural and material refs, the
// material refs are demoted to text-only directives by the auto-
// prompt synthesiser. If we still ship their media ids to Flow, the
// image-gen vision encoder sees both images and treats the material
// ref as a second subject to composite. Skipping them on the wire
// leaves Flow with a single image input, which is what the burn-and-
// bake combination strategy in the system prompt assumes.
export const REF_STRUCTURAL_TAGS = new Set(["sketch", "pose", "blueprint"]);
export const REF_MATERIAL_TAGS = new Set(["texture", "material", "style", "lighting", "mood"]);

// Returns true when this target's upstream contains at least one
// strict structural `add_reference` (sketch / pose / blueprint).
// Mirrors the first pass in `collectUpstreamRefMediaIds` so callers
// can short-circuit the same way without duplicating the loop.
export function targetHasStructuralRef(targetRfId: string): boolean {
  const { nodes, edges } = useBoardStore.getState();
  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || src.data.type !== "add_reference") continue;
    const refType = typeof src.data.refType === "string" ? src.data.refType : null;
    if (refType && REF_STRUCTURAL_TAGS.has(refType)) return true;
  }
  return false;
}

// Predicate used by chip-preview components. Historically the
// dispatcher skipped material refs under a structural one (burn-and-
// bake), so the preview hid those chips. Now that Omni handles mixed
// refs natively (every upstream media id is forwarded as a positional
// `ref_image_N`), nothing is skipped ? so this predicate is a no-op.
// Kept as a stable export so existing call-sites keep compiling; the
// signature is retained even though `hasStructuralRef` is unused.
export function isMaterialRefDemoted(
  _src: { data: { type?: string; refType?: unknown } },
  _hasStructuralRef: boolean,
): boolean {
  return false;
}

export function resolveEdgeMediaSelection(targetRfId: string, edgeId: string): {
  mediaId: string | null;
  variantIdx: number | null;
  allVariants: string[];
} {
  const { nodes, edges } = useBoardStore.getState();
  const edge = edges.find((e) => e.id === edgeId && e.target === targetRfId);
  if (!edge) return { mediaId: null, variantIdx: null, allVariants: [] };
  const src = nodes.find((n) => n.id === edge.source);
  if (!src) return { mediaId: null, variantIdx: null, allVariants: [] };
  if (edge.sourceHandle === "source-text") {
    return { mediaId: null, variantIdx: null, allVariants: [] };
  }
  if (src.data.type === "video") {
    if (edge.sourceHandle === "source-start-image") {
      const directStart = typeof src.data.startImageMediaId === "string" ? src.data.startImageMediaId : null;
      if (directStart) {
        return { mediaId: directStart, variantIdx: null, allVariants: [directStart] };
      }
      const startEdge = edges.find((candidate) => candidate.target === src.id && candidate.targetHandle === "target-start-image");
      if (startEdge) {
        return resolveEdgeMediaSelection(src.id, startEdge.id);
      }
    }
    if (edge.sourceHandle === "source-end-image") {
      const directEnd = typeof src.data.endImageMediaId === "string" ? src.data.endImageMediaId : null;
      if (directEnd) {
        return { mediaId: directEnd, variantIdx: null, allVariants: [directEnd] };
      }
      const endEdge = edges.find((candidate) => candidate.target === src.id && candidate.targetHandle === "target-end-image");
      if (endEdge) {
        return resolveEdgeMediaSelection(src.id, endEdge.id);
      }
    }
  }

  let flowVariants = (Array.isArray(src.data.flowMediaIds) ? src.data.flowMediaIds : [])
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  let mediaIds = (Array.isArray(src.data.mediaIds) ? src.data.mediaIds : [])
    .filter((m): m is string => typeof m === "string" && m.length > 0);

  if (src.data.type === "list") {
    const selectedMediaItems = collectSelectedListMediaItems(src as { id: string; data: Record<string, unknown> });
    if (selectedMediaItems.length > 0) {
      flowVariants = selectedMediaItems
        .map((item) => (item.mediaUrl ?? item.imageUrl ?? item.mediaId ?? item.flowMediaId) as string)
        .filter((m) => typeof m === "string" && m.length > 0);
      mediaIds = selectedMediaItems
        .map((item) => item.mediaId as string)
        .filter((m) => typeof m === "string" && m.length > 0);
    }
  }

  const variants = (flowVariants.length > 0 ? flowVariants : mediaIds)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const pin = (edge.data?.sourceVariantIdx ?? null) as number | null;

  if (pin !== null && pin >= 0 && pin < variants.length) {
    return { mediaId: variants[pin], variantIdx: pin, allVariants: variants };
  }
  const primaryMediaId = src.data.type === "list" ? null : (
    (typeof src.data.flowMediaId === "string" && src.data.flowMediaId) ||
    (typeof src.data.mediaId === "string" && src.data.mediaId) ||
    null
  );
  if (primaryMediaId) {
    const idx = variants.indexOf(primaryMediaId);
    return {
      mediaId: primaryMediaId,
      variantIdx: idx >= 0 ? idx : null,
      allVariants: variants,
    };
  }
  if (variants.length > 0) {
    return { mediaId: variants[0], variantIdx: 0, allVariants: variants };
  }
  return { mediaId: null, variantIdx: null, allVariants: [] };
}

/**
 * Pure pairing logic for the Video-node batch fan-out. Extracted from
 * `runNodeDirect` so it can be unit/property tested in isolation (the
 * original inline version depends on board state, which is hard to test).
 *
 * Behaviour is intentionally identical to the previous inline code:
 *   - `zip`:   pairs by position, producing `min(P, M)` pairs where
 *              pair k = (prompts[k], refs[k]).
 *   - `cross`: nested loop with prompts on the outer axis and refs on the
 *              inner axis, producing `P * M` pairs where pair `i * M + j`
 *              = (prompts[i], refs[j]).
 *
 * The returned `prompts`/`refs` arrays are always equal length. Callers
 * apply any prompt post-processing (e.g. appending a camera instruction)
 * AFTER calling this — order of operations is preserved from the original.
 */
export function buildVideoBatchPairs(
  prompts: string[],
  refs: string[],
  mode: "zip" | "cross",
): { prompts: string[]; refs: string[] } {
  const finalPrompts: string[] = [];
  const finalRefs: string[] = [];

  if (mode === "zip") {
    const minLength = Math.min(prompts.length, refs.length);
    return {
      prompts: prompts.slice(0, minLength),
      refs: refs.slice(0, minLength),
    };
  }

  for (const p of prompts) {
    for (const r of refs) {
      finalPrompts.push(p);
      finalRefs.push(r);
    }
  }
  return { prompts: finalPrompts, refs: finalRefs };
}

/**
 * Shape of a single item in a List_Node's `data.listItems` for video results.
 * Kept compatible with `normalizeListItemRecord` (same field set) so a
 * placeholder/result item round-trips through normalization unchanged.
 *
 *   - `status: "pending"` → placeholder slot waiting for its render.
 *   - `status: "done"`    → a successfully rendered video.
 *   - `status: "error"`   → a failed slot (kept in place, `mediaId === null`).
 */
export type VideoListItem = {
  id: string;
  kind: "video";
  title: string;
  text: string | null;
  mediaId: string | null;
  flowMediaId: string | null;
  mediaUrl: string | null;
  imageUrl: string | null;
  mime: "video/mp4";
  width: number | null;
  height: number | null;
  duration: number | null;
  status: "pending" | "done" | "error";
  error?: string | null;
};

/**
 * Result of building the `data` patch for a Batch_Result_List. The `listItems`
 * array always has exactly `variantCount` entries (one per video slot).
 */
export type VideoResultListData = {
  listItems: VideoListItem[];
  listSelectedIndexes: number[];
  mediaIds: string[];
  flowMediaIds: string[];
  variantCount: number;
};

/**
 * Pure logic helper: build the placeholder `data` for a Batch_Result_List at
 * the moment Generate is pressed in batch mode, BEFORE any video has rendered.
 *
 * Returns exactly `count` placeholder slots (`status: "pending"`, no media)
 * that preserve order with the N prompts. The result fully replaces any prior
 * `listItems` when reusing an existing list (Req 6.2) — it never appends.
 *
 * Extracted from `spawnVideoResultList` so it can be property-tested without
 * touching the board store or React (mirrors `buildVideoBatchPairs`).
 */
export function buildPlaceholderListItems(
  count: number,
  titles: string[],
): VideoResultListData {
  const slotCount = Math.max(0, Math.trunc(count));
  const listItems: VideoListItem[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    listItems.push({
      id: `video-slot-${i}`,
      kind: "video",
      title: titles[i] ?? `Video ${i + 1}`,
      text: null,
      mediaId: null,
      flowMediaId: null,
      mediaUrl: null,
      imageUrl: null,
      mime: "video/mp4",
      width: null,
      height: null,
      duration: null,
      status: "pending",
    });
  }
  return {
    listItems,
    listSelectedIndexes: [],
    mediaIds: [],
    flowMediaIds: [],
    variantCount: slotCount,
  };
}

/**
 * Pure logic helper: turn the worker's positional result arrays into the
 * `data` patch for a Batch_Result_List once every video slot has resolved.
 *
 * The iteration is strictly positional over `mediaIds` — we NEVER pre-filter,
 * so `listItems[i]` always lines up with `prompts[i]` (Req 3.1, 3.2). A slot
 * is considered failed when `mediaIds[i]` is null/empty OR `slotErrors[i]` is
 * non-null; such slots stay in place as `status: "error"` items rather than
 * collapsing the list (Req 3.3, 3.4). The output therefore always has exactly
 * `mediaIds.length` entries with `variantCount === mediaIds.length`, so the
 * list is never empty when N ≥ 1 (Req 3.5, 3.6, 3.7). The returned
 * `mediaIds`/`flowMediaIds` arrays carry ONLY the successful slots for
 * downstream consumers / intake re-runs.
 *
 * Output depends solely on the positional contract, not on the video model,
 * so Veo and Omni Flash produce identical results for identical input
 * (Req 7.3). Extracted from the `dispatchGeneration` done-handler so it can be
 * property-tested in isolation (mirrors `buildVideoBatchPairs`).
 */
export function buildVideoResultListItems(input: {
  mediaIds: (string | null)[];
  flowMediaIds: (string | null)[];
  assetIds: (string | null)[];
  slotErrors: (string | null)[] | null;
  prompts: string[];
}): VideoResultListData {
  const { mediaIds, flowMediaIds, slotErrors } = input;
  const listItems: VideoListItem[] = [];
  const successMediaIds: string[] = [];
  const successFlowMediaIds: string[] = [];

  for (let i = 0; i < mediaIds.length; i += 1) {
    const title = `Video ${i + 1}`;
    const rawMediaId = mediaIds[i];
    const mediaId =
      typeof rawMediaId === "string" && rawMediaId.length > 0 ? rawMediaId : null;
    const rawFlowMediaId = flowMediaIds[i];
    const flowMediaId =
      typeof rawFlowMediaId === "string" && rawFlowMediaId.length > 0
        ? rawFlowMediaId
        : null;
    const slotError =
      slotErrors && typeof slotErrors[i] === "string" && slotErrors[i]!.length > 0
        ? slotErrors[i]
        : null;

    // A slot fails when it has no media OR the worker flagged it. Either way
    // we keep the index so downstream slots don't shift (Req 3.3).
    if (mediaId === null || slotError !== null) {
      listItems.push({
        id: `video-slot-${i}`,
        kind: "video",
        title,
        text: null,
        mediaId: null,
        flowMediaId: null,
        mediaUrl: null,
        imageUrl: null,
        mime: "video/mp4",
        width: null,
        height: null,
        duration: null,
        status: "error",
        error: slotError,
      });
      continue;
    }

    // Successful slot: unique id prefers the flow media id, then the media id,
    // then a positional fallback so dedupe/normalization never collapses two
    // distinct slots (Req 3.5).
    const id = flowMediaId ?? mediaId ?? `video-slot-${i}`;
    listItems.push({
      id,
      kind: "video",
      title,
      text: null,
      mediaId,
      flowMediaId: flowMediaId ?? mediaId,
      mediaUrl: mediaId,
      imageUrl: null,
      mime: "video/mp4",
      width: null,
      height: null,
      duration: null,
      status: "done",
    });
    successMediaIds.push(mediaId);
    successFlowMediaIds.push(flowMediaId ?? mediaId);
  }

  return {
    listItems,
    listSelectedIndexes: [],
    mediaIds: successMediaIds,
    flowMediaIds: successFlowMediaIds,
    variantCount: mediaIds.length,
  };
}

/**
 * Pure logic helper: find an existing Batch_Result_List that should be reused
 * for a fresh batch run, instead of spawning a duplicate (Req 6.1, 6.3).
 *
 * Scans `edges` for the connection a batch run creates — `source === videoRfId`
 * AND `sourceHandle === "source-video"` — whose `target` resolves to a node of
 * type `list`. Returns that list node's rfId on the first match, or `null` when
 * no such connection exists (so the caller creates a new list instead).
 *
 * The node type is read from `node.data.type` (the board model's canonical
 * field), falling back to ReactFlow's `node.type`, mirroring `primaryNodeType`.
 * Extracted from `spawnVideoResultList` so it can be property-tested without
 * touching the board store or React (mirrors `buildVideoBatchPairs`).
 */
export function findReusableVideoResultList(
  edges: Edge[],
  videoRfId: string,
  nodes: FlowNode[],
): string | null {
  for (const edge of edges) {
    if (edge.source !== videoRfId) continue;
    if (edge.sourceHandle !== "source-video") continue;
    const target = nodes.find((node) => node.id === edge.target);
    if (!target) continue;
    if (primaryNodeType(target) === "list") return target.id;
  }
  return null;
}

/**
 * Pure gating predicate: decide whether a Generate_Action should spawn a
 * Batch_Result_List for the video branch.
 *
 * This mirrors EXACTLY the `hasBatchInputs` condition used in the video branch
 * of `runNodeDirect` (`upstreamPrompts.length > 1 && startMediaIds.length > 1`)
 * and is the single source of truth for that decision. A batch run (N > 1)
 * requires BOTH more than one upstream prompt AND more than one start media id;
 * any single-input configuration (which yields N = 1) returns `false`, so no
 * list/edge is created and `batchResultListId` stays unset (Req 4.2, 4.3).
 *
 * Extracted so it can be property-tested without touching the board store or
 * React (mirrors `buildVideoBatchPairs`).
 */
export function shouldSpawnVideoResultList(
  upstreamPromptsLength: number,
  startMediaIdsLength: number,
): boolean {
  return upstreamPromptsLength > 1 && startMediaIdsLength > 1;
}

// Layout constants for the auto-spawned Batch_Result_List. The list is dropped
// just to the right of the Video_Node (whose default footprint is 620px wide)
// with a small gutter so the two cards don't overlap on the canvas (Req 2.3).
const VIDEO_NODE_DEFAULT_WIDTH = 620;
const VIDEO_RESULT_LIST_GAP = 80;

/**
 * I/O orchestration helper: create (or reuse) the Batch_Result_List for a batch
 * video run. Called from `runNodeDirect`'s `hasBatchInputs` branch IMMEDIATELY
 * BEFORE `dispatchGeneration`, when N (`count`) is already known.
 *
 * Returns the rfId of the Batch_Result_List so the done-handler knows where to
 * pour results. Throws when the list/edge cannot be created (no board, or a
 * failed `createNode`/`createEdge`) so the caller can surface an explicit error
 * and abort the dispatch (Req 2.7, 2.8).
 *
 * Behaviour (mirrors design "Components and Interfaces → (a)"):
 *   1. Read `boardId`/`nodes`/`edges` from the board store; throw if no board.
 *   2. Reuse (Req 6.1): if a `source-video` edge already wires the Video_Node
 *      to a `list` node, reuse it — skip node/edge creation.
 *   3/4. Otherwise create a `list` node beside the Video_Node and an edge
 *      `source-video → target-video` (handles passed explicitly because
 *      `createEdge` defaults `source_handle` to "source"), appending both to
 *      the store (Req 2.1, 2.3, 2.4).
 *   5. Replace the list's items with N fresh placeholders via
 *      `buildPlaceholderListItems` → `updateNodeData` (immediate UI) +
 *      `patchNode` (persist, non-fatal) (Req 2.2, 2.5, 6.2).
 */
export async function spawnVideoResultList(
  videoRfId: string,
  count: number,
  titles: string[],
): Promise<string> {
  const board = useBoardStore.getState();
  const { boardId, nodes, edges } = board;
  if (boardId === null) {
    throw new Error("spawn_video_result_list_no_board");
  }

  // Pure placeholder payload — built once and used to seed the new node and to
  // replace items on reuse (full replacement, never append; Req 6.2).
  const placeholderData = buildPlaceholderListItems(count, titles);
  const listTitle = "Video Results";

  // Step 2: reuse an existing Batch_Result_List wired via `source-video`.
  let listRfId = findReusableVideoResultList(edges, videoRfId, nodes);

  if (listRfId === null) {
    // Step 3: create the list node beside the Video_Node.
    const videoNode = nodes.find((entry) => entry.id === videoRfId);
    const baseX = videoNode?.position.x ?? 0;
    const baseY = videoNode?.position.y ?? 0;
    const listX = Math.round(baseX + VIDEO_NODE_DEFAULT_WIDTH + VIDEO_RESULT_LIST_GAP);
    const listY = Math.round(baseY);

    const listDto = await createNode({
      board_id: boardId,
      type: "list",
      x: listX,
      y: listY,
      data: {
        type: "list",
        title: listTitle,
        lockedType: "video",
        listViewMode: "grid",
        listIntakeMode: "replace",
        listSelectionMode: false,
        nodeWidth: 580,
        status: "running",
        ...placeholderData,
      },
    });
    listRfId = String(listDto.id);

    useBoardStore.getState().setNodes([
      ...useBoardStore.getState().nodes,
      {
        id: listRfId,
        type: listDto.type,
        position: { x: listDto.x, y: listDto.y },
        data: {
          type: listDto.type,
          shortId: listDto.short_id,
          title: (listDto.data["title"] as string | undefined) ?? listTitle,
          status: "running",
          listViewMode: "grid",
          listIntakeMode: "replace",
          listSelectionMode: false,
          nodeWidth: 580,
          ...placeholderData,
        },
      },
    ]);

    // Step 4: wire `source-video → target-video`. Handles MUST be passed
    // explicitly — `createEdge` otherwise defaults `source_handle` to "source".
    const videoDbId = parseInt(videoRfId, 10);
    const listDbId = listDto.id;
    if (isNaN(videoDbId)) {
      throw new Error("spawn_video_result_list_bad_video_id");
    }
    const edgeDto = await createEdge({
      board_id: boardId,
      source_id: videoDbId,
      target_id: listDbId,
      kind: "video",
      source_handle: "source-video",
      target_handle: "target-video",
    });
    useBoardStore.getState().setEdges([
      ...useBoardStore.getState().edges,
      {
        id: String(edgeDto.id),
        source: String(edgeDto.source_id),
        target: String(edgeDto.target_id),
        sourceHandle: edgeDto.source_handle ?? "source-video",
        targetHandle: edgeDto.target_handle ?? "target-video",
        data: { sourceVariantIdx: edgeDto.source_variant_idx ?? null },
      },
    ]);
  }

  // Step 5: lay down (or replace) the N placeholder slots — immediate UI update
  // plus a non-fatal persist so they survive an in-session reload (Req 2.2,
  // 2.5, 6.2).
  useBoardStore.getState().updateNodeData(listRfId, {
    status: "running",
    ...placeholderData,
  });
  const listDbId = parseInt(listRfId, 10);
  if (!isNaN(listDbId)) {
    patchNode(listDbId, { status: "running", data: { ...placeholderData } }).catch(() => {
      // Non-fatal for the session: the in-memory store is already correct.
    });
  }

  return listRfId;
}

async function runNodeDirect(
  get: () => GenerationState,
  rfId: string,
): Promise<void> {
  const board = useBoardStore.getState();
  const node = board.nodes.find((entry) => entry.id === rfId);
  if (!node) throw new Error("node_not_found");

  const nodeType = primaryNodeType(node);
  if (nodeType === "list") {
    const intakeMode = (node.data.listIntakeMode as string | undefined) === "keep" ? "keep" : "replace";
    const incomingEdges = board.edges.filter((edge) => edge.target === rfId);
    const existingItems = dedupeListItems(collectListItemsFromNode(node as { id: string; data: Record<string, unknown> }));

    // Leaf source list: no incoming edges but already populated (e.g. a
    // manually-curated Prompt list or an uploaded Image list). Rebuilding
    // from incoming edges here would produce an empty set and WIPE the
    // user's items. Just mark it done and keep what's there. Without this,
    // running a downstream generator auto-runs this list and erases its
    // prompts/images before dispatch can read them.
    if (incomingEdges.length === 0 && existingItems.length > 0) {
      const mediaItems = collectSelectedListMediaItems(node as { id: string; data: Record<string, unknown> });
      const leafMediaIds = mediaItems
        .map((item) => item.mediaId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      const leafFlowMediaIds = mediaItems
        .map((item) => item.flowMediaId ?? item.mediaId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      useBoardStore.getState().updateNodeData(rfId, {
        status: "done",
        mediaIds: leafMediaIds,
        mediaId: leafMediaIds[0] ?? undefined,
        flowMediaIds: leafFlowMediaIds,
        flowMediaId: leafFlowMediaIds[0] ?? undefined,
        error: undefined,
      });
      return;
    }
    const existingSelectedIndexes = Array.isArray(node.data.listSelectedIndexes)
      ? node.data.listSelectedIndexes
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0 && value < existingItems.length)
      : [];
    const existingSelectedSignatures = new Set(
      existingSelectedIndexes
        .map((index) => existingItems[index])
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => listItemSignature(item)),
    );
    const currentItems = intakeMode === "keep"
      ? existingItems
      : [];
    const items: Array<Record<string, unknown>> = [];

    for (const edge of incomingEdges) {
      const sourceNode = board.nodes.find((entry) => entry.id === edge.source);
      if (!sourceNode) continue;
      const sourceType = primaryNodeType(sourceNode);
      const targetHandle = edge.targetHandle ?? "target-image";
      const wantsText = targetHandle === "target-text" || targetHandle === "target";
      const wantsMedia = targetHandle === "target-image" || targetHandle === "target" || targetHandle === "target-video";

      if (sourceType === "text") {
        if (!wantsText) continue;
        const text = cleanText(sourceNode.data.prompt);
        if (!text) continue;
        items.push({
          id: `${sourceNode.id}-text-${items.length + 1}`,
          kind: "text",
          title: cleanText(sourceNode.data.title) ?? `Text ${items.length + 1}`,
          text,
        });
        continue;
      }

      const listItems = collectListItemsFromNode(sourceNode as { id: string; data: Record<string, unknown> });
      if (!isMediaSourceType(sourceType) && sourceType !== "list") continue;
      if (sourceType === "list") {
        const selectedIndexes = Array.isArray(sourceNode.data.listSelectedIndexes)
          ? new Set(
              sourceNode.data.listSelectedIndexes
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value) && value >= 0 && value < listItems.length),
            )
          : undefined;
        const selectedItems = selectedIndexes && selectedIndexes.size > 0
          ? listItems.filter((_, index) => selectedIndexes.has(index))
          : listItems;
        const sourceHandle = edge.sourceHandle ?? "source-image";
        const typedItems = sourceHandle === "source-text" || targetHandle === "target-text"
          ? selectedItems.filter((item) => item.kind === "text")
          : sourceHandle === "source-video" || targetHandle === "target-video"
            ? selectedItems.filter((item) => item.kind === "video")
            : sourceHandle === "source-image" || targetHandle === "target-image"
              ? selectedItems.filter((item) => item.kind === "image" || item.kind === "video")
              : selectedItems;
        items.push(...typedItems);
        continue;
      }

      if (!wantsMedia) continue;
      items.push(...listItems);
    }

    const nextItems = dedupeListItems(intakeMode === "replace" ? items : [...currentItems, ...items]);
    const nextSelectedIndexes = existingSelectedSignatures.size > 0
      ? nextItems.flatMap((item, index) => existingSelectedSignatures.has(listItemSignature(item)) ? [index] : [])
      : [];
    const activeMediaItems = (nextSelectedIndexes.length > 0
      ? nextItems.filter((_, index) => nextSelectedIndexes.includes(index))
      : nextItems)
      .filter((item) => item.kind === "image" || item.kind === "video");
    const mediaIds = activeMediaItems
      .map((item) => item.mediaId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const flowMediaIds = activeMediaItems
      .map((item) => item.flowMediaId ?? item.mediaId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    useBoardStore.getState().updateNodeData(rfId, {
      status: "done",
      listItems: nextItems,
      listSelectedIndexes: nextSelectedIndexes,
      mediaIds,
      mediaId: mediaIds[0] ?? undefined,
      flowMediaIds,
      flowMediaId: flowMediaIds[0] ?? undefined,
      variantCount: mediaIds.length > 0 ? mediaIds.length : nextItems.length,
      renderedAt: new Date().toISOString(),
      error: undefined,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        status: "done",
        data: {
          listItems: nextItems,
          listSelectedIndexes: nextSelectedIndexes,
          mediaIds,
          mediaId: mediaIds[0] ?? null,
          flowMediaIds,
          flowMediaId: flowMediaIds[0] ?? null,
          variantCount: mediaIds.length > 0 ? mediaIds.length : nextItems.length,
          renderedAt: new Date().toISOString(),
          error: null,
        },
      }).catch(() => {});
    }
    return;
  }

  if (nodeType === "reference") {
    const textEdge = board.edges.find((e) => e.target === rfId && e.targetHandle === "target-text");
    const textSourceNode = textEdge ? board.nodes.find((n) => n.id === textEdge.source) : null;
    const upstreamPrompts = textSourceNode
      ? (textSourceNode.data.type === "list"
          ? collectSelectedListTextPrompts(textSourceNode as { id: string; data: Record<string, unknown> })
          : [((textSourceNode.data.prompt as string | undefined) ?? "").trim()].filter(Boolean))
      : [];

    const prompt = upstreamPrompts[0] || ((node.data.prompt as string | undefined) ?? "").trim();
    const refMediaIds = collectUpstreamRefMediaIds(rfId);
    const hasImageRefs = refMediaIds.length > 0;

    if (!prompt && !hasImageRefs) {
      throw new Error("image_node_missing_prompt_or_refs");
    }
    const aspectKey = ((node.data.aspectKey as string | undefined) ?? "1:1") as keyof typeof IMAGE_NODE_ASPECT_TO_FLOW;
    const aspectRatio = IMAGE_NODE_ASPECT_TO_FLOW[aspectKey] ?? IMAGE_NODE_ASPECT_TO_FLOW["1:1"];
    const imageModel = normalizeImageModelKey(node.data.modelKey as string | undefined);

    const hasBatchInputs = upstreamPrompts.length > 1 && refMediaIds.length > 1;
    const batchMode = (node.data.batchMode as "zip" | "cross") || "cross";

    if (hasBatchInputs) {
      if (batchMode === "zip") {
        const minLength = Math.min(upstreamPrompts.length, refMediaIds.length);
        const pairedPrompts = upstreamPrompts.slice(0, minLength);
        const pairedRefs = refMediaIds.slice(0, minLength);

        await get().dispatchGeneration(rfId, {
          prompt: pairedPrompts[0],
          kind: "image",
          aspectRatio,
          variantCount: minLength,
          imageModel,
          prompts: pairedPrompts,
          sourceMediaIds: pairedRefs,
          skipSpawningNodes: true,
        });
        return;
      } else {
        // Cartesian Product / Cross Mode
        const crossedPrompts: string[] = [];
        const crossedRefs: string[] = [];
        for (const p of upstreamPrompts) {
          for (const r of refMediaIds) {
            crossedPrompts.push(p);
            crossedRefs.push(r);
          }
        }

        await get().dispatchGeneration(rfId, {
          prompt: crossedPrompts[0],
          kind: "image",
          aspectRatio,
          variantCount: crossedPrompts.length,
          imageModel,
          prompts: crossedPrompts,
          sourceMediaIds: crossedRefs,
          skipSpawningNodes: true,
        });
        return;
      }
    }

    const isPairedMode =
      upstreamPrompts.length >= 2 &&
      refMediaIds.length >= 2 &&
      upstreamPrompts.length === refMediaIds.length;

    const isMultiImageMode =
      !isPairedMode && refMediaIds.length >= 2 && upstreamPrompts.length <= 1;

    if (isPairedMode) {
      // -- Mode A: Paired dispatch --------------------------------------------
      // Dispatch all N pairs in a single batch request on the original node (rfId).
      // The backend SDK pairs them 1-to-1. Results are saved in the node's mediaIds,
      // and only the first image is visually displayed on the card itself.
      await get().dispatchGeneration(rfId, {
        prompt: upstreamPrompts[0],
        kind: "image",
        aspectRatio,
        variantCount: upstreamPrompts.length,
        imageModel,
        prompts: upstreamPrompts,
        sourceMediaIds: refMediaIds,
        skipSpawningNodes: true,
      });
      return;
    }

    if (isMultiImageMode) {
      // -- Mode B: Multi-image (all refs in one request) ----------------------
      // Send all N images as ref_media_ids so the model conditions on all of them.
      await get().dispatchGeneration(rfId, {
        prompt,
        kind: "image",
        aspectRatio,
        variantCount: 1,
        imageModel,
        prompts: upstreamPrompts.length > 0 ? [prompt] : undefined,
        sourceMediaIds: refMediaIds,
      });
      return;
    }

    // -- Mode C: Standard single dispatch --------------------------------------
    const imageCount = Math.max(
      1,
      Math.min(
        (node.data.imageCount as number | undefined)
          ?? (node.data.variantCount as number | undefined)
          ?? 1,
        4,
      ),
    );

    await get().dispatchGeneration(rfId, {
      prompt,
      kind: "image",
      aspectRatio,
      variantCount: imageCount,
      imageModel,
      sourceMediaId: refMediaIds.length === 1 && imageCount === 1 ? refMediaIds[0] : undefined,
      prompts: upstreamPrompts.length > 0 ? upstreamPrompts.slice(0, imageCount) : undefined,
      sourceMediaIds: refMediaIds.length > 0 ? refMediaIds : undefined,
    });
    return;
  }

  if (nodeType === "video") {
    const textEdge = board.edges.find((e) => e.target === rfId && e.targetHandle === "target-text");
    const textSourceNode = textEdge ? board.nodes.find((n) => n.id === textEdge.source) : null;
    const upstreamPrompts = textSourceNode
      ? (textSourceNode.data.type === "list"
          ? collectSelectedListTextPrompts(textSourceNode as { id: string; data: Record<string, unknown> })
          : [((textSourceNode.data.prompt as string | undefined) ?? "").trim()].filter(Boolean))
      : [];

    const startEdge = board.edges.find((e) => e.target === rfId && e.targetHandle === "target-start-image");
    const startNode = startEdge ? board.nodes.find((n) => n.id === startEdge.source) : undefined;
    const startMediaIds = startNode
      ? (startNode.data.type === "list"
          ? collectSelectedListMediaItems(startNode as { id: string; data: Record<string, unknown> })
              .map((item) => item.mediaUrl ?? item.imageUrl ?? item.mediaId ?? item.flowMediaId)
              .filter((m): m is string => typeof m === "string" && m.length > 0)
          : (Array.isArray(startNode.data.flowMediaIds) && startNode.data.flowMediaIds.length > 0
              ? startNode.data.flowMediaIds
              : (Array.isArray(startNode.data.mediaIds) ? startNode.data.mediaIds : [startNode.data.flowMediaId ?? startNode.data.mediaId])
            ).filter((m): m is string => typeof m === "string" && m.length > 0)
        )
      : [];

    const prompt = upstreamPrompts[0] || ((node.data.prompt as string | undefined) ?? "").trim();
    if (!prompt) throw new Error("video_node_missing_prompt");

    const videoModel = ((node.data.videoModel as string | undefined) ?? "veo") as "veo" | "omni_flash";
    const settings = useSettingsStore.getState();
    settings.setVideoModel(videoModel);
    if (videoModel === "veo") {
      settings.setVideoQuality(((node.data.videoQuality as string | undefined) ?? "fast") as any);
    } else {
      settings.setOmniFlashDuration(((node.data.omniFlashDuration as number | undefined) ?? 4) as any);
    }

    const aspectRatio =
      ((node.data.aspectRatio as string | undefined) === "VIDEO_ASPECT_RATIO_PORTRAIT"
        ? VIDEO_NODE_ASPECT_TO_FLOW["9:16"]
        : VIDEO_NODE_ASPECT_TO_FLOW["16:9"]);
    const cameraMode = ((node.data.cameraMode as string | undefined) ?? "static") as keyof typeof VIDEO_CAMERA_INSTRUCTIONS;
    const cameraInstruction = VIDEO_CAMERA_INSTRUCTIONS[cameraMode] ?? "";

    const hasBatchInputs = shouldSpawnVideoResultList(
      upstreamPrompts.length,
      startMediaIds.length,
    );
    const forceArraySource = startNode?.data.type === "list" && startMediaIds.length > 0;
    const batchMode = (node.data.batchMode as "zip" | "cross") || "cross";

    if (hasBatchInputs) {
      const { prompts: finalPrompts, refs: finalRefs } = buildVideoBatchPairs(
        upstreamPrompts,
        startMediaIds,
        batchMode,
      );

      // Add camera instruction to prompts
      const formattedPrompts = cameraInstruction 
        ? finalPrompts.map(p => `${p}. ${cameraInstruction}`)
        : finalPrompts;

      // Create (or reuse) the Batch_Result_List BEFORE dispatching so the N
      // placeholder slots show a pending state while the videos render
      // (Req 2.1, 2.6). N = formattedPrompts.length is known precisely here.
      let batchResultListId: string;
      try {
        const titles = formattedPrompts.map((_, i) => `Video ${i + 1}`);
        batchResultListId = await spawnVideoResultList(
          rfId,
          formattedPrompts.length,
          titles,
        );
      } catch {
        // Req 2.7, 2.8: surface an explicit error and abort the run so we never
        // dispatch a batch whose results have nowhere to land.
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error:
            "Không tạo được danh sách kết quả (Batch Result List). Đã hủy lần sinh.",
        });
        return;
      }

      // Remember the target list so the done-handler knows where to pour the
      // results (Req 4.3). Persisted (not just in-memory) so a reload/refresh
      // between dispatch and completion doesn't orphan the batch video results
      // with nowhere to land.
      commitNodeData(rfId, { batchResultListId });

      await get().dispatchGeneration(rfId, {
        prompt: formattedPrompts[0],
        kind: "video",
        aspectRatio,
        variantCount: formattedPrompts.length,
        prompts: formattedPrompts,
        sourceMediaIds: finalRefs,
      });
      return;
    }

    const promptWithCamera = cameraInstruction ? `${prompt}. ${cameraInstruction}` : prompt;
    const startMediaId = startMediaIds[0] ?? undefined;

    await get().dispatchGeneration(rfId, {
      prompt: promptWithCamera,
      kind: "video",
      aspectRatio,
      variantCount: 1,
      sourceMediaIds: forceArraySource ? startMediaIds : undefined,
      sourceMediaId: forceArraySource ? undefined : startMediaId,
    });
    return;
  }

  if (nodeType === "variant") {
    const config = ((node.data.variant_config as Record<string, unknown> | undefined) ?? {});
    const mode = (config.mode as string | undefined) ?? "Custom";
    const instruction = getUpstreamTextPrompt(rfId) || ((config.custom_prompt as string | undefined) ?? "").trim();
    const aspectRatioKey = (config.aspect_ratio as string | undefined) ?? "16:9";
    const grid = (config.grid as string | undefined) ?? "3x3";
    await get().dispatchVariant(rfId, {
      axisKey: VARIANT_MODE_TO_AXIS_KEY[mode] ?? "custom",
      instruction,
      variantCount: gridToVariantCount(grid),
      aspectRatio:
        {
          "1:1": "IMAGE_ASPECT_RATIO_SQUARE",
          "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
          "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT",
          "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE",
          "3:4": "IMAGE_ASPECT_RATIO_PORTRAIT",
          "3:2": "IMAGE_ASPECT_RATIO_LANDSCAPE",
          "2:3": "IMAGE_ASPECT_RATIO_PORTRAIT",
          "21:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
        }[aspectRatioKey] ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
    });
    return;
  }

  throw new Error(`node_type_not_auto_runnable:${nodeType ?? "unknown"}`);
}

async function ensureNodeInputsReady(
  get: () => GenerationState,
  rootRfId: string,
  targetRfId: string,
  visiting: Set<string>,
): Promise<void> {
  if (visiting.has(targetRfId)) {
    throw new Error("cycle_detected_in_workflow");
  }
  visiting.add(targetRfId);
  try {
    const board = useBoardStore.getState();
    const incomingEdges = board.edges.filter((edge) => edge.target === targetRfId && !isTextEdge(edge as any, board));

    for (const edge of incomingEdges) {
      const sourceNode = board.nodes.find((node) => node.id === edge.source);
      if (!sourceNode) continue;

      await ensureNodeInputsReady(get, rootRfId, sourceNode.id, visiting);

      const resolved = resolveEdgeMediaSelection(targetRfId, edge.id);
      if (resolved.mediaId) continue;

      const sourceType = primaryNodeType(sourceNode);
      const sourceStatus = (sourceNode.data.status as string | undefined) ?? "idle";
      if (isRunnableNodeType(sourceType)) {
        if (sourceStatus === "queued" || sourceStatus === "running" || get().active[sourceNode.id]) {
          const settled = await waitForNodeSettled(get, sourceNode.id);
          if (settled === "done" && resolveEdgeMediaSelection(targetRfId, edge.id).mediaId) continue;
        } else if (!hasRenderableMedia(sourceNode)) {
          await runNodeDirect(get, sourceNode.id);
          const settled = await waitForNodeSettled(get, sourceNode.id);
          if (settled === "done" && resolveEdgeMediaSelection(targetRfId, edge.id).mediaId) continue;
        }
      }

      if (!resolveEdgeMediaSelection(targetRfId, edge.id).mediaId) {
        const label = sourceNode.data.title || sourceType || sourceNode.id;
        throw new Error(`upstream_not_ready:${label}`);
      }
    }
  } finally {
    visiting.delete(targetRfId);
  }
}

function collectUpstreamRefMediaIds(targetRfId: string, allowedTargetHandles?: string[]): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const ids: string[] = [];
  const seenSourceIds = new Set<string>();

  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    if (allowedTargetHandles && !allowedTargetHandles.includes(e.targetHandle ?? "target")) continue;
    if (seenSourceIds.has(e.source)) continue;
    seenSourceIds.add(e.source);
    const src = nodes.find((n) => n.id === e.source);
    if (!src || !REF_SOURCE_TYPES.has(src.data.type)) continue;

    if (src.data.type === "list") {
      const mediaIds = collectSelectedListMediaItems(src as { id: string; data: Record<string, unknown> })
        .map((item) => (item.mediaUrl ?? item.imageUrl ?? item.mediaId ?? item.flowMediaId) as string)
        .filter((m) => typeof m === "string" && m.length > 0);
      ids.push(...mediaIds);
    } else {
      const { mediaId: chosen } = resolveEdgeMediaSelection(targetRfId, e.id);
      if (chosen) ids.push(chosen);
    }
  }
  return ids;
}

export function getVideoNodeInputs(targetRfId: string): {
  startImage: string | null;
  endImage: string | null;
  referenceImages: string[];
  textPrompt: string | null;
  startEdgeId: string | null;
  endEdgeId: string | null;
  referenceEdgeIds: string[];
} {
  const { nodes, edges } = useBoardStore.getState();
  let startImage: string | null = null;
  let endImage: string | null = null;
  let textPrompt: string | null = null;
  let startEdgeId: string | null = null;
  let endEdgeId: string | null = null;
  const referenceImages: string[] = [];
  const referenceEdgeIds: string[] = [];

  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const handle = e.targetHandle ?? "target";
    if (handle === "target-text") {
      if (typeof src.data.prompt === "string" && src.data.prompt.trim()) {
        textPrompt = src.data.prompt.trim();
      }
      continue;
    }
    if (!REF_SOURCE_TYPES.has(src.data.type)) continue;
    const { mediaId } = resolveEdgeMediaSelection(targetRfId, e.id);
    if (!mediaId) continue;
    if (handle === "target-start-image") {
      startImage = mediaId;
      startEdgeId = e.id;
    } else if (handle === "target-end-image") {
      endImage = mediaId;
      endEdgeId = e.id;
    } else if (handle === "target-references") {
      referenceImages.push(mediaId);
      referenceEdgeIds.push(e.id);
    }
  }

  return {
    startImage,
    endImage,
    referenceImages,
    textPrompt,
    startEdgeId,
    endEdgeId,
    referenceEdgeIds,
  };
}

/**
 * Shared dispatch helper for Concepta nodes that derive from an
 * upstream Concept (or other media-bearing) node via Flow
 * `edit_image`. Covers Part + Variant dispatch loops which both:
 *   1. require exactly one upstream edge with a media-bearing source,
 *   2. send a single Request-row with a node-type-specific extra
 *      payload (region_key for Part; axis/instruction for Variant),
 *   3. poll the request until it lands and stamp the result onto the
 *      target node + persist it to the DB so reloads keep the state.
 *
 * Without this helper Part + Variant would each duplicate ~120 lines
/**
 * Shared dispatch helper for Concepta nodes that derive from an
 * upstream Concept (or other media-bearing) node via Flow
 * `edit_image`. Covers Part + Variant dispatch loops which both:
 *   1. require exactly one upstream edge with a media-bearing source,
 *   2. send a single Request-row with a node-type-specific extra
 *      payload (region_key for Part; axis/instruction for Variant),
 *   3. poll the request until it lands and stamp the result onto the
 *      target node + persist it to the DB so reloads keep the state.
 *
 * Without this helper Part + Variant would each duplicate ~120 lines
 * of poll-loop boilerplate that's already battle-tested in
 * dispatchGeneration / dispatchMultiview.
 *
 * `mapResult` lets each caller translate the request `result` JSON
 * into the FlowboardNodeData fields it expects — Part is single-tile,
 * Variant is grid; both ride the same poll loop.
 */
type EditDerivedOpts = {
  aspectRatio?: string;
  aspectRatioFallback: string;
  paygateTier?: string;
  get: () => GenerationState;
  set: (
    update: Partial<GenerationState> | ((s: GenerationState) => Partial<GenerationState>),
  ) => void;
  /**
   * Translate the backend `result` blob into the node-data deltas to
   * stamp on completion. `extra` is merged into both the in-memory
   * updateNodeData and the persisted patchNode payload, so node-type-
   * specific fields (regionKey, axisKey, …) survive reload.
   */
  mapResult: (result: Record<string, unknown>) => {
    mediaId: string | undefined;
    mediaIds: (string | null)[];
    slotErrors: (string | null)[] | undefined;
    partialError: string | null;
    extra: Record<string, unknown>;
  };
  // Type-specific dispatch params (region_key / axis_key / etc.)
  // forwarded verbatim into Request.params.
  [key: string]: unknown;
};

async function dispatchEditDerived(
  rfId: string,
  requestType: "gen_part" | "gen_variant",
  opts: EditDerivedOpts,
): Promise<void> {
  const { get, set, mapResult, aspectRatio: optsAspectRatio, aspectRatioFallback, paygateTier, ...typeParams } =
    opts;

  const projectId = await get().ensureProjectId();
  if (projectId === null) return;

  const isTauri = typeof window !== "undefined" && 
    (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);

  let knownTier: string | null = null;

  if (!isTauri && supabase) {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      useBoardStore.getState().setShowAuthModal(true);
      return;
    }
    knownTier = (paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE") as string;
  } else {
    knownTier = (paygateTier ?? get().paygateTier) as string | null;
    if (!knownTier) {
      set({
        error:
          "Open Flow once so the extension can detect your plan, then retry.",
      });
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: "paygate_tier_unknown",
      });
      return;
    }
  }

  // Resolve upstream — Part / Variant need exactly one connected
  // upstream node with media (Concept, Multi-view tile, or another
  // Part / Variant for chaining). We pull the first incoming edge's
  // source mediaId; if the upstream is multi-variant we pick variant 0.
  const board = useBoardStore.getState();
  const upstreamEdge = board.edges.find((e) => e.target === rfId && !isTextEdge(e as any, board))
    || board.edges.find((e) => e.target === rfId);
  if (!upstreamEdge) {
    const label = requestType === "gen_part" ? "Part" : "Variant";
    set({
      error: `${label} needs a Concept (or Multi-view / Part / Variant) connected upstream.`,
    });
    useBoardStore.getState().updateNodeData(rfId, {
      status: "error",
      error: "no_upstream",
    });
    return;
  }
  const upstreamNode = board.nodes.find((n) => n.id === upstreamEdge.source);
  const resolvedSource = resolveEdgeMediaSelection(rfId, upstreamEdge.id);
  const sourceMediaId = resolvedSource.mediaId ?? undefined;
  if (!sourceMediaId) {
    set({
      error: "Upstream node has no media yet — generate it first.",
    });
    useBoardStore.getState().updateNodeData(rfId, {
      status: "error",
      error: "upstream_has_no_media",
    });
    return;
  }

  const node = board.nodes.find((n) => n.id === rfId);
  // Carry the upstream's aspect through if the caller didn't set
  // one — Part / Variant inherits framing intent from the Concept
  // it's derived from (a portrait Concept ? portrait Variant feels
  // right; user can override via the dialog later).
  const aspectRatio =
    (optsAspectRatio as string | undefined)
    ?? (node?.data.aspectRatio as string | undefined)
    ?? (upstreamNode?.data.aspectRatio as string | undefined)
    ?? aspectRatioFallback;

  // Cancel any in-flight poll for this node before re-dispatching.
  const existingEntry = get().active[rfId];
  if (existingEntry && existingEntry.timerId !== null) {
    clearTimeout(existingEntry.timerId);
  }

  // Optimistically mark queued so the node renders the busy state.
  useBoardStore.getState().updateNodeData(rfId, {
    status: "queued",
    error: undefined,
    mediaId: undefined,
    mediaIds: undefined,
  });

  // Build params: shared keys + type-specific keys spread last.
  const params: Record<string, unknown> = {
    project_id: projectId,
    source_media_id: sourceMediaId,
    aspect_ratio: aspectRatio,
    paygate_tier: knownTier,
    image_model: useSettingsStore.getState().imageModel,
    ...typeParams,
  };

  let reqDto;
  try {
    const dbId = parseInt(rfId, 10);
    reqDto = await createRequest({
      type: requestType,
      node_id: isNaN(dbId) ? undefined : dbId,
      params,
    });
  } catch (err) {
    commitNodeData(rfId, {
      status: "error",
      error: err instanceof Error ? err.message : "dispatch_failed",
    });
    set({
      error: err instanceof Error ? err.message : "Dispatch failed",
    });
    return;
  }

  // Register the active poll BEFORE the first tick — the guard at
  // the top of poll() bails if the entry is undefined, which is the
  // bug we hit first time we wired dispatchMultiview.
  const requestId = reqDto.id;

  pollRequest({ get, set }, rfId, requestId, {
    firstDelayMs: 800,
    onDone: (req) => {
      const result = (req.result ?? {}) as Record<string, unknown>;
      const mapped = mapResult(result);
      const renderedAt = new Date().toISOString();
      useBoardStore.getState().updateNodeData(rfId, {
        status: "done",
        mediaId: mapped.mediaId,
        mediaIds: mapped.mediaIds,
        slotErrors: mapped.slotErrors,
        aspectRatio,
        renderedAt,
        error: mapped.partialError ?? undefined,
        ...mapped.extra,
      });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          status: "done",
          data: {
            mediaId: mapped.mediaId ?? null,
            mediaIds: mapped.mediaIds,
            slotErrors: mapped.slotErrors ?? null,
            aspectRatio,
            renderedAt,
            error: mapped.partialError ?? null,
            ...mapped.extra,
          },
        }).catch(() => {});
      }
      set((s) => {
        const next = { ...s.active };
        delete next[rfId];
        return { active: next };
      });
    },
    onError: (errMsg) => {
      set({ error: errMsg });
    },
  });
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
  active: {},
  openDialog: { rfId: null, prompt: "" },
  openViewer: { rfId: null, idx: 0 },
  projectId: null,
  paygateTier: null,
  error: null,

  openGenerationDialog(rfId, prompt) {
    set({ openDialog: { rfId, prompt } });
  },

  closeGenerationDialog() {
    set({ openDialog: { rfId: null, prompt: "" } });
  },

  openResultViewer(rfId, idx = 0) {
    set({ openViewer: { rfId, idx } });
  },

  closeResultViewer() {
    set({ openViewer: { rfId: null, idx: 0 } });
  },

  async ensureProjectId() {
    const cached = get().projectId;
    if (cached !== null) return cached;

    const isTauri = typeof window !== "undefined" &&
      (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);
    if (!isTauri && supabase) {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        useBoardStore.getState().setShowAuthModal(true);
        return null;
      }
    }

    const boardId = useBoardStore.getState().boardId;
    if (boardId === null) {
      set({ error: "no board loaded" });
      return null;
    }
    try {
      const proj = await ensureBoardProject(boardId);
      set({ projectId: proj.flow_project_id });
      return proj.flow_project_id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async dispatchGeneration(rfId, opts: {
    prompt: string;
    aspectRatio?: string;
    paygateTier?: string;
    kind?: "image" | "video";
    sourceMediaId?: string;
    sourceMediaIds?: string[];
    variantCount?: number;
    imageModel?: ImageModelKey;
    prompts?: string[];
    skipSpawningNodes?: boolean;
  }) {
    const isTauri = typeof window !== "undefined" && 
      (!!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__);

    if (!isTauri && supabase) {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        useBoardStore.getState().setShowAuthModal(true);
        return;
      }
    } else {
      const knownTier = opts.paygateTier ?? get().paygateTier;
      if (!knownTier) {
        set({
          error: "Open Flow once so the extension can detect your plan, then retry. (See the Tier-unknown banner in the bottom-left.)",
        });
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: "paygate_tier_unknown",
        });
        return;
      }
    }

    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    // Cancel existing active node polling
    const existingEntry = get().active[rfId];
    if (existingEntry && existingEntry.timerId !== null) {
      clearTimeout(existingEntry.timerId);
    }

    // Optimistically update node — record variantCount so the placeholder
    // grid matches the eventual variant count even before generation finishes.
    // Video batch fan-out: one video per source image, so the placeholder
    // count must equal N (the number of sources) rather than the generic
    // image clamp. `batchSourceList` is narrowed to string[] in the truthy
    // branch, so no non-null assertion is needed.
    const batchSourceList =
      opts.kind === "video" &&
      Array.isArray(opts.sourceMediaIds) &&
      opts.sourceMediaIds.length > 1
        ? opts.sourceMediaIds
        : undefined;
    const variantCount = batchSourceList
      ? Math.max(1, batchSourceList.length)
      : Math.max(1, Math.min(opts.variantCount ?? 1, 99));
    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
      variantCount,
      mediaIds: undefined,
      mediaId: undefined,
    });

    const kind = opts.kind ?? "image";
    let reqDto;
    try {
      const nodeDbId = parseInt(rfId, 10);
      if (kind === "video") {
        const settings = useSettingsStore.getState();
        const isOmni = settings.videoModel === "omni_flash";
        // Veo i2v. Veo wants ONE source image to use as the literal
        // start frame (multi-source = batch of N parallel i2v calls,
        // one per variant). Omni Flash takes "ingredients" — a list of
        // referenceImages[] where each entry is IMAGE_USAGE_TYPE_ASSET.
        // The model conditions on the assets but doesn't use any of
        // them as a literal frame. So we walk EVERY upstream image-
        // bearing edge (character / image / visual_asset / Storyboard)
        // and pass them all, not just the one edge the i2v UI picked.
        if (isOmni) {
          const videoInputs = getVideoNodeInputs(rfId);
          const ingredients = videoInputs.referenceImages.length > 0
            ? videoInputs.referenceImages
            : (videoInputs.startImage ? [videoInputs.startImage] : []);
          // Batch fan-out: when the caller supplied a list of source images
          // (list-node x N), forward them as start_media_ids so the backend
          // SDK fans out one video per source — symmetric with the Veo path.
          const batchSources =
            Array.isArray(opts.sourceMediaIds) && opts.sourceMediaIds.length > 0
              ? opts.sourceMediaIds
              : undefined;
          // Only block dispatch when there is no source at all: not batching
          // AND no ingredient. In batch mode the SDK accepts empty
          // ref_media_ids as long as start_media_ids is non-empty.
          if (!batchSources && ingredients.length === 0) {
            useBoardStore.getState().updateNodeData(rfId, {
              status: "error",
              error: "no ingredients",
            });
            set({
              error:
                "Omni Flash needs at least one ingredient (connect an upstream Character / Image / Visual asset).",
            });
            return;
          }
          const omniParams: Record<string, unknown> = {
            prompt: opts.prompt,
            project_id: projectId,
            ref_media_ids: ingredients,
            duration_s: settings.omniFlashDuration,
            aspect_ratio:
              opts.aspectRatio ?? "VIDEO_ASPECT_RATIO_PORTRAIT",
            paygate_tier:
              opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
          };
          if (batchSources) {
            // Per-source images: the worker pairs start_media_ids[i] with
            // prompts[i], producing N distinct videos.
            omniParams.start_media_ids = batchSources;
            if (opts.prompts && opts.prompts.length > 0) {
              omniParams.prompts = opts.prompts;
            }
          }
          reqDto = await createRequest({
            type: "gen_video_omni",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: omniParams,
          });
        } else {
          // Veo i2v path — still validates "must have a single source
          // image / variant batch" because that's the model's input
          // contract. Omni's ingredient validation above runs first
          // when isOmni; this check only fires for the Veo branch.
          const videoInputs = getVideoNodeInputs(rfId);
          const startMediaIds = Array.isArray(opts.sourceMediaIds) && opts.sourceMediaIds.length > 0
            ? opts.sourceMediaIds
            : undefined;
          const startMediaId = opts.sourceMediaId ?? videoInputs.startImage ?? undefined;
          const hasMulti = Array.isArray(startMediaIds) && startMediaIds.length > 0;
          if (!hasMulti && !startMediaId) {
            useBoardStore.getState().updateNodeData(rfId, { status: "error", error: "no source media" });
            set({ error: "Veo i2v requires a source image (connect an upstream image node)" });
            return;
          }
          const videoParams: Record<string, unknown> = {
            prompt: opts.prompt,
            project_id: projectId,
            aspect_ratio: opts.aspectRatio ?? "VIDEO_ASPECT_RATIO_LANDSCAPE",
            // Tier precedence: explicit caller arg > auto-detected from
            // Flow > TIER_ONE fallback. The dialog no longer asks the user.
            paygate_tier:
              opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
            // Backend resolves [tier][quality][aspect] ? Flow model key.
            video_quality: settings.videoQuality,
          };
          if (hasMulti) {
            videoParams.start_media_ids = startMediaIds;
          } else {
            videoParams.start_media_id = startMediaId;
          }
          // Per-variant prompts: in batch (zip/cross) mode each i2v clip
          // gets its own prompt. Without this the worker reuses the single
          // `prompt` for every source image, collapsing distinct batch
          // prompts into one. The worker pairs prompts[i] with source[i].
          if (opts.prompts && opts.prompts.length > 0) {
            videoParams.prompts = opts.prompts;
          }
          reqDto = await createRequest({
            type: "gen_video",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: videoParams,
          });
        }
      } else {
        // If the caller explicitly supplies ref media ids (e.g. paired-dispatch
        // Mode A where the new node has no upstream edges), prefer those over
        // auto-collecting from the canvas graph.
        const refMediaIds =
          Array.isArray(opts.sourceMediaIds) && opts.sourceMediaIds.length > 0
            ? opts.sourceMediaIds
            : collectUpstreamRefMediaIds(rfId);
        // Concept-aware aspect default: humanoid / creature / robot /
        // outfit are vertically biased (full-body T-pose), vehicle /
        // building / weapon / prop want square or landscape. The
        // explicit caller-provided aspect always wins; this only fills
        // the gap when the dialog didn't pick one.
        //
        // Mutate opts so every downstream stamp (the patchNode +
        // updateNodeData calls below) sees the resolved value
        // without threading a separate variable through the long
        // dispatch + poll flow. Local-only mutation — opts is a
        // fresh object passed by the dialog.
        if (!opts.aspectRatio) {
          const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
          const typeKey = node?.data.typeKey as string | undefined;
          if ((node?.data.type as string | undefined) === "concept") {
            opts.aspectRatio = ["humanoid", "creature", "robot", "outfit"].includes(
              typeKey ?? "",
            )
              ? "IMAGE_ASPECT_RATIO_PORTRAIT"
              : ["building", "vehicle"].includes(typeKey ?? "")
                ? "IMAGE_ASPECT_RATIO_LANDSCAPE"
                : "IMAGE_ASPECT_RATIO_SQUARE";
          } else {
            opts.aspectRatio = "IMAGE_ASPECT_RATIO_LANDSCAPE";
          }
        }
        const editSourceMediaId = typeof opts.sourceMediaId === "string" && opts.sourceMediaId.length > 0
          ? opts.sourceMediaId
          : (refMediaIds.length === 1 && variantCount === 1 ? refMediaIds[0] : undefined);
        const effectiveRefMediaIds = editSourceMediaId
          ? refMediaIds.filter((mediaId) => mediaId !== editSourceMediaId)
          : refMediaIds;
        const params: Record<string, unknown> = {
          prompt: opts.prompt,
          project_id: projectId,
          aspect_ratio: opts.aspectRatio,
          paygate_tier:
            opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
          variant_count: variantCount,
          // User's image model preference from the Settings panel.
          // Backend resolves the nickname ? real Flow model identifier.
          image_model: opts.imageModel ?? useSettingsStore.getState().imageModel,
        };
        if (editSourceMediaId) {
          params.source_media_id = editSourceMediaId;
        }
        if (effectiveRefMediaIds.length > 0) {
          params.ref_media_ids = effectiveRefMediaIds;
        }
        // Per-variant prompts: when present, each variant uses its own
        // text instead of all sharing `params.prompt`. Backend falls back
        // to single prompt when missing/short.
        if (opts.prompts && opts.prompts.length > 0) {
          params.prompts = opts.prompts;
        }
        reqDto = await createRequest({
          type: editSourceMediaId ? "edit_image" : "gen_image",
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params,
        });
      }
    } catch (err) {
      commitNodeData(rfId, { status: "error", error: err instanceof Error ? err.message : "request failed" });
      set({ error: err instanceof Error ? err.message : "Generation failed" });
      return;
    }

    // Start polling
    const requestId = reqDto.id;
    // Cap consecutive network errors so a dead agent can't keep a poll alive
    // forever; bail to failed state after this many.
    const MAX_NETWORK_RETRIES = 8;
    let networkRetries = 0;

    function scheduleNextPoll() {
      // If the node was cancelled (e.g. user deleted it), stop chaining.
      if (get().active[rfId] === undefined) return;

      const timerId = setTimeout(async () => {
        // Also bail if the user cancelled (or deleted the node) while we slept.
        if (get().active[rfId] === undefined) return;
        try {
          const req = await getRequest(requestId);
          networkRetries = 0;

          if (req.status === "running") {
            useBoardStore.getState().updateNodeData(rfId, { status: "running" });
            // Reschedule
            set((s) => ({
              active: {
                ...s.active,
                [rfId]: { requestId, timerId: null },
              },
            }));
            scheduleNextPoll();
          } else if (req.status === "done") {
            // `media_ids` may contain `null` placeholders for variants
            // the backend marked as partial-failures (e.g. Veo content
            // filter blocked one of 4 i2v clips while the other 3
            // succeeded). Keep the positional alignment so the frontend
            // can map slot i ? upstream variant i, but pick the first
            // non-null entry as the "primary" mediaId for legacy
            // single-tile UI consumers.
            const flowMediaIds = (req.result["media_ids"] as (string | null)[] | undefined) ?? [];
            const mediaIds = (req.result["media_urls"] as (string | null)[] | undefined) ?? flowMediaIds;
            const assetIds = (req.result["asset_ids"] as (string | null)[] | undefined) ?? [];
            const mediaId = mediaIds.find(
              (m): m is string => typeof m === "string" && m.length > 0,
            );
            const flowMediaId = flowMediaIds.find(
              (m): m is string => typeof m === "string" && m.length > 0,
            );
            const completedProjectId = req.result["project_id"] as string | undefined;
            if (completedProjectId) {
              set({ projectId: completedProjectId });
            }
            // Surface the partial-error summary onto data.error while
            // keeping status="done" — the node still has renderable
            // variants, but the UI can flag that some slots got blocked.
            const partialError = (req.result["partial_error"] as string | undefined) ?? null;
            // Per-slot error codes (aligned to mediaIds) so the detail
            // viewer can render the exact filter reason on each blocked
            // tile. `null` length-matched array when nothing's blocked;
            // missing on legacy / non-video results.
            const slotErrors =
              (req.result["slot_errors"] as (string | null)[] | undefined) ?? null;
            // Stamp the model used onto the node so the detail panel can
            // show "Banana Pro" / "Quality" etc. — read from req.params
            // (what was dispatched). Tier-1 UI locks Lite + Quality so
            // we trust params directly without a backend fallback round-trip.
            const stampedImageModel =
              req.type === "gen_image"
                ? (req.params["image_model"] as string | undefined)
                : undefined;
            let stampedVideoQuality: string | undefined;
            if (req.type === "gen_video") {
              stampedVideoQuality =
                req.params["video_quality"] as string | undefined;
            } else if (req.type === "gen_video_omni") {
              const duration = req.params["duration_s"] as number | undefined;
              if (duration === 4 || duration === 6 || duration === 8 || duration === 10) {
                stampedVideoQuality = `abra_r2v_${duration}s`;
              }
            }
            const renderedAt = new Date().toISOString();
            useBoardStore.getState().updateNodeData(rfId, {
              status: "done",
              mediaId,
              mediaIds,
              assetIds,
              flowMediaId,
              flowMediaIds,
              slotErrors: slotErrors ?? undefined,
              aiBrief: undefined,
              aspectRatio: opts.aspectRatio,
              renderedAt,
              error: partialError ?? undefined,
              ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
              ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
            });
            // Persist to backend so the node survives page reload.
            const dbId = parseInt(rfId, 10);
            if (!isNaN(dbId) && mediaId) {
              const n = useBoardStore.getState().nodes.find((x) => x.id === rfId);
              const d = n?.data;
              // Backend merges `data`, so only deltas need to ship.
              // `aiBrief: null` is the explicit "clear" sentinel —
              // undefined would be dropped by JSON.stringify and leave
              // the stale brief sitting on the node.
              patchNode(dbId, {
                status: "done",
                data: {
                  // Persist prompt — without this, reloading the page
                  // shows "(no prompt)" in the detail panel because the
                  // dispatch flow only stamps prompt into the in-memory
                  // store, never to the backend. This used to live in
                  // the patchNode payload pre-Phase 20 and was
                  // accidentally dropped during the "only deltas" refactor.
                  prompt: opts.prompt,
                  mediaId,
                  mediaIds,
                  assetIds,
                  flowMediaId,
                  flowMediaIds,
                  slotErrors: slotErrors ?? null,
                  variantCount: d?.variantCount ?? mediaIds.length,
                  aiBrief: null,
                  aspectRatio: opts.aspectRatio,
                  renderedAt,
                  // `null` clears stale error from a previous attempt
                  // when this run was clean; otherwise persist the
                  // partial summary so it survives reload.
                  error: partialError ?? null,
                  ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
                  ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
                },
              }).catch(() => {
                // Non-fatal: the in-memory state is still correct for this session.
              });
            }
            // Batch video: pour the positional results into the
            // Batch_Result_List spawned at Generate time (Req 3.1-3.7,
            // 7.1-7.2). The target list id was stamped onto the Video_Node
            // before dispatch; read the CURRENT node so we pick up the
            // latest data after the updateNodeData above. The fill is
            // model-independent — it consumes only the positional
            // media_ids / slot_errors contract shared by Veo and Omni Flash.
            const rootNodeNow = useBoardStore.getState().nodes.find((x) => x.id === rfId);
            const batchResultListId = rootNodeNow?.data.batchResultListId as string | undefined;
            if ((opts.kind ?? "image") === "video" && batchResultListId) {
              const listData = buildVideoResultListItems({
                mediaIds,
                flowMediaIds,
                assetIds,
                slotErrors,
                prompts: opts.prompts ?? [opts.prompt],
              });
              useBoardStore.getState().updateNodeData(batchResultListId, {
                status: "done",
                ...listData,
                renderedAt,
              });
              const listDbId = parseInt(batchResultListId, 10);
              if (!isNaN(listDbId)) {
                patchNode(listDbId, {
                  status: "done",
                  data: { ...listData, renderedAt },
                }).catch(() => {
                  // Non-fatal: the in-memory state is still correct for this session.
                });
              }
            }
            if ((opts.kind ?? "image") === "image" && mediaIds.length > 1 && !(opts as any).skipSpawningNodes) {
              const board = useBoardStore.getState();
              const rootNode = board.nodes.find((x) => x.id === rfId);
              const baseX = rootNode?.position.x ?? 0;
              const baseY = rootNode?.position.y ?? 0;
              const rootTitle =
                (rootNode?.data.title as string | undefined)
                ?? "Image";
              const boardId = board.boardId;

              if (boardId !== null) {
                for (let idx = 1; idx < mediaIds.length; idx += 1) {
                  const extraMediaId = mediaIds[idx];
                  const extraFlowMediaId = flowMediaIds[idx];
                  const extraAssetId = assetIds[idx];
                  if (typeof extraMediaId !== "string" || !extraMediaId) continue;
                  try {
                    const extraDto = await createNode({
                      board_id: boardId,
                      type: "add_reference",
                      x: Math.round(baseX + idx * 340),
                      y: Math.round(baseY),
                      data: {
                        title: `${rootTitle} ${idx + 1}`,
                        mediaId: extraMediaId,
                        assetId: typeof extraAssetId === "string" ? extraAssetId : undefined,
                        flowMediaId: typeof extraFlowMediaId === "string" ? extraFlowMediaId : extraMediaId,
                        aspectRatio: opts.aspectRatio,
                        renderedAt,
                      },
                    });
                    useBoardStore.getState().setNodes([
                      ...useBoardStore.getState().nodes,
                      {
                        id: String(extraDto.id),
                        type: extraDto.type,
                        position: { x: extraDto.x, y: extraDto.y },
                        data: {
                          type: extraDto.type,
                          shortId: extraDto.short_id,
                          title:
                            (extraDto.data["title"] as string | undefined)
                            ?? `${rootTitle} ${idx + 1}`,
                          status: "done",
                          mediaId: extraMediaId,
                          assetId: typeof extraAssetId === "string" ? extraAssetId : undefined,
                          flowMediaId: typeof extraFlowMediaId === "string" ? extraFlowMediaId : extraMediaId,
                          aspectRatio: opts.aspectRatio,
                          renderedAt,
                        },
                      },
                    ]);
                    void patchNode(extraDto.id, {
                      status: "done",
                      data: {
                        mediaId: extraMediaId,
                        assetId: typeof extraAssetId === "string" ? extraAssetId : null,
                        flowMediaId: typeof extraFlowMediaId === "string" ? extraFlowMediaId : extraMediaId,
                        aspectRatio: opts.aspectRatio,
                        renderedAt,
                      },
                    });
                  } catch {
                    // Non-fatal: root node result is already complete.
                  }
                }
              }
            }
            // Generation results always carry a prompt (the one we just
            // dispatched with), and downstream synth treats prompt as the
            // source of truth. Vision adds nothing here — skip it.
            // Manual upload paths in NodeCard.tsx still call
            // requestAutoBrief; that helper now early-returns if the
            // target node already has a prompt, so behaviour stays sane
            // for upload-then-type flows too.
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next };
            });
          } else if (req.status === "failed" || req.status === "timeout") {
            // 'timeout' is the dedicated terminal state for the
            // 5-minute video-gen budget. We render it as a node error
            // so the card visually flags the stuck run, but tag the
            // message so the user can tell auto-timeout apart from a
            // generation failure.
            const errMsg =
              req.status === "timeout"
                ? `Timed out after 5 minutes (${req.error ?? "video_timeout"})`
                : (req.error ?? "unknown");
            // Persist the terminal error so it survives reload — the old
            // in-memory-only update reverted to the last-persisted state on
            // refresh, making a failed run look like it never happened.
            commitNodeData(rfId, { status: "error", error: errMsg });
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next, error: errMsg };
            });
          } else if (req.status === "canceled") {
            // User-initiated cancel from the activity bell. Don't
            // stamp the node as 'error' — clear the in-flight state
            // and leave whatever the node was showing before. Persist so a
            // reload doesn't resurrect a stale "running"/"queued" status.
            commitNodeData(rfId, { status: "idle" });
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next };
            });
          } else {
            // queued — keep polling
            set((s) => ({
              active: {
                ...s.active,
                [rfId]: { requestId, timerId: null },
              },
            }));
            scheduleNextPoll();
          }
        } catch (err) {
          networkRetries += 1;
          if (networkRetries >= MAX_NETWORK_RETRIES) {
            const msg = err instanceof Error ? err.message : "network error";
            commitNodeData(rfId, { status: "error", error: msg });
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next, error: `Generation poll failed: ${msg}` };
            });
            return;
          }
          scheduleNextPoll();
        }
      }, 1500);

      set((s) => ({
        active: {
          ...s.active,
          [rfId]: { requestId, timerId },
        },
      }));
    }

    // Initialize active entry before first poll
    set((s) => ({
      active: {
        ...s.active,
        [rfId]: { requestId, timerId: null },
      },
    }));
    scheduleNextPoll();
  },

  async refineImage(rfId, opts) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
    const sourceMediaId = node?.data.mediaId;
    if (!sourceMediaId) {
      set({ error: "no source image to refine" });
      return;
    }

    const existing = get().active[rfId];
    if (existing && existing.timerId !== null) clearTimeout(existing.timerId);

    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
      variantCount: 1,
      mediaIds: undefined,
    });

    const nodeDbId = parseInt(rfId, 10);
    let reqDto;
    try {
      reqDto = await createRequest({
        type: "edit_image",
        node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
        params: {
          prompt: opts.prompt,
          project_id: projectId,
          source_media_id: sourceMediaId,
          ref_media_ids: opts.refMediaIds ?? [],
          aspect_ratio: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
          paygate_tier: get().paygateTier ?? "PAYGATE_TIER_ONE",
          image_model: useSettingsStore.getState().imageModel,
        },
      });
    } catch (err) {
      commitNodeData(rfId, {
        status: "error",
        error: err instanceof Error ? err.message : "refine failed",
      });
      set({ error: err instanceof Error ? err.message : "refine failed" });
      return;
    }

    // One cancellable, retry-capped poll loop (shared helper). This replaces
    // the previous bespoke loop that had NO cancel guard and NO retry cap —
    // a zombie that resurrected itself on every getRequest resolve and leaked
    // timers on a deleted node.
    const requestId = reqDto.id;
    pollRequest({ get, set }, rfId, requestId, {
      firstDelayMs: 800,
      onDone: (req) => {
        const mediaIds = (req.result["media_ids"] as string[] | undefined) ?? [];
        const mediaId = mediaIds[0];
        // edit_image still routes through the user's image model setting.
        const stampedImageModel = req.params["image_model"] as string | undefined;
        const renderedAt = new Date().toISOString();
        useBoardStore.getState().updateNodeData(rfId, {
          status: "done",
          mediaId,
          mediaIds,
          aspectRatio: opts.aspectRatio,
          renderedAt,
          ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
        });
        const dbId = parseInt(rfId, 10);
        if (!isNaN(dbId) && mediaId) {
          // Backend merges `data` — ship the new state including prompt so it
          // survives reload.
          patchNode(dbId, {
            data: {
              prompt: opts.prompt,
              mediaId,
              mediaIds,
              variantCount: 1,
              aspectRatio: opts.aspectRatio,
              renderedAt,
              ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
            },
          }).catch(() => {});
        }
        set((s) => {
          const next = { ...s.active };
          delete next[rfId];
          return { active: next };
        });
      },
      onError: (errMsg) => {
        set({ error: errMsg });
      },
    });
  },


  // -- Variant (Concepta fork) ---------------------------------------
  async dispatchVariant(rfId, opts) {
    const variantCount = Math.max(1, Math.min(opts.variantCount ?? 1, 4));
    const prompt = buildVariantPrompt(opts.axisKey, opts.instruction);
    await dispatchEditDerived(rfId, "gen_variant", {
      axis_key: opts.axisKey,
      instruction: opts.instruction,
      prompt,
      variant_count: variantCount,
      aspectRatio: opts.aspectRatio,
      aspectRatioFallback: "IMAGE_ASPECT_RATIO_PORTRAIT",
      paygateTier: opts.paygateTier,
      get,
      set,
      mapResult: (result) => {
        const mediaIds =
          (result["media_ids"] as (string | null)[] | undefined) ?? [];
        const slotErrors =
          (result["slot_errors"] as (string | null)[] | undefined) ?? null;
        const partialError =
          (result["partial_error"] as string | undefined) ?? null;
        const firstMid = mediaIds.find(
          (m): m is string => typeof m === "string" && !!m,
        );
        return {
          mediaId: firstMid,
          mediaIds,
          slotErrors: slotErrors ?? undefined,
          partialError,
          extra: {
            axisKey: opts.axisKey,
            variantInstruction: opts.instruction,
            variantCount,
          },
        };
      },
    });
  },

  async runNodeGraph(rfId) {
    try {
      // Auto-run text edge sources if they are runnable but not done
      const board = useBoardStore.getState();
      const textEdge = board.edges.find((e) => e.target === rfId && isTextEdge(e as any, board));
      if (textEdge) {
        const textSourceNode = board.nodes.find((n) => n.id === textEdge.source);
        if (textSourceNode && isRunnableNodeType(primaryNodeType(textSourceNode))) {
          const status = (textSourceNode.data.status as string | undefined) ?? "idle";
          if (status !== "done" && status !== "running" && status !== "queued") {
            await runNodeDirect(get, textSourceNode.id);
            await waitForNodeSettled(get, textSourceNode.id);
          }
        }
      }

      await ensureNodeInputsReady(get, rfId, rfId, new Set<string>());

      const node = useBoardStore.getState().nodes.find((entry) => entry.id === rfId);
      if (!node) throw new Error("node_not_found");

      const status = (node.data.status as string | undefined) ?? "idle";
      if (status === "queued" || status === "running" || get().active[rfId]) {
        return;
      }

      await runNodeDirect(get, rfId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "workflow_run_failed";
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: message,
      });
      set({ error: message });
    }
  },

  cancelGeneration(rfId) {
    const entry = get().active[rfId];
    if (entry && entry.timerId !== null) {
      clearTimeout(entry.timerId);
    }
    set((s) => {
      const next = { ...s.active };
      delete next[rfId];
      return { active: next };
    });
  },

  clearError() {
    set({ error: null });
  },
}));

function buildVariantPrompt(axisKey: string, instruction: string): string {
  const templates: Record<string, { label: string; template: string }> = {
    color: {
      label: "Color",
      template:
        "Recolor the subject to: {instruction}. PRESERVE: silhouette, design lines, material types (metal stays metal, fabric stays fabric), structural detail, anatomy, pose, framing, neutral grey background, lighting. CHANGE: colour palette only. The result must read as an alternate colorway of the SAME subject.",
    },
    material: {
      label: "Material",
      template:
        "Swap the subject's materials to: {instruction}. PRESERVE: silhouette, design lines, anatomy, pose, framing, neutral grey background, lighting, colour palette where it makes sense. CHANGE: material rendering — surface roughness, specular highlights, texture grain. The result must read as the SAME subject re-imagined in different materials.",
    },
    damage: {
      label: "Damage state",
      template:
        "Apply this damage / wear state: {instruction}. PRESERVE: silhouette, anatomy, base design, pose, framing, neutral grey background, lighting, base colour palette. CHANGE: add weathering, scratches, dents, tears, dirt, bloodstains, missing pieces, charring — whatever the instruction calls for. The result must read as the SAME subject after the described damage.",
    },
    equipment: {
      label: "Equipment",
      template:
        "Swap the subject's equipment / gear: {instruction}. PRESERVE: subject's body, anatomy, identity, pose, framing, neutral grey background, lighting, base outfit colours where unaffected. CHANGE: weapons, shields, accessories, armor pieces — whichever the instruction targets. The result must read as the SAME subject with different gear.",
    },
    outfit_alt: {
      label: "Outfit alt",
      template:
        "Replace the subject's outfit with: {instruction}. PRESERVE: subject's body, anatomy, face, identity, pose, framing, neutral grey background, lighting, overall mood. CHANGE: the entire wardrobe / armor / costume to match the instruction. The result must read as the SAME character wearing a different outfit.",
    },
  };

  const axis = templates[axisKey];
  if (!axis) {
    return (instruction || "").trim();
  }

  let cleaned = (instruction || "").trim();
  if (!cleaned) {
    cleaned = `a different ${axis.label.toLowerCase()}`;
  }
  if (cleaned.length > 280) {
    cleaned = cleaned.slice(0, 280).trim();
  }
  return axis.template.replace("{instruction}", cleaned);
}











