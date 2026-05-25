import { create } from "zustand";
import {
  ensureBoardProject,
  createRequest,
  createNode,
  getRequest,
  patchNode,
} from "../api/client";
import { useBoardStore } from "./board";
import { useSettingsStore } from "./settings";

type PollEntry = { requestId: number; timerId: ReturnType<typeof setTimeout> | null };

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
      // Multi-source-image i2v: when the upstream image has N variants
      // we generate one video per variant. Backend sends N items in the
      // batchAsyncGenerate body so all are dispatched together.
      sourceMediaIds?: string[];
      variantCount?: number;
      // Per-variant prompts. When provided, each variant uses its own
      // prompt — required for batch auto-prompt to keep poses distinct
      // across the 4 generated images.
      prompts?: string[];
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

  cancelGeneration(rfId: string): void;
  clearError(): void;
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
//      a `mediaIds[idx]` entry there → use it.
//   2. Else if the source has an active `mediaId` → use it
//      (single-variant case; or multi-variant where the user hasn't
//      pinned yet — variant 0 is the natural default).
//   3. Else if the source has a non-empty `mediaIds[]` → use index 0.
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
  if (src.data.type === "video") {
    if (edge.sourceHandle === "source-start-image" && typeof src.data.startImageMediaId === "string") {
      return { mediaId: src.data.startImageMediaId, variantIdx: null, allVariants: [src.data.startImageMediaId] };
    }
    if (edge.sourceHandle === "source-end-image" && typeof src.data.endImageMediaId === "string") {
      return { mediaId: src.data.endImageMediaId, variantIdx: null, allVariants: [src.data.endImageMediaId] };
    }
  }

  const variants = (Array.isArray(src.data.mediaIds) ? src.data.mediaIds : [])
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const pin = (edge.data?.sourceVariantIdx ?? null) as number | null;

  if (pin !== null && pin >= 0 && pin < variants.length) {
    return { mediaId: variants[pin], variantIdx: pin, allVariants: variants };
  }
  if (typeof src.data.mediaId === "string" && src.data.mediaId) {
    const idx = variants.indexOf(src.data.mediaId);
    return {
      mediaId: src.data.mediaId,
      variantIdx: idx >= 0 ? idx : null,
      allVariants: variants,
    };
  }
  if (variants.length > 0) {
    return { mediaId: variants[0], variantIdx: 0, allVariants: variants };
  }
  return { mediaId: null, variantIdx: null, allVariants: [] };
}

function collectUpstreamRefMediaIds(targetRfId: string, allowedTargetHandles?: string[]): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const ids: string[] = [];

  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    if (allowedTargetHandles && !allowedTargetHandles.includes(e.targetHandle ?? "target")) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || !REF_SOURCE_TYPES.has(src.data.type)) continue;

    const { mediaId: chosen } = resolveEdgeMediaSelection(targetRfId, e.id);

    if (chosen) ids.push(chosen);
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

  const knownTier = paygateTier ?? get().paygateTier;
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

  // Resolve upstream — Part / Variant need exactly one connected
  // upstream node with media (Concept, Multi-view tile, or another
  // Part / Variant for chaining). We pull the first incoming edge's
  // source mediaId; if the upstream is multi-variant we pick variant 0.
  const board = useBoardStore.getState();
  const upstreamEdge = board.edges.find((e) => e.target === rfId && e.targetHandle !== "target-text")
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
  // Variant pin support — same logic as collectUpstreamRefMediaIds.
  const variants = Array.isArray(upstreamNode?.data.mediaIds)
    ? (upstreamNode!.data.mediaIds as (string | null)[])
    : [];
  const pinned = (upstreamEdge.data?.sourceVariantIdx ?? null) as number | null;
  let sourceMediaId: string | undefined;
  if (
    pinned !== null
    && pinned >= 0
    && pinned < variants.length
    && typeof variants[pinned] === "string"
    && variants[pinned]
  ) {
    sourceMediaId = variants[pinned] as string;
  } else if (typeof upstreamNode?.data.mediaId === "string" && upstreamNode.data.mediaId) {
    sourceMediaId = upstreamNode.data.mediaId;
  } else if (variants.length > 0) {
    const fallback = variants.find(
      (m): m is string => typeof m === "string" && !!m,
    );
    if (fallback) sourceMediaId = fallback;
  }
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
  // it's derived from (a portrait Concept → portrait Variant feels
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
    useBoardStore.getState().updateNodeData(rfId, {
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
  set((s) => ({
    active: { ...s.active, [rfId]: { requestId, timerId: null } },
  }));

  const MAX_RETRIES = 8;
  let retries = 0;

  const poll = async () => {
    if (get().active[rfId] === undefined) return;
    try {
      const req = await getRequest(requestId);
      retries = 0;
      if (req.status === "running" || req.status === "queued") {
        useBoardStore.getState().updateNodeData(rfId, { status: "running" });
        const t = setTimeout(poll, 1500);
        set((s) => ({
          active: { ...s.active, [rfId]: { requestId, timerId: t } },
        }));
      } else if (req.status === "done") {
        const result = (req.result ?? {}) as Record<string, unknown>;
        const mapped = mapResult(result);
        useBoardStore.getState().updateNodeData(rfId, {
          status: "done",
          mediaId: mapped.mediaId,
          mediaIds: mapped.mediaIds,
          slotErrors: mapped.slotErrors,
          aspectRatio,
          renderedAt: new Date().toISOString(),
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
              renderedAt: new Date().toISOString(),
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
      } else {
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: req.error ?? `${requestType}_failed`,
        });
        set((s) => {
          const next = { ...s.active };
          delete next[rfId];
          return { active: next, error: req.error ?? "Dispatch failed" };
        });
      }
    } catch {
      retries++;
      if (retries >= MAX_RETRIES) {
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: "network_unavailable",
        });
        set((s) => {
          const next = { ...s.active };
          delete next[rfId];
          return { active: next, error: "Network unavailable" };
        });
        return;
      }
      const t = setTimeout(poll, 1500);
      set((s) => ({
        active: { ...s.active, [rfId]: { requestId, timerId: t } },
      }));
    }
  };
  setTimeout(poll, 800);
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
    prompts?: string[];
  }) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    // Pre-flight: refuse to dispatch if the paygate tier is unknown.
    // The backend would reject with `paygate_tier_unknown` anyway (since
    // Phase 1 stopped silently defaulting to Pro), but bailing here gives
    // the user a clearer hint without spending a captcha round-trip and
    // without leaving a `failed` request row in the DB. The
    // AccountPanel's "Tier unknown — Open Flow" banner is the recovery
    // path.
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

    // Cancel existing poll for this node if any
    const existingEntry = get().active[rfId];
    if (existingEntry && existingEntry.timerId !== null) {
      clearTimeout(existingEntry.timerId);
    }

    // Optimistically update node — record variantCount so the placeholder
    // grid matches the eventual variant count even before generation finishes.
    const variantCount = Math.max(1, Math.min(opts.variantCount ?? 1, 4));
    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
      variantCount,
      mediaIds: undefined,
      mediaId: undefined,
    });

    // Create request
    const kind = opts.kind ?? "image";
    let reqDto;
    try {
      const nodeDbId = parseInt(rfId, 10);
      if (kind === "video") {
        const settings = useSettingsStore.getState();
        const isOmni = settings.videoModel === "omni_flash";

        // Omni Flash takes a fundamentally different input shape from
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
          if (ingredients.length === 0) {
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
          reqDto = await createRequest({
            type: "gen_video_omni",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: {
              prompt: opts.prompt,
              project_id: projectId,
              ref_media_ids: ingredients,
              duration_s: settings.omniFlashDuration,
              aspect_ratio:
                opts.aspectRatio ?? "VIDEO_ASPECT_RATIO_PORTRAIT",
              paygate_tier:
                opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
            },
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
            // Backend resolves [tier][quality][aspect] → Flow model key.
            video_quality: settings.videoQuality,
          };
          if (hasMulti) {
            videoParams.start_media_ids = startMediaIds;
          } else {
            videoParams.start_media_id = startMediaId;
          }
          reqDto = await createRequest({
            type: "gen_video",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: videoParams,
          });
        }
      } else {
        const refMediaIds = collectUpstreamRefMediaIds(rfId);
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
        const params: Record<string, unknown> = {
          prompt: opts.prompt,
          project_id: projectId,
          aspect_ratio: opts.aspectRatio,
          paygate_tier:
            opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
          variant_count: variantCount,
          // User's image model preference from the Settings panel.
          // Backend resolves the nickname → real Flow model identifier.
          image_model: useSettingsStore.getState().imageModel,
        };
        if (refMediaIds.length > 0) {
          params.ref_media_ids = refMediaIds;
        }
        // Per-variant prompts: when present, each variant uses its own
        // text instead of all sharing `params.prompt`. Backend falls back
        // to single prompt when missing/short.
        if (opts.prompts && opts.prompts.length > 0) {
          params.prompts = opts.prompts;
        }
        reqDto = await createRequest({
          type: "gen_image",
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params,
        });
      }
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, { status: "error", error: err instanceof Error ? err.message : "request failed" });
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
            // can map slot i ↔ upstream variant i, but pick the first
            // non-null entry as the "primary" mediaId for legacy
            // single-tile UI consumers.
            const mediaIds = (req.result["media_ids"] as (string | null)[] | undefined) ?? [];
            const mediaId = mediaIds.find(
              (m): m is string => typeof m === "string" && m.length > 0,
            );
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
            if ((opts.kind ?? "image") === "image" && mediaIds.length > 1) {
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
                          aspectRatio: opts.aspectRatio,
                          renderedAt,
                        },
                      },
                    ]);
                    void patchNode(extraDto.id, {
                      status: "done",
                      data: {
                        mediaId: extraMediaId,
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
            useBoardStore.getState().updateNodeData(rfId, { status: "error", error: errMsg });
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next, error: errMsg };
            });
          } else if (req.status === "canceled") {
            // User-initiated cancel from the activity bell. Don't
            // stamp the node as 'error' — clear the in-flight state
            // and leave whatever the node was showing before.
            useBoardStore.getState().updateNodeData(rfId, { status: "idle" });
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
            useBoardStore.getState().updateNodeData(rfId, { status: "error", error: msg });
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
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: err instanceof Error ? err.message : "refine failed",
      });
      set({ error: err instanceof Error ? err.message : "refine failed" });
      return;
    }

    // Reuse the same poll loop by manually wiring active entry; copy-paste of
    // dispatchGeneration's poller would be loud, so we do a minimal wait here.
    const requestId = reqDto.id;
    set((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: null } },
    }));

    const poll = async () => {
      try {
        const req = await getRequest(requestId);
        if (req.status === "running" || req.status === "queued") {
          useBoardStore.getState().updateNodeData(rfId, { status: req.status });
          const t = setTimeout(poll, 1500);
          set((s) => ({
            active: { ...s.active, [rfId]: { requestId, timerId: t } },
          }));
          return;
        }
        if (req.status === "done") {
          const mediaIds = (req.result["media_ids"] as string[] | undefined) ?? [];
          const mediaId = mediaIds[0];
          // edit_image still routes through the user's image model setting.
          const stampedImageModel = req.params["image_model"] as string | undefined;
          useBoardStore.getState().updateNodeData(rfId, {
            status: "done",
            mediaId,
            mediaIds,
            aspectRatio: opts.aspectRatio,
            renderedAt: new Date().toISOString(),
            ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
          });
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId) && mediaId) {
            // Backend merges `data` — ship the new state including
            // prompt so it survives reload (regression fix: pre-Phase 20
            // the patchNode payload included prompt; the "only deltas"
            // refactor dropped it on the assumption prompt was already
            // persisted, but the dispatch flow never wrote it to backend).
            patchNode(dbId, {
              data: {
                prompt: opts.prompt,
                mediaId,
                mediaIds,
                variantCount: 1,
                aspectRatio: opts.aspectRatio,
                renderedAt: new Date().toISOString(),
                ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
              },
            }).catch(() => {});
          }
          set((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
          return;
        }
        if (req.status === "canceled") {
          useBoardStore.getState().updateNodeData(rfId, { status: "idle" });
          set((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
          return;
        }
        // failed | timeout — treat as a hard error on the node card so
        // the user sees something happened. 'timeout' is the auto-cancel
        // after the 5-minute video-gen budget; tag the message so the
        // user can tell auto-timeout apart from a real failure.
        const errMsg =
          req.status === "timeout"
            ? `Timed out after 5 minutes (${req.error ?? "video_timeout"})`
            : (req.error ?? "refine failed");
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: errMsg,
        });
        set((s) => {
          const next = { ...s.active };
          delete next[rfId];
          return { active: next, error: errMsg };
        });
      } catch (err) {
        const t = setTimeout(poll, 1500);
        set((s) => ({
          active: { ...s.active, [rfId]: { requestId, timerId: t } },
        }));
        console.warn("refine poll failed", err);
      }
    };
    setTimeout(poll, 800);
  },


  // ── Variant (Concepta fork) ───────────────────────────────────────
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
