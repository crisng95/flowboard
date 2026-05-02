import { useEffect, useState } from "react";
import {
  getLlmConfig,
  getLlmProviders,
  type LLMConfig,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../api/client";
import { AiProviderDialog } from "./AiProviderDialog";

/**
 * Compact toolbar entry point for the AI Provider stack. Sits to the
 * left of the Sponsor button. Click opens the AiProviderDialog.
 *
 * Three render states:
 *  1. Not configured — `config.configured === false`. Renders a
 *     "Setup AI" CTA in warning style. The forced-setup gate at the App
 *     level usually opens the dialog before the user even sees this,
 *     but the badge stays consistent if they cancel out.
 *  2. Configured + healthy — single provider name + ✓ icon.
 *  3. Configured + unhealthy — single provider name + ⚠ (CLI got
 *     uninstalled / key revoked since setup). Click to reconfigure.
 */

const PROVIDER_LABEL: Record<LLMProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
};

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
          title="Pick an AI provider to power Auto-Prompt, Vision, and Planner."
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

  // Configured state — single-provider model means all 3 features point
  // at the same name; pick auto_prompt as the canonical one (already
  // guaranteed equal to vision/planner by the configured invariant).
  const primary = config.auto_prompt as LLMProviderName;
  const pinned = new Set<LLMProviderName>([
    primary,
    config.vision as LLMProviderName,
    config.planner as LLMProviderName,
  ]);
  const unhealthy = providers
    ? providers.some((p) => pinned.has(p.name) && !p.available)
    : false;

  const tooltip =
    `${PROVIDER_LABEL[primary]} powers Auto-Prompt, Vision, Planner`
    + (unhealthy ? " · CLI unavailable — click to reconfigure" : "");

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
        <span className="ai-provider-badge__label">{PROVIDER_LABEL[primary]}</span>
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
