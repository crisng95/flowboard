import { useEffect, useState } from "react";
import {
  getLlmConfig,
  getLlmProviders,
  type LLMConfig,
  type LLMFeature,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../api/client";
import { AiProviderDialog } from "./AiProviderDialog";

/**
 * Compact toolbar entry point for the AI Provider stack. Sits to the
 * left of the Sponsor button. Click opens the AiProviderDialog.
 *
 * Three render states:
 *  1. Not configured — `config.configured === false` (at least one
 *     feature has no provider). Renders a "Setup AI" CTA in warning
 *     style. The forced-setup gate at the App level usually opens the
 *     dialog before the user even sees this, but the badge stays
 *     consistent if they cancel out.
 *  2. Configured + healthy — provider name + ✓ icon. Features can now
 *     run on different providers, so the label collapses to the single
 *     shared name when they agree and says "Mixed" when they don't;
 *     the per-feature detail (provider · model · effort) lives in the
 *     tooltip, which is the right place for three lines of text in a
 *     toolbar chip.
 *  3. Configured + unhealthy — name + ⚠ (a pinned CLI got uninstalled /
 *     key revoked since setup). Click to reconfigure.
 */

const PROVIDER_LABEL: Record<LLMProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
};

const FEATURE_LABEL: Record<LLMFeature, string> = {
  auto_prompt: "Auto-prompt",
  vision: "Vision",
  planner: "Planner",
};

const FEATURES: LLMFeature[] = ["auto_prompt", "vision", "planner"];

const POLL_INTERVAL_MS = 30_000;

export function AiProviderBadge() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null);

  // Light polling so the badge stays fresh when the user installs a
  // CLI in another terminal or saves a key in the dialog. Visibility-aware.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = async () => {
      try {
        const [c, p] = await Promise.all([getLlmConfig(), getLlmProviders()]);
        if (!alive) return;
        setConfig(c);
        setProviders(p);
      } catch {
        // Network blip — keep stale state, try again next tick.
      }
    };
    void refresh();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    // Match the gate: refresh immediately when Apply fires the broadcast.
    const onConfigChange = () => void refresh();
    window.addEventListener("flowboard:llm-config-changed", onConfigChange);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("flowboard:llm-config-changed", onConfigChange);
    };
  }, []);

  // Loading state — render the badge skeleton-style so the toolbar layout
  // doesn't jump when /config lands.
  if (!config) {
    return (
      <button
        type="button"
        className="ai-provider-badge ai-provider-badge--loading"
        disabled
        aria-label="AI Providers"
      >
        <span className="ai-provider-badge__icon" aria-hidden="true">🤖</span>
        <span className="ai-provider-badge__label">AI</span>
      </button>
    );
  }

  // Setup-needed state — single source of truth: the backend's
  // `configured` flag. No silent provider name to show; the CTA is the
  // whole badge content.
  if (!config.configured) {
    return (
      <>
        <button
          type="button"
          className="ai-provider-badge ai-provider-badge--setup"
          onClick={() => setOpen(true)}
          title="Pick a provider for Auto-prompt, Vision, and Planner."
          aria-label="Set up AI provider"
        >
          <span className="ai-provider-badge__icon" aria-hidden="true">🤖</span>
          <span className="ai-provider-badge__label">Setup AI</span>
          <span
            className="ai-provider-badge__status ai-provider-badge__status--warn"
            aria-hidden="true"
          >
            ⚠
          </span>
        </button>
        <AiProviderDialog open={open} onClose={() => setOpen(false)} />
      </>
    );
  }

  // Configured state. `configured=true` guarantees a provider on every
  // feature, but not the same one — collapse to a single name only when
  // all three agree.
  const pinned = FEATURES.map((f) => config[f].provider).filter(
    (name): name is LLMProviderName => name !== null,
  );
  const distinct = Array.from(new Set(pinned));
  const label = distinct.length === 1 ? PROVIDER_LABEL[distinct[0]] : "Mixed";
  const unhealthy = providers
    ? providers.some((p) => distinct.includes(p.name) && !p.available)
    : false;

  // One tooltip line per feature so the full picture (provider, model,
  // effort) is one hover away without widening the chip.
  const tooltip =
    FEATURES.map((f) => {
      const pin = config[f];
      const parts = [
        pin.provider ? PROVIDER_LABEL[pin.provider] : "—",
        pin.model ?? "default model",
        pin.effort ?? "default effort",
      ];
      return `${FEATURE_LABEL[f]}: ${parts.join(" · ")}`;
    }).join("\n")
    + (unhealthy ? "\n⚠ A pinned CLI is unavailable — click to reconfigure" : "");

  return (
    <>
      <button
        type="button"
        className={`ai-provider-badge${unhealthy ? " ai-provider-badge--warn" : ""}`}
        onClick={() => setOpen(true)}
        title={tooltip}
        aria-label="AI Providers"
      >
        <span className="ai-provider-badge__icon" aria-hidden="true">🤖</span>
        <span className="ai-provider-badge__label">{label}</span>
        <span
          className={`ai-provider-badge__status ai-provider-badge__status--${
            unhealthy ? "warn" : "ok"
          }`}
          aria-hidden="true"
        >
          {unhealthy ? "⚠" : "✓"}
        </span>
      </button>
      <AiProviderDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
