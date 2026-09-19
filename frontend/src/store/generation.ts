import { create } from "zustand";
import {
  ensureBoardProject,
  createRequest,
  getRequest,
  listBoardRequests,
  patchNode,
} from "../api/client";
import { useBoardStore } from "./board";
import { useSettingsStore } from "./settings";

type PollEntry = { requestId: number; timerId: ReturnType<typeof setTimeout> | null };

// Everything the poll loop needs that it can't read back off the request
// row. Both are re-derivable from `request.params`, which is why the resume
// endpoint ships them — see `resumeActiveRequests`.
type PollOpts = { prompt: string; aspectRatio?: string };

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

  // Re-attach the poll loop to generations that are still in flight on the
  // backend. Called after a board loads, because a page reload kills every
  // poll this store had running.
  resumeActiveRequests(boardId: number): Promise<void>;

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
const REF_SOURCE_TYPES = new Set(["character", "image", "visual_asset", "Storyboard"]);

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

// Request types that render media. Mirrors `MEDIA_PRODUCING_TYPES` in
// agent/flowboard/request_types.py — the backend already refuses to hand
// any other type to a resume, this copy exists so the poll loop is safe
// on its own terms whatever reaches it.
const MEDIA_PRODUCING_TYPES = new Set([
  "gen_image",
  "gen_video",
  "gen_video_omni",
  "edit_image",
]);

// ── Poll loop ────────────────────────────────────────────────────────────
// Lifted out of `dispatchGeneration` so the reload-resume path can re-attach
// the same machinery to a request it never dispatched. All three callers —
// `dispatchGeneration`, `refineImage`, `resumeActiveRequests` — drive the one
// `active` map, because a second poll implementation would mean a second way
// for a node to decide it's finished, and they would disagree. (Refine kept
// its own copy for a while and did exactly that.)
//
// Reaches the store through `useGenerationStore` rather than the factory's
// `set` / `get` (identical functions) purely so it can live out here; it is
// only ever called after the store exists.

// `active[rfId]` names exactly one request per node, and that name is the
// chain's ownership token: a chain may only touch the node while the entry
// still points at ITS `requestId`. Re-dispatching on a node overwrites the
// entry, which is what hands ownership over.
//
// Every await is a place where ownership can change underneath a chain, so
// every await is followed by this check. Without it a chain that was sitting
// inside `getRequest` when the user hit Generate again would come back, write
// its own entry over the new one, and keep running alongside its replacement:
// two chains racing to decide the node is finished. The loser's `patchNode`
// can land after the worker committed the newer generation, which pins the
// node to the OLDER result permanently.
function ownsPoll(rfId: string, requestId: number): boolean {
  return useGenerationStore.getState().active[rfId]?.requestId === requestId;
}

function attachPoll(rfId: string, requestId: number, opts: PollOpts) {
  // Cap consecutive network errors so a dead agent can't keep a poll alive
  // forever; bail to failed state after this many.
  const MAX_NETWORK_RETRIES = 8;
  let networkRetries = 0;

  function scheduleNextPoll() {
    // Stop chaining once this chain no longer owns the node — cancelled
    // (user deleted it) or superseded by a newer request.
    if (!ownsPoll(rfId, requestId)) return;

    const timerId = setTimeout(async () => {
      // Ownership may have moved on while we slept.
      if (!ownsPoll(rfId, requestId)) return;
      try {
        const req = await getRequest(requestId);
        // ...and again after the round-trip. This is the check that keeps a
        // superseded chain from writing node data, PATCHing the DB, or
        // resurrecting its own `active` entry: everything below mutates
        // shared state, so nothing below may run for a stale request.
        if (!ownsPoll(rfId, requestId)) return;
        networkRetries = 0;

        if (req.status === "running") {
          useBoardStore.getState().updateNodeData(rfId, { status: "running" });
          // Reschedule
          useGenerationStore.setState((s) => ({
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
          // A type that renders nothing must never write the media keys.
          // The LLM activity types (`vision`, `auto_prompt`, ...) settle
          // with a result that has no `media_ids` at all, and the read
          // above turns that absence into
          // `[]` + `undefined` — which `updateNodeData` (a plain spread)
          // then lays straight over whatever the node was showing, so the
          // user watches their generated image vanish off the canvas.
          // The resume endpoint no longer hands those types to a poll
          // (agent/flowboard/routes/boards.py::RESUMABLE_REQUEST_TYPES),
          // but this branch is reachable by direct dispatch too, and the
          // rule is the same either way: an absent `media_ids` is "this
          // request was never about media", not "nothing rendered".
          const producesMedia = MEDIA_PRODUCING_TYPES.has(req.type);
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
          // `edit_image` (refine) is dispatched with the same image-model
          // setting, so it stamps through here too.
          const stampedImageModel =
            req.type === "gen_image" || req.type === "edit_image"
              ? (req.params["image_model"] as string | undefined)
              : undefined;
          // For Veo (`gen_video`) the dispatched `video_quality` IS the
          // model selector (lite / fast / quality / lite_relaxed). For
          // Omni Flash (`gen_video_omni`) the model is duration-scoped —
          // derive the Flow model key (abra_r2v_<N>s) from the dispatched
          // duration so the detail panel can surface the exact variant
          // that ran (mirrors backend's resolve_omni_flash_model).
          let stampedVideoQuality: string | undefined;
          if (req.type === "gen_video") {
            stampedVideoQuality = req.params["video_quality"] as
              | string
              | undefined;
          } else if (req.type === "gen_video_omni") {
            const d = req.params["duration_s"] as number | undefined;
            if (d === 4 || d === 6 || d === 8 || d === 10) {
              stampedVideoQuality = `abra_r2v_${d}s`;
            }
          }
          useBoardStore.getState().updateNodeData(rfId, {
            status: "done",
            ...(producesMedia
              ? { mediaId, mediaIds, slotErrors: slotErrors ?? undefined }
              : {}),
            aiBrief: undefined,
            // Same guard as `prompt` in the patch below, for the same
            // reason: a resumed poll rebuilds `opts` from the request's
            // params, so a request type that doesn't send `aspect_ratio`
            // would spread `undefined` straight over the node's real
            // value. Every gen type sends one today — this is here so the
            // next one that doesn't isn't a silent data loss.
            ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
            renderedAt: new Date().toISOString(),
            error: partialError ?? undefined,
            ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
            ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
          });
          // Belt-and-braces. The worker already wrote all of this onto
          // the node before it flipped the request to `done` (see
          // agent/flowboard/worker/processor.py::_node_completion_patch)
          // — that is what makes the result survive a reload, and it is
          // now the authoritative write. This PATCH re-sends the same
          // values, so it is idempotent; it stays because dropping it is
          // a bigger refactor than this fix needs, and because it keeps
          // the round-trip honest if the two ever disagree.
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId) && producesMedia && mediaId) {
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
                // Only sent when we actually have one: a resumed poll
                // reconstructs `opts` from the request's params, and an
                // empty string here would merge over the real prompt
                // rather than leave it alone.
                ...(opts.prompt ? { prompt: opts.prompt } : {}),
                mediaId,
                mediaIds,
                slotErrors: slotErrors ?? null,
                variantCount: d?.variantCount ?? mediaIds.length,
                aiBrief: null,
                ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
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
          useGenerationStore.setState((s) => {
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
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: errMsg };
          });
        } else if (req.status === "canceled") {
          // User-initiated cancel from the activity bell. Don't
          // stamp the node as 'error' — clear the in-flight state
          // and leave whatever the node was showing before.
          useBoardStore.getState().updateNodeData(rfId, { status: "idle" });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
        } else {
          // queued — keep polling
          useGenerationStore.setState((s) => ({
            active: {
              ...s.active,
              [rfId]: { requestId, timerId: null },
            },
          }));
          scheduleNextPoll();
        }
      } catch (err) {
        // A superseded chain keeps its failure to itself — the node now
        // belongs to a newer request and is not this chain's to fail.
        if (!ownsPoll(rfId, requestId)) return;
        networkRetries += 1;
        if (networkRetries >= MAX_NETWORK_RETRIES) {
          const msg = err instanceof Error ? err.message : "network error";
          useBoardStore.getState().updateNodeData(rfId, { status: "error", error: msg });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: `Generation poll failed: ${msg}` };
          });
          return;
        }
        scheduleNextPoll();
      }
    }, 1500);

    useGenerationStore.setState((s) => ({
      active: {
        ...s.active,
        [rfId]: { requestId, timerId },
      },
    }));
  }

  // Take ownership. The ownership check alone stops the outgoing chain from
  // acting, but it can't unschedule its pending wake-up — clear that here so
  // attaching is self-contained however the caller got here.
  const outgoing = useGenerationStore.getState().active[rfId];
  if (outgoing && outgoing.timerId !== null) clearTimeout(outgoing.timerId);

  // Initialize active entry before first poll
  useGenerationStore.setState((s) => ({
    active: {
      ...s.active,
      [rfId]: { requestId, timerId: null },
    },
  }));
  scheduleNextPoll();
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

    // Release this node from whatever poll was watching it. Dropping the
    // `active` entry (not just the timer) is what makes the outgoing chain
    // bail at its next ownership check instead of running on through the
    // `createRequest` await below. It also means a dispatch that throws
    // leaves no ghost owner behind — a stale entry would block
    // `resumeActiveRequests` from ever re-attaching to this node.
    get().cancelGeneration(rfId);

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
          const ingredients = collectUpstreamRefMediaIds(rfId);
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
          const hasMulti =
            Array.isArray(opts.sourceMediaIds) && opts.sourceMediaIds.length > 0;
          if (!hasMulti && !opts.sourceMediaId) {
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
            videoParams.start_media_ids = opts.sourceMediaIds;
          } else {
            videoParams.start_media_id = opts.sourceMediaId;
          }
          reqDto = await createRequest({
            type: "gen_video",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: videoParams,
          });
        }
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

    // Start polling — same machinery the reload-resume path re-attaches.
    attachPoll(rfId, reqDto.id, {
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
    });
  },

  async resumeActiveRequests(boardId) {
    // A page reload wipes every timer this store had running, so a
    // generation dispatched before the refresh has nobody watching it. The
    // worker keeps the node's status and result current on its own now, but
    // the board still needs to know WHICH requests are still moving so the
    // card ticks over to `done` without waiting for the next manual reload.
    let items;
    try {
      ({ items } = await listBoardRequests(boardId, { active: true }));
    } catch {
      // Non-fatal: the board is usable, the affected nodes just sit on
      // whatever status the DB gave them until the next load.
      return;
    }

    for (const item of items) {
      if (item.node_id === null) continue;
      const rfId = String(item.node_id);
      // A poll we started in this session already owns this node — don't
      // stack a second one on it.
      if (get().active[rfId] !== undefined) continue;

      // Rebuild the poll's options from what the request was dispatched
      // with. This is why the endpoint ships `params`.
      const prompt =
        typeof item.params["prompt"] === "string" ? item.params["prompt"] : "";
      const aspectRatio =
        typeof item.params["aspect_ratio"] === "string"
          ? (item.params["aspect_ratio"] as string)
          : undefined;

      // Show the busy state immediately rather than waiting ~1.5s for the
      // first poll to come back. Matters most for `queued`, which the poll
      // loop deliberately doesn't stamp (it only reschedules).
      useBoardStore.getState().updateNodeData(rfId, {
        status: item.status === "running" ? "running" : "queued",
        // Only override the prompt when we actually have one — a blank
        // would wipe what the board just loaded from the DB.
        ...(prompt ? { prompt } : {}),
      });

      attachPoll(rfId, item.id, { prompt, aspectRatio });
    }
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

    get().cancelGeneration(rfId);

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

    // Same poll machinery as dispatch. A refine used to run its own copy of
    // the loop, which cost it both things `attachPoll` owns: the `ownsPoll`
    // token, and reload-resume — `resumeActiveRequests` re-attaches through
    // `attachPoll`, so a refine that only lived inside its private loop came
    // back from an F5 with nobody watching it.
    attachPoll(rfId, reqDto.id, {
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
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
