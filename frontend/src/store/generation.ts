import { create } from "zustand";
import { ensureBoardProject, createRequest, getRequest, patchNode } from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { useBoardStore } from "./board";
import { useSettingsStore } from "./settings";

// Image nodes also need aiBrief now: when they feed into a downstream
// video, the motion synth uses the source still's brief to detect SCENE
// (studio / street / café / outdoor) and pick environment-appropriate
// motion vocabulary. Without this the video synth has no idea the source
// is a NYC street and outputs studio editorial poses instead of casual
// lifestyle motion.
const AUTO_BRIEF_TYPES = new Set(["character", "visual_asset", "image"]);

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

  cancelGeneration(rfId: string): void;
  clearError(): void;
}

// Walk the board to collect mediaIds of every upstream media-bearing node
// (character / image / visual_asset) feeding into this image-target node.
// All of these are passed to Flow as IMAGE_INPUT_TYPE_REFERENCE inputs so the
// new image is composed from them.
const REF_SOURCE_TYPES = new Set(["character", "image", "visual_asset"]);

function collectUpstreamRefMediaIds(targetRfId: string): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const ids: string[] = [];
  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || !REF_SOURCE_TYPES.has(src.data.type)) continue;
    const mid = src.data.mediaId;
    if (typeof mid === "string" && mid) ids.push(mid);
  }
  return ids;
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
        const params: Record<string, unknown> = {
          prompt: opts.prompt,
          project_id: projectId,
          aspect_ratio: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
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
            const mediaIds = req.result["media_ids"] as string[] | undefined ?? [];
            const mediaId = mediaIds[0];
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
              aiBrief: undefined,
              aspectRatio: opts.aspectRatio,
              renderedAt: new Date().toISOString(),
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
                  variantCount: d?.variantCount ?? mediaIds.length,
                  aiBrief: null,
                  aspectRatio: opts.aspectRatio,
                  renderedAt: new Date().toISOString(),
                  ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
                  ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
                },
              }).catch(() => {
                // Non-fatal: the in-memory state is still correct for this session.
              });
            }
            // Auto-brief on success for ref-style nodes (character / visual_asset)
            // so downstream auto-prompt has rich context to work with.
            const n = useBoardStore.getState().nodes.find((x) => x.id === rfId);
            if (mediaId && n && AUTO_BRIEF_TYPES.has(n.data.type)) {
              requestAutoBrief(rfId, mediaId);
            }
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
