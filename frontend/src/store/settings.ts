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
 * Video settings now split into:
 *   - `videoModel`: family selector (`veo` or `omni_flash`)
 *   - `videoQuality`: Veo-only quality tier
 *   - `omniFlashDuration`: Omni-only duration, chosen per dispatch but
 *     persisted so the dialog stays sticky across opens.
 */
export type ImageModelKey = "NANO_BANANA_PRO" | "NANO_BANANA_2" | "NANO_OMNI";
export type ActiveImageModelKey = Exclude<ImageModelKey, "NANO_OMNI">;
export const ACTIVE_IMAGE_MODELS: ActiveImageModelKey[] = ["NANO_BANANA_PRO", "NANO_BANANA_2"];

// Veo 3.1 ships in four surfaced flavours:
//   - Lite (smaller checkpoint, fastest, lower fidelity)
//   - Fast (default — bigger model, balanced)
//   - Quality (highest fidelity, slowest)
//   - Lite Relaxed (Lite on a low-priority queue, 0 credits — Ultra only)
// `fast_relaxed` is intentionally buried; stale persisted values are
// normalized back to `fast` on hydrate below.
export type VideoQuality =
  | "fast"
  | "lite"
  | "quality"
  | "lite_relaxed";

export type VideoModelFamily = "veo" | "omni_flash";

export const OMNI_FLASH_CREDIT_COST: Record<4 | 6 | 8 | 10, number> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};

export type OmniFlashDuration = 4 | 6 | 8 | 10;
export const OMNI_FLASH_DURATIONS: OmniFlashDuration[] = [4, 6, 8, 10];

interface SettingsState {
  imageModel: ImageModelKey;
  videoQuality: VideoQuality;
  videoModel: VideoModelFamily;
  omniFlashDuration: OmniFlashDuration;
  setImageModel(model: ImageModelKey): void;
  setVideoQuality(q: VideoQuality): void;
  setVideoModel(m: VideoModelFamily): void;
  setOmniFlashDuration(d: OmniFlashDuration): void;
}

const STORAGE_KEY = "flowboard.settings.v1";

interface PersistShape {
  imageModel?: ImageModelKey;
  videoQuality?: VideoQuality;
  videoModel?: VideoModelFamily;
  omniFlashDuration?: OmniFlashDuration;
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
const VALID_VIDEO_QUALITIES: VideoQuality[] = ["fast", "lite", "quality", "lite_relaxed"];

export function normalizeImageModelKey(model?: string | null): ActiveImageModelKey {
  if (model === "NANO_BANANA_2") return "NANO_BANANA_2";
  return "NANO_BANANA_PRO";
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  imageModel: normalizeImageModelKey(persisted.imageModel),
  videoQuality:
    persisted.videoQuality && VALID_VIDEO_QUALITIES.includes(persisted.videoQuality)
      ? persisted.videoQuality
      : "fast",
  videoModel: persisted.videoModel ?? "veo",
  omniFlashDuration: persisted.omniFlashDuration ?? 4,
  setImageModel(model) {
    const normalized = normalizeImageModelKey(model);
    set({ imageModel: normalized });
    persist({
      imageModel: normalized,
      videoQuality: get().videoQuality,
      videoModel: get().videoModel,
      omniFlashDuration: get().omniFlashDuration,
    });
  },
  setVideoQuality(q) {
    set({ videoQuality: q });
    persist({
      imageModel: get().imageModel,
      videoQuality: q,
      videoModel: get().videoModel,
      omniFlashDuration: get().omniFlashDuration,
    });
  },
  setVideoModel(m) {
    set({ videoModel: m });
    persist({
      imageModel: get().imageModel,
      videoQuality: get().videoQuality,
      videoModel: m,
      omniFlashDuration: get().omniFlashDuration,
    });
  },
  setOmniFlashDuration(d) {
    set({ omniFlashDuration: d });
    persist({
      imageModel: get().imageModel,
      videoQuality: get().videoQuality,
      videoModel: get().videoModel,
      omniFlashDuration: d,
    });
  },
}));
