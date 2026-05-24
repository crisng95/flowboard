import { create } from "zustand";

/**
 * Per-user model preferences. Survives page reload via localStorage —
 * single-user, single-host app, so no need for server persistence.
 *
 * Image model: Flow ships three checkpoints — "NANO_BANANA_PRO" (premium,
 * higher quality, slower), "NANO_BANANA_2" (faster, lighter), and
 * "NANO_OMNI" (next-gen unified model, ultra-high fidelity and context
 * awareness). Users pick once in the dashboard Settings panel; every
 * gen_image / edit_image dispatch reads the cached preference and
 * forwards it to the worker.
 *
 * Video model is currently derived from paygate tier + aspect (resolved
 * server-side via VIDEO_MODEL_KEYS), so it's a *display* on the panel
 * rather than a switchable preference. When/if Flow ships variants per
 * tier (e.g. fast vs quality) we extend this store with `videoModelKey`.
 */
export type ImageModelKey = "NANO_BANANA_PRO" | "NANO_BANANA_2" | "NANO_OMNI";
// Veo 3.1 ships in five flavours:
//   - Lite (smaller checkpoint, fastest, lower fidelity)
//   - Fast (default — bigger model, balanced)
//   - Quality (highest fidelity, slowest)
//   - Lite Relaxed (Lite on a low-priority queue, 0 credits — Ultra only)
//   - Fast Relaxed (Fast on a low-priority queue, 0 credits — Ultra only)
// Choice applies globally across both portrait and landscape; backend
// resolves the actual model key at dispatch time from [tier][quality][aspect].
// Tier 1 (Pro) users picking either *_relaxed* fall back to Fast on the
// backend (and the Settings UI locks those radios for them).
export type VideoQuality =
  | "fast"
  | "lite"
  | "quality"
  | "lite_relaxed"
  | "fast_relaxed";

interface SettingsState {
  imageModel: ImageModelKey;
  videoQuality: VideoQuality;
  setImageModel(model: ImageModelKey): void;
  setVideoQuality(q: VideoQuality): void;
}

const STORAGE_KEY = "flowboard.settings.v1";

interface PersistShape {
  imageModel?: ImageModelKey;
  videoQuality?: VideoQuality;
}

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled / quota — non-fatal, just lose persistence.
  }
}

const persisted = loadPersisted();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  imageModel: persisted.imageModel ?? "NANO_BANANA_PRO",
  videoQuality: persisted.videoQuality ?? "fast",
  setImageModel(model) {
    set({ imageModel: model });
    persist({
      imageModel: model,
      videoQuality: get().videoQuality,
    });
  },
  setVideoQuality(q) {
    set({ videoQuality: q });
    persist({
      imageModel: get().imageModel,
      videoQuality: q,
    });
  },
}));
