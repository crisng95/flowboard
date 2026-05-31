import { create } from "zustand";
import { runPlan as apiRunPlan, getPipelineRun, type PipelineRunDTO } from "../api/client";
import { useBoardStore } from "./board";

interface PipelineState {
  activeRun: PipelineRunDTO | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  error: string | null;

  startRun(planId: number): Promise<void>;
  stopPolling(): void;
  clearError(): void;
}

const POLL_INTERVAL_MS = 1500;
// Stop hammering a dead agent: after this many consecutive poll failures we
// surface an error and stop the loop instead of retrying forever.
const MAX_POLL_ERRORS = 8;

export const usePipelineStore = create<PipelineState>((set, get) => ({
  activeRun: null,
  pollTimer: null,
  error: null,

  async startRun(planId: number) {
    if (get().activeRun !== null) return;
    try {
      const run = await apiRunPlan(planId);
      set({ activeRun: run });
      // Pull the freshly materialised nodes onto the canvas immediately so the
      // user sees the layout before the first generation completes.
      await useBoardStore.getState().refreshBoardState();
      schedulePoll(get, set, run.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to start plan" });
    }
  },

  stopPolling() {
    const t = get().pollTimer;
    if (t !== null) clearTimeout(t);
    set({ pollTimer: null });
  },

  clearError() {
    set({ error: null });
  },
}));

function schedulePoll(
  get: () => PipelineState,
  set: (partial: Partial<PipelineState>) => void,
  runId: number,
  errorStreak = 0,
) {
  const timer = setTimeout(async () => {
    set({ pollTimer: null });
    try {
      const run = await getPipelineRun(runId);
      // Always refresh board so per-node status (queued/running/done/error)
      // and freshly-arrived mediaId values land on the canvas during the run.
      await useBoardStore.getState().refreshBoardState();
      if (run.status === "done" || run.status === "failed") {
        set({
          activeRun: null,
          error: run.status === "failed" ? run.error ?? "pipeline failed" : null,
        });
        return;
      }
      set({ activeRun: run });
      // Reset the streak on any successful poll.
      schedulePoll(get, set, runId, 0);
    } catch (err) {
      const nextStreak = errorStreak + 1;
      // Bail out after MAX_POLL_ERRORS consecutive failures so a dead agent
      // can't keep a 1.5s poll alive for the whole session. Surface the error
      // and stop instead of retrying silently forever.
      if (nextStreak >= MAX_POLL_ERRORS) {
        const msg = err instanceof Error ? err.message : "network error";
        console.warn("pipeline poll failed permanently after retries", err);
        set({
          activeRun: null,
          error: `Pipeline poll failed after ${MAX_POLL_ERRORS} retries: ${msg}`,
        });
        return;
      }
      // Transient — keep polling, carrying the incremented streak.
      console.warn(`pipeline poll failed (attempt ${nextStreak}/${MAX_POLL_ERRORS})`, err);
      schedulePoll(get, set, runId, nextStreak);
    }
  }, POLL_INTERVAL_MS);
  set({ pollTimer: timer });
}
