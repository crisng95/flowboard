import { create } from "zustand";

/**
 * Per-user model preferences. Survives page reload via localStorage —
 * single-user, single-host app, so no need for server persistence.
 *
 * Image model: Flow ships two checkpoints — "NANO_BANANA_PRO" (premium,
 * higher quality, slower) and "NANO_BANANA_2" (faster, lighter). Users
 * pick once in the dashboard Settings panel; every gen_image / edit_image
 * dispatch reads the cached preference and forwards it to the worker.
 *
 * Video model is currently derived from paygate tier + aspect (resolved
 * server-side via VIDEO_MODEL_KEYS), so it's a *display* on the panel
 * rather than a switchable preference. When/if Flow ships variants per
 * tier (e.g. fast vs quality) we extend this store with `videoModelKey`.
 */
export type ImageModelKey = "NANO_BANANA_PRO" | "NANO_BANANA_2";
// Veo 3.1 ships in two flavours: Fast (current default — bigger model,
// higher fidelity) and Lite (smaller checkpoint, much faster, lower
// fidelity). Choice applies globally across both portrait and
// landscape — backend resolves the actual model key at dispatch time
// from [tier][quality][aspect].
export type VideoQuality = "fast" | "lite";

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
