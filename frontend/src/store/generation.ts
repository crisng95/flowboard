import { create } from "zustand";
import { ensureBoardProject, createRequest, getRequest, patchNode } from "../api/client";
import { useBoardStore } from "./board";

type PollEntry = { requestId: number; timerId: ReturnType<typeof setTimeout> | null };

interface GenerationState {
  active: Record<string, PollEntry>;
  openDialog: { rfId: string | null; prompt: string };
  openViewer: { rfId: string | null };
  projectId: string | null;
  error: string | null;

  openGenerationDialog(rfId: string, prompt: string): void;
  closeGenerationDialog(): void;
  openResultViewer(rfId: string): void;
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
    },
  ): Promise<void>;

  cancelGeneration(rfId: string): void;
  clearError(): void;
}

// Walk the board to collect mediaIds of upstream character nodes feeding into
// the given image-target node. Returns [] if no characters connected.
function collectCharacterMediaIds(targetRfId: string): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const ids: string[] = [];
  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || src.data.type !== "character") continue;
    const mid = src.data.mediaId;
    if (typeof mid === "string" && mid) ids.push(mid);
  }
  return ids;
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
  active: {},
  openDialog: { rfId: null, prompt: "" },
  openViewer: { rfId: null },
  projectId: null,
  error: null,

  openGenerationDialog(rfId, prompt) {
    set({ openDialog: { rfId, prompt } });
  },

  closeGenerationDialog() {
    set({ openDialog: { rfId: null, prompt: "" } });
  },

  openResultViewer(rfId) {
    set({ openViewer: { rfId } });
  },

  closeResultViewer() {
    set({ openViewer: { rfId: null } });
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
  }) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    // Cancel existing poll for this node if any
    const existingEntry = get().active[rfId];
    if (existingEntry && existingEntry.timerId !== null) {
      clearTimeout(existingEntry.timerId);
    }

    // Optimistically update node
    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
    });

    // Create request
    const kind = opts.kind ?? "image";
    let reqDto;
    try {
      const nodeDbId = parseInt(rfId, 10);
      if (kind === "video") {
        if (!opts.sourceMediaId) {
          useBoardStore.getState().updateNodeData(rfId, { status: "error", error: "no source media" });
          set({ error: "Video generation requires a source image (connect an upstream image node)" });
          return;
        }
        reqDto = await createRequest({
          type: "gen_video",
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params: {
            prompt: opts.prompt,
            project_id: projectId,
            start_media_id: opts.sourceMediaId,
            aspect_ratio: opts.aspectRatio ?? "VIDEO_ASPECT_RATIO_LANDSCAPE",
            paygate_tier: opts.paygateTier ?? "PAYGATE_TIER_ONE",
          },
        });
      } else {
        const characterMediaIds = collectCharacterMediaIds(rfId);
        const params: Record<string, unknown> = {
          prompt: opts.prompt,
          project_id: projectId,
          aspect_ratio: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
          paygate_tier: opts.paygateTier ?? "PAYGATE_TIER_ONE",
        };
        if (characterMediaIds.length > 0) {
          params.character_media_ids = characterMediaIds;
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
            useBoardStore.getState().updateNodeData(rfId, {
              status: "done",
              mediaId,
              mediaIds,
            });
            // Persist to backend so the node survives page reload.
            const dbId = parseInt(rfId, 10);
            if (!isNaN(dbId) && mediaId) {
              const n = useBoardStore.getState().nodes.find((x) => x.id === rfId);
              const d = n?.data;
              patchNode(dbId, {
                status: "done",
                data: {
                  title: d?.title,
                  prompt: d?.prompt,
                  thumbnailUrl: d?.thumbnailUrl,
                  mediaId,
                  mediaIds,
                },
              }).catch(() => {
                // Non-fatal: the in-memory state is still correct for this session.
              });
            }
            set((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next };
            });
            get().openResultViewer(rfId);
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
