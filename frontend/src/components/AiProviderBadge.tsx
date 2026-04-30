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
 * left of the Sponsor button. Shows the current "primary" provider +
 * an aggregate health icon; click opens the full AiProviderDialog for
 * switching / setup.
 *
 * Primary provider rule: the Auto-Prompt one. Auto-Prompt fires every
 * time the user clicks Generate without typing a prompt — the busiest
 * route in practice. Surfacing it gives the most-useful glance.
 *
 * If all 3 features map to the same provider, show that single name.
 * If they differ, show "Mixed" so the user knows there's nuance to
 * inspect (tooltip carries the full breakdown).
 *
 * Health icon:
 *   ✓ — every active provider is `available`
 *   ⚠ — at least one active provider is unconfigured (the user has
 *       it pinned but it'll fail if they dispatch in that path)
 */

const PROVIDER_LABEL: Record<LLMProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  grok: "Grok",
};

const FEATURE_LABEL: Record<keyof LLMConfig, string> = {
  auto_prompt: "Auto-Prompt",
  vision: "Vision",
  planner: "Planner",
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
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // While loading or empty, render the badge in a neutral state so the
  // toolbar layout doesn't jump when the data lands.
  const primary: LLMProviderName | null = config?.auto_prompt ?? null;
  const features = (Object.keys(config ?? {}) as (keyof LLMConfig)[]);
  const allSame =
    config !== null
      && config.auto_prompt === config.vision
      && config.vision === config.planner;
  const displayLabel = primary
    ? allSame
      ? PROVIDER_LABEL[primary]
      : "Mixed"
    : "AI";

  // Health: are all currently-pinned providers available?
  const pinned = config
    ? new Set<LLMProviderName>([config.auto_prompt, config.vision, config.planner])
    : new Set<LLMProviderName>();
  const unhealthy = providers
    ? providers.some((p) => pinned.has(p.name) && !p.available)
    : false;
  const healthIcon = primary ? (unhealthy ? "⚠" : "✓") : "";

  // Tooltip — full feature → provider mapping for hover inspection.
  const tooltip = config
    ? features
      .map((f) => `${FEATURE_LABEL[f]}: ${PROVIDER_LABEL[config[f]]}`)
      .join(" · ")
    : "AI Providers — click to configure";

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
        <span className="ai-provider-badge__label">{displayLabel}</span>
        {healthIcon && (
          <span
            className={`ai-provider-badge__status ai-provider-badge__status--${
              unhealthy ? "warn" : "ok"
            }`}
            aria-hidden="true"
          >
            {healthIcon}
          </span>
        )}
      </button>
      <AiProviderDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
