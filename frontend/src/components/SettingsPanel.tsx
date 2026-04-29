import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import {
  useSettingsStore,
  type ImageModelKey,
  type VideoQuality,
} from "../store/settings";
import { getLatestRelease, isNewerVersion, type LatestRelease } from "../api/github";
import packageJson from "../../package.json";

const APP_VERSION: string = packageJson.version;
const COMMUNITY_URL = "https://www.facebook.com/groups/flowkit.flowboard.community";

/**
 * Dashboard Settings popover anchored to the AccountPanel gear button.
 *
 * Surfaces the model context that drives every generation:
 *   - Paygate tier — auto-detected from Flow's createProject response,
 *     read-only (this isn't user-selectable, it's a fact of their plan).
 *   - Video quality — Veo 3.1 Fast vs Lite. Applies to BOTH portrait
 *     and landscape; backend resolves [tier][quality][aspect] →
 *     concrete Flow model key.
 *   - Image model — Banana Pro vs Banana 2 picker. Persisted to
 *     localStorage; every gen_image / edit_image dispatch reads it.
 */

const IMAGE_MODELS: { key: ImageModelKey; label: string; hint: string }[] = [
  {
    key: "NANO_BANANA_PRO",
    label: "Nano Banana Pro",
    hint: "GEM_PIX_2 — premium, higher fidelity, slightly slower",
  },
  {
    key: "NANO_BANANA_2",
    label: "Nano Banana 2",
    hint: "NARWHAL — faster, lighter checkpoint",
  },
];

const VIDEO_QUALITIES: { key: VideoQuality; label: string; hint: string }[] = [
  {
    key: "fast",
    label: "Veo 3.1 Fast",
    hint: "Higher fidelity, default quality. Applies to both 16:9 and 9:16.",
  },
  {
    key: "lite",
    label: "Veo 3.1 Lite",
    hint: "Faster generation, lighter model. Applies to both 16:9 and 9:16.",
  },
];

interface SettingsPanelProps {
  open: boolean;
  onClose(): void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const tier = useGenerationStore((s) => s.paygateTier);
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);

  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes (click-outside is handled by the backdrop's onClick).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Check GitHub for a newer release. Cached in sessionStorage by
  // the helper, so re-opening the dialog doesn't burn API quota.
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getLatestRelease().then((r) => {
      if (alive) setLatestRelease(r);
    });
    return () => {
      alive = false;
    };
  }, [open]);
  const updateAvailable =
    !!latestRelease?.tagName &&
    isNewerVersion(latestRelease.tagName, APP_VERSION);

  if (!open) return null;

  const tierLabel = tier === "PAYGATE_TIER_TWO"
    ? "Ultra"
    : tier === "PAYGATE_TIER_ONE"
      ? "Pro"
      : "Detecting…";

  return (
    <div
      className="settings-panel-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="settings-panel__header">
        <span className="settings-panel__title">Settings</span>
        <button
          type="button"
          className="settings-panel__close"
          onClick={onClose}
          aria-label="Close settings"
        >
          ×
        </button>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">Account tier</div>
        <div className="settings-panel__value settings-panel__value--readonly">
          {tierLabel}
        </div>
        <div className="settings-panel__hint">
          Auto-detected from Google Flow when the first project loads.
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">Video model</div>
        <div className="settings-panel__radio-group">
          {VIDEO_QUALITIES.map((q) => (
            <label
              key={q.key}
              className={`settings-panel__radio${videoQuality === q.key ? " settings-panel__radio--active" : ""}`}
            >
              <input
                type="radio"
                name="video-quality"
                value={q.key}
                checked={videoQuality === q.key}
                onChange={() => setVideoQuality(q.key)}
              />
              <div>
                <div className="settings-panel__radio-label">{q.label}</div>
                <div className="settings-panel__radio-hint">{q.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">Image model</div>
        <div className="settings-panel__radio-group">
          {IMAGE_MODELS.map((m) => (
            <label
              key={m.key}
              className={`settings-panel__radio${imageModel === m.key ? " settings-panel__radio--active" : ""}`}
            >
              <input
                type="radio"
                name="image-model"
                value={m.key}
                checked={imageModel === m.key}
                onChange={() => setImageModel(m.key)}
              />
              <div>
                <div className="settings-panel__radio-label">{m.label}</div>
                <div className="settings-panel__radio-hint">{m.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__label">About</div>
        <div className="settings-panel__about-row">
          <span className="settings-panel__about-key">Version</span>
          <span className="settings-panel__about-value">
            <code>v{APP_VERSION}</code>
            {updateAvailable && latestRelease && (
              <a
                className="settings-panel__update-badge"
                href={latestRelease.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`Latest: ${latestRelease.tagName}`}
              >
                New version {latestRelease.tagName} →
              </a>
            )}
          </span>
        </div>
        <div className="settings-panel__about-row">
          <span className="settings-panel__about-key">Community</span>
          <a
            className="settings-panel__about-link"
            href={COMMUNITY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            FlowKit & Flowboard on Facebook →
          </a>
        </div>
      </div>
      </div>
    </div>
  );
}

