import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import {
  useSettingsStore,
  type ImageModelKey,
  type VideoQuality,
} from "../store/settings";
import { getLatestRelease, isNewerVersion, type LatestRelease } from "../api/github";
import {
  getPinnedFlowProject,
  setPinnedFlowProject,
  type PinnedFlowProject,
} from "../api/client";
import packageJson from "../../package.json";

const APP_VERSION: string = packageJson.version;
// Loose on purpose: "is there a uuid in what they typed", not the backend's
// full project/-segment rule. Used only to enable the Save button.
const UUID_ANYWHERE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

const COMMUNITY_URL = "https://www.facebook.com/groups/flowkit.flowboard.community";

/**
 * Dashboard Settings popover anchored to the AccountPanel gear button.
 *
 * Surfaces the model context that drives every generation:
 *   - Paygate tier — read from FLOWBOARD_PAYGATE_TIER, read-only here.
 *     Flow's createProject stopped returning anything to detect it from
 *     in the September 2026 migration, so it is declared, not discovered.
 *   - Google Flow project — the single project uuid every board generates
 *     into. Server state (agent-side override on top of .env), so unlike
 *     everything else here it is fetched/PUT directly, never persisted to
 *     localStorage.
 *   - Video quality — Veo 3.1 Lite / Fast / Quality, plus Ultra-only
 *     Lite Relaxed / Fast Relaxed (0-credit low-priority queue). Applies
 *     to BOTH portrait and landscape; backend resolves
 *     [tier][quality][aspect] → concrete Flow model key.
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

// Order: lite → fast → quality (paid), then the Ultra-only relaxed
// variants (0-credit low-priority queue). Lite/Fast/Quality are
// available on both Pro (Tier 1) and Ultra (Tier 2); the *_relaxed
// entries are Ultra-only — Pro users see them locked.
const VIDEO_QUALITIES: {
  key: VideoQuality;
  label: string;
  hint: string;
  ultraOnly: boolean;
}[] = [
  {
    key: "lite",
    label: "Veo 3.1 Lite",
    hint: "Fastest generation, lightest model. Applies to both 16:9 and 9:16.",
    ultraOnly: false,
  },
  {
    key: "fast",
    label: "Veo 3.1 Fast",
    hint: "Default — balanced fidelity and speed. Applies to both 16:9 and 9:16.",
    ultraOnly: false,
  },
  {
    key: "quality",
    label: "Veo 3.1 Quality",
    hint: "Highest fidelity, slowest. Best for hero shots. Applies to both 16:9 and 9:16.",
    ultraOnly: false,
  },
  {
    key: "lite_relaxed",
    label: "Veo 3.1 Lite (Low Priority)",
    hint: "Same Lite checkpoint, low-priority queue — 0 credits. Slower turnaround when Flow is busy.",
    ultraOnly: true,
  },
];

interface SettingsPanelProps {
  open: boolean;
  onClose(): void;
  // Provided by AccountPanel. Called when the user clicks "Sign out"
  // — AccountPanel owns the post-logout state reset (clear cached
  // profile, kick the /me poll). Pass undefined when no identity is
  // loaded (the button auto-hides in that case).
  onLogout?: () => Promise<void> | void;
  // True while the parent's logout call is in flight — disables the
  // button so a double-click doesn't fire two POSTs.
  logoutPending?: boolean;
  // Called after the pinned Flow project is saved or cleared, so the
  // sidebar — which shows the same pinned id — re-reads instead of
  // displaying the value the user just replaced.
  onFlowProjectChange?: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  onLogout,
  logoutPending,
  onFlowProjectChange,
}: SettingsPanelProps) {
  const tier = useGenerationStore((s) => s.paygateTier);
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const videoModel = useSettingsStore((s) => s.videoModel);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);

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

  // Pinned Flow project. Server state — read on open and PUT on save, never
  // mirrored into the persisted settings store, because the agent (and the
  // boards it rebinds) own it, not this browser.
  const [flowProject, setFlowProject] = useState<PinnedFlowProject | null>(null);
  const [flowProjectError, setFlowProjectError] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSaveError, setProjectSaveError] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFlowProject(null);
    setFlowProjectError(null);
    setProjectSaveError(null);
    setProjectNotice(null);
    getPinnedFlowProject()
      .then((p) => {
        if (!alive) return;
        setFlowProject(p);
        setProjectDraft(p.flow_project_id ?? "");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setFlowProjectError(
          err instanceof Error ? err.message : "Could not read the pinned project",
        );
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // `null` clears the override and falls back to .env; a string pins it.
  async function saveFlowProject(next: string | null) {
    if (projectSaving) return;
    setProjectSaving(true);
    setProjectSaveError(null);
    setProjectNotice(null);
    try {
      const res = await setPinnedFlowProject(next);
      setFlowProject({
        flow_project_id: res.flow_project_id,
        source: res.source,
        env_project_id: res.env_project_id,
      });
      setProjectDraft(res.flow_project_id ?? "");
      // The generation store caches the project id for the whole page load
      // and nothing else clears it. Without this the dialog says "Saved",
      // the backend rebinds the boards, and every subsequent dispatch still
      // carries the OLD uuid — which flow_sdk takes as an explicit argument
      // and never resolves, so renders keep landing in the previous Flow
      // project with no error anywhere. Exactly the failure this whole
      // setting exists to remove, one layer up.
      useGenerationStore.setState({ projectId: null });
      setProjectNotice(
        res.rebound_boards > 0
          ? `Saved — ${res.rebound_boards} board${res.rebound_boards === 1 ? "" : "s"} re-pointed at this project`
          : "Saved",
      );
      onFlowProjectChange?.();
    } catch (err) {
      // 400 detail arrives verbatim from the backend (see setPinnedFlowProject).
      setProjectSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setProjectSaving(false);
    }
  }

  const trimmedDraft = projectDraft.trim();
  // Mirrors the backend's shape rule loosely, only to decide whether Save is
  // worth offering — the server stays the judge and its 400 is shown verbatim.
  const draftUuid = trimmedDraft.match(UUID_ANYWHERE)?.[0]?.toLowerCase() ?? null;
  // Two things had to be fixed together here.
  //
  // Comparing against the *effective* id meant a user on the .env default
  // could never turn it into a durable override — Save was permanently
  // disabled on the value the dialog was showing them. Comparing against the
  // override only fixes that.
  //
  // But doing just that opens the other half: the read path deliberately
  // accepts a legacy non-uuid `.env` value, so the dialog can be displaying
  // something the strict write path would reject. Requiring a uuid in the
  // draft is what stops the user clicking Save on the value in front of them
  // and being told it is not a Flow project ID.
  const canSaveProject =
    !!draftUuid &&
    (flowProject?.source !== "override" || draftUuid !== flowProject.flow_project_id);
  const legacyEnvId =
    flowProject?.source === "env" &&
    !!flowProject.flow_project_id &&
    !UUID_ANYWHERE.test(flowProject.flow_project_id);

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
          Set by FLOWBOARD_PAYGATE_TIER in the agent's .env — Flow stopped
          reporting the plan, so it is declared rather than detected.
        </div>
      </div>

      {/* The one uuid every board generates into. Flow dropped project
          creation + listing in the September 2026 migration, so there is no
          way to pick one from a list — the user pastes it, and until they do
          nothing can generate. */}
      <div className="settings-panel__section">
        <div className="settings-panel__label">Google Flow project</div>
        {flowProjectError ? (
          <>
            <div className="settings-panel__project-error">{flowProjectError}</div>
            <div className="settings-panel__hint">
              Close and re-open Settings to retry.
            </div>
          </>
        ) : !flowProject ? (
          <div className="settings-panel__value settings-panel__value--readonly">
            Loading…
          </div>
        ) : (
          <>
            {flowProject.source === "none" ? (
              <div className="settings-panel__project-error">
                No Flow project is configured, so every generation will fail.
                Open a project at{" "}
                <a
                  className="settings-panel__about-link"
                  href="https://flow.google.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  flow.google.com
                </a>
                , copy its uuid out of the address bar, and paste it below.
              </div>
            ) : (
              <>
                <div className="settings-panel__value settings-panel__value--readonly">
                  <code>{flowProject.flow_project_id}</code>
                </div>
                <div className="settings-panel__hint">
                  {flowProject.source === "override"
                    ? "Set here in Settings — overrides .env."
                    : "Pinned by FLOWBOARD_FLOW_PROJECT_ID in the agent's .env."}
                </div>
              </>
            )}

            <div className="settings-panel__project-row">
              <input
                type="text"
                className="settings-panel__project-input"
                value={projectDraft}
                placeholder="1dfd992a-4149-4f97-9d68-a1ede77d3fc3"
                spellCheck={false}
                autoComplete="off"
                disabled={projectSaving}
                aria-label="Flow project uuid"
                onChange={(e) => setProjectDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSaveProject) {
                    saveFlowProject(trimmedDraft);
                  }
                }}
              />
              <button
                type="button"
                className="settings-panel__project-btn"
                disabled={projectSaving || !canSaveProject}
                onClick={() => saveFlowProject(trimmedDraft)}
              >
                {projectSaving ? "Saving…" : "Save"}
              </button>
            </div>

            {legacyEnvId && (
              <div className="settings-panel__hint">
                The id in <code>.env</code> is not a uuid. It still works —
                anything already pinned keeps working — but pinning it from
                here would need a uuid, so Save stays off until you paste one.
              </div>
            )}

            {flowProject.source === "override" && (
              <button
                type="button"
                className="settings-panel__project-clear"
                disabled={projectSaving}
                onClick={() => saveFlowProject(null)}
              >
                Clear override —{" "}
                {flowProject.env_project_id
                  ? `fall back to ${flowProject.env_project_id} from .env`
                  : "leaves no project configured, so generation stops working"}
              </button>
            )}

            {projectSaveError && (
              <div className="settings-panel__project-error">{projectSaveError}</div>
            )}
            {projectNotice && !projectSaveError && (
              <div className="settings-panel__project-ok">{projectNotice}</div>
            )}

            <div className="settings-panel__hint">
              Every board generates into this project. Saving re-points the
              boards that were on the old one.
            </div>
          </>
        )}
      </div>

      {/* Single unified Video model picker — flat list of every option
          (Veo tiers + Omni Flash). Selecting a Veo row stamps both
          videoModel="veo" + the matching quality; selecting Omni Flash
          stamps videoModel="omni_flash" (duration is picked per dispatch
          in the GenerationDialog). */}
      <div className="settings-panel__section">
        <div className="settings-panel__label">Video model</div>
        <div className="settings-panel__radio-group">
          {VIDEO_QUALITIES.map((q) => {
            const locked = q.ultraOnly && tier !== "PAYGATE_TIER_TWO";
            const checked = videoModel === "veo" && videoQuality === q.key;
            return (
              <label
                key={q.key}
                className={`settings-panel__radio${checked ? " settings-panel__radio--active" : ""}${locked ? " settings-panel__radio--locked" : ""}`}
              >
                <input
                  type="radio"
                  name="video-model"
                  value={`veo:${q.key}`}
                  checked={checked}
                  disabled={locked}
                  onChange={() => {
                    setVideoModel("veo");
                    setVideoQuality(q.key);
                  }}
                />
                <div>
                  <div className="settings-panel__radio-label">
                    {q.label}
                    {q.ultraOnly && (
                      <span className="model-badge">Ultra only</span>
                    )}
                  </div>
                  <div className="settings-panel__radio-hint">{q.hint}</div>
                </div>
              </label>
            );
          })}
          <label
            className={`settings-panel__radio${videoModel === "omni_flash" ? " settings-panel__radio--active" : ""}`}
          >
            <input
              type="radio"
              name="video-model"
              value="omni_flash"
              checked={videoModel === "omni_flash"}
              onChange={() => setVideoModel("omni_flash")}
            />
            <div>
              <div className="settings-panel__radio-label">
                Omni Flash (r2v)
              </div>
              <div className="settings-panel__radio-hint">
                Reference-image to video. Variable duration (4 / 6 / 8 / 10s)
                picked per dispatch — 15 / 20 / 25 / 30 credits. Portrait +
                landscape supported.
              </div>
            </div>
          </label>
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

      {onLogout && (
        // Sign out lives here (not in the AccountPanel chip) so the
        // chip stays narrow enough for the email + status row to
        // render without ellipsizing on default sidebar widths.
        <div className="settings-panel__section settings-panel__section--logout">
          <button
            type="button"
            className="settings-panel__logout-btn"
            onClick={onLogout}
            disabled={logoutPending}
          >
            {logoutPending ? "Signing out…" : "Sign out from Flow account"}
          </button>
          <div className="settings-panel__hint">
            Clears the cached identity and tells the extension to drop
            its in-memory token. The WebSocket stays open so signing
            back in doesn't require a Chrome restart.
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

