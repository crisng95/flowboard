import { create } from "zustand";
import {
  ensureBoardProject,
  createRequest,
  getRequest,
  patchNode,
  autoPromptSheet,
} from "../api/client";
import { useBoardStore, type NodeStatus } from "./board";
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

  // Storyboard — see .omc/plans/storyboard-image-node.md.
  // dispatchStoryboard plans + dispatches all N shots in one request;
  // retryStoryboardShot re-runs a single failed shot (root → gen_image,
  // child → edit_image with parent.mediaId as base).
  dispatchStoryboard(
    rfId: string,
    opts: {
      shotCount: number; // 1..8
      narrativeSeed?: string;
      aspectRatio?: string;
      paygateTier?: string;
    },
  ): Promise<void>;

  retryStoryboardShot(rfId: string, shotIdx: number): Promise<void>;

  // Multi-view (Concepta fork) — generate an N-angle turnaround sheet
  // from an upstream Concept node. Backend dispatches as one root
  // gen_image + N-1 edit_image rotations off the root for tight
  // identity preservation.
  dispatchMultiview(
    rfId: string,
    opts: {
      // Multi-view v1.5: this node only generates the multi-panel
      // sheet image. Tile extraction (cropping into N standalone
      // views) lives in a downstream node consuming this sheet.
      preset: string; // "4view" | "prop_4view" | future presets
      aspectRatio?: string;
      paygateTier?: string;
    },
  ): Promise<void>;

  // Part (Concepta) — zoomed isolated region of an upstream Concept
  // (or Multi-view) node. One Flow `edit_image` per dispatch, prompt
  // composed backend-side from the picked region key.
  dispatchPart(
    rfId: string,
    opts: {
      regionKey: string; // "head" | "torso" | "weapon" | …
      aspectRatio?: string;
      paygateTier?: string;
    },
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
const REF_SOURCE_TYPES = new Set(["character", "image", "visual_asset", "Storyboard", "upload"]);

function collectUpstreamRefMediaIds(targetRfId: string): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const ids: string[] = [];
  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || !REF_SOURCE_TYPES.has(src.data.type)) continue;

    const variants = Array.isArray(src.data.mediaIds) ? src.data.mediaIds : [];
    const pinned = (e.data?.sourceVariantIdx ?? null) as number | null;

    let chosen: string | null = null;
    if (
      pinned !== null
      && pinned >= 0
      && pinned < variants.length
      && typeof variants[pinned] === "string"
      && variants[pinned]
    ) {
      chosen = variants[pinned] as string;
    } else if (typeof src.data.mediaId === "string" && src.data.mediaId) {
      chosen = src.data.mediaId;
    } else if (variants.length > 0 && typeof variants[0] === "string" && variants[0]) {
      chosen = variants[0] as string;
    }

    if (chosen) ids.push(chosen);
  }
  return ids;
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
  const { get, set, mapResult, aspectRatioFallback, paygateTier, ...typeParams } =
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
  const upstreamEdge = board.edges.find((e) => e.target === rfId);
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
    (node?.data.aspectRatio as string | undefined)
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
        const hasMulti =
          Array.isArray(opts.sourceMediaIds) && opts.sourceMediaIds.length > 0;
        if (!hasMulti && !opts.sourceMediaId) {
          useBoardStore.getState().updateNodeData(rfId, { status: "error", error: "no source media" });
          set({ error: "Video generation requires a source image (connect an upstream image node)" });
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
          video_quality: useSettingsStore.getState().videoQuality,
        };
        if (hasMulti) {
          videoParams.start_media_ids = opts.sourceMediaIds;
        } else {
          videoParams.start_media_id = opts.sourceMediaId;
        }
        reqDto = await createRequest({
          type: "gen_video",
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params: videoParams,
        });
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
          if (node?.data.type === "concept") {
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
            const stampedVideoQuality =
              req.type === "gen_video"
                ? (req.params["video_quality"] as string | undefined)
                : undefined;
            useBoardStore.getState().updateNodeData(rfId, {
              status: "done",
              mediaId,
              mediaIds,
              slotErrors: slotErrors ?? undefined,
              aiBrief: undefined,
              aspectRatio: opts.aspectRatio,
              renderedAt: new Date().toISOString(),
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
                  renderedAt: new Date().toISOString(),
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
          } else if (req.status === "failed") {
            const errMsg = req.error ?? "unknown";
            useBoardStore.getState().updateNodeData(rfId, { status: "error", error: errMsg });
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next, error: req.error ?? "Generation failed" };
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
        // failed
        const errMsg = req.error ?? "refine failed";
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

  async dispatchStoryboard(rfId, opts) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    const knownTier = opts.paygateTier ?? get().paygateTier;
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

    const shotCount = Math.max(1, Math.min(opts.shotCount, 8));
    const aspectRatio = opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE";

    // Cancel any in-flight poll for this node.
    const existingEntry = get().active[rfId];
    if (existingEntry && existingEntry.timerId !== null) {
      clearTimeout(existingEntry.timerId);
    }

    // Optimistic shots[] — placeholders so the UI shows N tiles immediately.
    const placeholderShots = Array.from({ length: shotCount }, (_, k) => ({
      idx: k,
      prompt: "",
      parentShotIdx: null as number | null,
      status: "queued" as const,
    }));
    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      shots: placeholderShots,
      shotCount,
      narrativeSeed: opts.narrativeSeed,
      aspectRatio,
      mediaIds: Array.from({ length: shotCount }, () => null),
      mediaId: undefined,
      error: undefined,
    });

    const nodeDbId = parseInt(rfId, 10);
    const refMediaIds = collectUpstreamRefMediaIds(rfId);
    let reqDto;
    try {
      reqDto = await createRequest({
        type: "gen_storyboard",
        node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
        params: {
          shot_count: shotCount,
          narrative_seed: opts.narrativeSeed ?? "",
          project_id: projectId,
          aspect_ratio: aspectRatio,
          paygate_tier: knownTier,
          image_model: useSettingsStore.getState().imageModel,
          global_ref_media_ids: refMediaIds,
        },
      });
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: err instanceof Error ? err.message : "request failed",
      });
      set({ error: err instanceof Error ? err.message : "Generation failed" });
      return;
    }

    const requestId = reqDto.id;
    const MAX_NETWORK_RETRIES = 8;
    let networkRetries = 0;

    const poll = async () => {
      if (get().active[rfId] === undefined) return;
      try {
        const req = await getRequest(requestId);
        networkRetries = 0;
        if (req.status === "running" || req.status === "queued") {
          useBoardStore.getState().updateNodeData(rfId, { status: req.status });
          const t = setTimeout(poll, 1500);
          set((s) => ({
            active: { ...s.active, [rfId]: { requestId, timerId: t } },
          }));
          return;
        }
        if (req.status === "done") {
          const result = req.result as {
            shots?: Array<{
              idx: number;
              prompt: string;
              parentShotIdx: number | null;
              mediaId?: string | null;
              status: string;
              error?: string | null;
            }>;
            node_status?: string;
            media_ids?: (string | null)[];
          };
          const shots = (result.shots ?? []).map((s) => ({
            idx: s.idx,
            prompt: s.prompt,
            parentShotIdx: s.parentShotIdx ?? null,
            mediaId: s.mediaId ?? undefined,
            status: s.status as
              | "idle" | "queued" | "running" | "done" | "error" | "blocked",
            error: s.error ?? undefined,
          }));
          const mediaIds = (result.media_ids ?? []) as (string | null)[];
          const nodeStatus = (result.node_status as
            | "idle" | "queued" | "running" | "done" | "error" | "partial"
            | undefined) ?? "done";
          const firstMid = mediaIds.find(
            (m): m is string => typeof m === "string" && m.length > 0,
          );
          useBoardStore.getState().updateNodeData(rfId, {
            status: nodeStatus,
            shots,
            shotCount: shots.length,
            mediaIds,
            mediaId: firstMid,
            aspectRatio,
            renderedAt: new Date().toISOString(),
          });
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId)) {
            patchNode(dbId, {
              status: nodeStatus,
              data: {
                shots,
                shotCount: shots.length,
                narrativeSeed: opts.narrativeSeed,
                mediaIds,
                aspectRatio,
                renderedAt: new Date().toISOString(),
                globalRefMediaIds: refMediaIds,
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
        // failed
        const errMsg = req.error ?? "storyboard generation failed";
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
        networkRetries += 1;
        if (networkRetries >= MAX_NETWORK_RETRIES) {
          const msg = err instanceof Error ? err.message : "network error";
          useBoardStore.getState().updateNodeData(rfId, {
            status: "error",
            error: msg,
          });
          set((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: msg };
          });
          return;
        }
        const t = setTimeout(poll, 1500);
        set((s) => ({
          active: { ...s.active, [rfId]: { requestId, timerId: t } },
        }));
      }
    };

    set((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: null } },
    }));
    setTimeout(poll, 800);
  },

  async retryStoryboardShot(rfId, shotIdx) {
    const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
    if (!node || !Array.isArray(node.data.shots)) {
      set({ error: "node has no shots" });
      return;
    }
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;
    const knownTier = get().paygateTier;
    if (!knownTier) {
      set({ error: "tier unknown — open Flow first" });
      return;
    }
    const nodeDbId = parseInt(rfId, 10);

    // Optimistic per-shot status flip.
    const newShots = node.data.shots.map((s) =>
      s.idx === shotIdx
        ? { ...s, status: "queued" as const, error: undefined }
        : s,
    );
    useBoardStore.getState().updateNodeData(rfId, { shots: newShots });

    let reqDto;
    try {
      // Refs are live — collect at retry time, not from a snapshot. If
      // the user re-wired upstream edges since the original gen, the
      // retry uses the new pool. Without this the retry runs ref-less
      // and identity drifts (the whole reason for the storyboard).
      const refMediaIds = collectUpstreamRefMediaIds(rfId);
      reqDto = await createRequest({
        type: "retry_storyboard_shot",
        node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
        params: {
          shot_idx: shotIdx,
          project_id: projectId,
          paygate_tier: knownTier,
          aspect_ratio:
            (node.data.aspectRatio as string | undefined) ??
            "IMAGE_ASPECT_RATIO_LANDSCAPE",
          image_model: useSettingsStore.getState().imageModel,
          ref_media_ids: refMediaIds,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "retry failed";
      useBoardStore.getState().updateNodeData(rfId, {
        shots: node.data.shots.map((s) =>
          s.idx === shotIdx ? { ...s, status: "error", error: msg } : s,
        ),
      });
      set({ error: msg });
      return;
    }

    const requestId = reqDto.id;
    // Register in the active poll registry so cancelGeneration(rfId)
    // (called on node deletion) actually stops the retry poll.
    set((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: null } },
    }));

    const poll = async () => {
      // Implicit cancel: if the node was deleted, the active entry is gone.
      if (get().active[rfId] === undefined) return;
      try {
        const req = await getRequest(requestId);
        if (req.status === "running" || req.status === "queued") {
          const t = setTimeout(poll, 1500);
          set((s) => ({
            active: { ...s.active, [rfId]: { requestId, timerId: t } },
          }));
          return;
        }
        if (req.status === "done") {
          const newMid = (req.result["media_id"] as string | null | undefined) ?? null;
          const current = useBoardStore
            .getState()
            .nodes.find((n) => n.id === rfId);
          const baseShots = (current?.data.shots ?? []) as typeof newShots;
          const updated = baseShots.map((s) =>
            s.idx === shotIdx
              ? {
                  ...s,
                  status: (newMid ? "done" : "error") as
                    | "done" | "error",
                  mediaId: newMid ?? undefined,
                  error: newMid ? undefined : "missing_media",
                }
              : s,
          );
          // Aggregate node-level status from all shots. "partial" is
          // reserved for the genuine mixed-success-and-failure case;
          // when other shots are still queued/running the node is
          // still "running" overall.
          const hasInProgress = updated.some(
            (s) => s.status === "queued" || s.status === "running",
          );
          const aggregate: NodeStatus =
            hasInProgress
              ? "running"
              : updated.every((s) => s.status === "done")
                ? "done"
                : updated.some((s) => s.status === "done")
                  ? "partial"
                  : "error";
          useBoardStore.getState().updateNodeData(rfId, {
            shots: updated,
            mediaIds: updated.map((s) => s.mediaId ?? null),
            status: aggregate,
          });
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId)) {
            patchNode(dbId, {
              status: aggregate,
              data: {
                shots: updated,
                mediaIds: updated.map((s) => s.mediaId ?? null),
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
        // failed
        const errMsg = req.error ?? "retry failed";
        const current = useBoardStore
          .getState()
          .nodes.find((n) => n.id === rfId);
        useBoardStore.getState().updateNodeData(rfId, {
          shots: (current?.data.shots ?? []).map((s) =>
            s.idx === shotIdx ? { ...s, status: "error", error: errMsg } : s,
          ),
        });
        set((s) => {
          const next = { ...s.active };
          delete next[rfId];
          return { active: next, error: errMsg };
        });
      } catch {
        const t = setTimeout(poll, 1500);
        set((s) => ({
          active: { ...s.active, [rfId]: { requestId, timerId: t } },
        }));
      }
    };
    setTimeout(poll, 800);
  },

  // ── Multi-view (Concepta fork) ────────────────────────────────────
  async dispatchMultiview(rfId, opts) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    const knownTier = opts.paygateTier ?? get().paygateTier;
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

    // Resolve upstream Concept — Multi-view requires exactly one
    // concept-bearing parent edge. We look at the first incoming edge
    // and pull its mediaId. Variants of the upstream concept (if any)
    // — pin via edge.data.sourceVariantIdx as elsewhere in the codebase.
    const board = useBoardStore.getState();
    const upstreamEdge = board.edges.find((e) => e.target === rfId);
    if (!upstreamEdge) {
      set({ error: "Multi-view needs a Concept node connected upstream." });
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: "no_concept_upstream",
      });
      return;
    }
    const upstreamNode = board.nodes.find((n) => n.id === upstreamEdge.source);
    const conceptMediaId = upstreamNode?.data.mediaId;
    if (!conceptMediaId) {
      set({ error: "Upstream Concept has no media yet — generate it first." });
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: "concept_has_no_media",
      });
      return;
    }

    const node = board.nodes.find((n) => n.id === rfId);
    const preset = opts.preset || node?.data.multiviewPreset || "4view";
    const aspectRatio = opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_PORTRAIT";

    // Step 1 — fetch per-angle prompts from the LLM. The backend
    // returns angles + prompts in lock-step. This is sequential
    // because the prompts depend on each other's role (root vs
    // rotation), and the round-trip is small (~5-8s per call).
    // Multi-view v1.5: this node generates only the multi-panel
    // sheet image. Tile extraction (cropping into N standalone
    // views) lives in a downstream node fed by this sheet output.
    // Why one /auto-sheet call: the sheet prompt is deterministic
    // (built from preset angles + identity), no LLM round-trip.
    let angles: string[] = [];
    let sheetPrompt = "";
    useBoardStore.getState().updateNodeData(rfId, {
      autoPromptStatus: "pending",
      status: "queued",
      error: undefined,
    });
    try {
      const resp = await autoPromptSheet(parseInt(rfId, 10), preset);
      angles = resp.angles;
      sheetPrompt = resp.sheet_prompt;
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, {
        autoPromptStatus: "failed",
        status: "error",
        error:
          err instanceof Error
            ? `multiview_synth: ${err.message}`
            : "multiview_synth: failed",
      });
      set({
        error:
          err instanceof Error
            ? `Multi-view sheet prompt failed: ${err.message}`
            : "Multi-view sheet prompt failed",
      });
      return;
    }
    useBoardStore.getState().updateNodeData(rfId, {
      autoPromptStatus: undefined,
      angles,
      mediaIds: undefined,
    });

    // Sheet output is landscape regardless of caller hint - the panels
    // need horizontal real estate. We keep aspectRatio for the result
    // blob (downstream tile-extract node will respect it per-tile).
    const params: Record<string, unknown> = {
      project_id: projectId,
      angles,
      concept_media_id: conceptMediaId,
      sheet_prompt: sheetPrompt,
      aspect_ratio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
      paygate_tier: knownTier,
      image_model: useSettingsStore.getState().imageModel,
    };

    let reqDto;
    try {
      const dbId = parseInt(rfId, 10);
      reqDto = await createRequest({
        type: "gen_multiview",
        node_id: isNaN(dbId) ? undefined : dbId,
        params,
      });
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error:
          err instanceof Error ? err.message : "multiview_dispatch_failed",
      });
      set({
        error:
          err instanceof Error ? err.message : "Multi-view dispatch failed",
      });
      return;
    }

    // Step 3 — poll the request, mirror the gen_image poll loop. We
    // reuse the same `active` map + setTimeout chain.
    const requestId = reqDto.id;
    const MAX_RETRIES = 8;
    let retries = 0;

    // Register the active poll BEFORE scheduling the first tick.
    // Without this, the `active[rfId] === undefined` guard at the top
    // of poll() bails out on the very first run because no entry has
    // been written yet — node never updates even when the backend
    // request finishes successfully. Mirrors dispatchGeneration's
    // setup at line ~552.
    set((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: null } },
    }));

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
          // Multi-view v1.5: result blob carries sheet_media_id only.
          // mediaId points at the sheet for previews + downstream tile node.
          const partialError = (result["partial_error"] as string | undefined) ?? null;
          const sheetMediaId = (result["sheet_media_id"] as string | null | undefined) ?? null;
          useBoardStore.getState().updateNodeData(rfId, {
            status: "done",
            mediaId: sheetMediaId ?? undefined,
            sheetMediaId,
            renderedAt: new Date().toISOString(),
            error: partialError ?? undefined,
          });
          // Persist
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId) && sheetMediaId) {
            patchNode(dbId, {
              status: "done",
              data: {
                mediaId: sheetMediaId,
                sheetMediaId,
                angles,
                multiviewPreset: preset,
                aspectRatio,
                renderedAt: new Date().toISOString(),
                error: partialError ?? null,
              },
            }).catch(() => {});
          }
          set((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
        } else {
          // failed
          useBoardStore.getState().updateNodeData(rfId, {
            status: "error",
            error: req.error ?? "multiview_failed",
          });
          set((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: req.error ?? "Multi-view failed" };
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
  },

  // ── Part (Concepta fork) ──────────────────────────────────────────
  async dispatchPart(rfId, opts) {
    await dispatchEditDerived(rfId, "gen_part", {
      region_key: opts.regionKey,
      aspectRatioFallback: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_SQUARE",
      paygateTier: opts.paygateTier,
      get,
      set,
      // Single-tile output — Part is a one-region zoom, not a batch.
      // Frontend expects mediaIds: [single] back to fit the slot
      // pattern the rest of the codebase uses.
      mapResult: (result) => {
        const mid = (result["media_ids"] as string[] | undefined)?.[0];
        // gen_part returns the same shape as gen_image (legacy
        // edit_image): media_ids is a 1-element array, not an
        // explicit `media_id` key. Coerce.
        const cleaned = typeof mid === "string" && mid ? [mid] : [];
        return {
          mediaId: cleaned[0],
          mediaIds: cleaned,
          slotErrors: undefined,
          partialError: null,
          extra: { regionKey: opts.regionKey },
        };
      },
    });
  },

  // ── Variant (Concepta fork) ───────────────────────────────────────
  async dispatchVariant(rfId, opts) {
    const variantCount = Math.max(1, Math.min(opts.variantCount ?? 1, 4));
    await dispatchEditDerived(rfId, "gen_variant", {
      axis_key: opts.axisKey,
      instruction: opts.instruction,
      variant_count: variantCount,
      aspectRatioFallback: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_PORTRAIT",
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
