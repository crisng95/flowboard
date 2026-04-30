import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLlmConfig,
  getLlmProviders,
  setLlmConfig,
  type LLMConfig,
  type LLMFeature,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../api/client";
import { FeatureRoutingTable } from "./FeatureRoutingTable";
import { ProviderConnections } from "./ProviderConnections";

/**
 * Top-level wrapper for the Settings panel's AI Providers section.
 * Owns:
 *   - Initial parallel fetch of /providers + /config
 *   - Skeleton + error UI states
 *   - Periodic 30s refresh while the panel is open (catches CLI installs
 *     that happen in another terminal)
 *   - Optimistic dropdown updates with revert on backend reject
 *   - Refresh trigger when key save / clear / test happens in a row
 */

const REFRESH_INTERVAL_MS = 30_000;

export function AiProvidersSection() {
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingFeature, setSavingFeature] = useState<LLMFeature | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([getLlmProviders(), getLlmConfig()]);
      if (!aliveRef.current) return;
      setProviders(p);
      setConfig(c);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load + 30s polling while mounted. Visibility-aware: pause
  // when the tab is backgrounded so we don't burn requests.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let visibilityHandler: (() => void) | null = null;

    const start = () => {
      void refresh();
      interval = setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, REFRESH_INTERVAL_MS);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    start();
    visibilityHandler = () => {
      // When the tab becomes visible again, refresh immediately so the
      // user doesn't see stale state from the time it was hidden.
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    return () => {
      stop();
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
    };
  }, [refresh]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function handleSelect(feature: LLMFeature, name: LLMProviderName) {
    if (!config) return;
    const previous = config[feature];
    if (previous === name) return;
    // Optimistic update — revert on error.
    setConfig({ ...config, [feature]: name });
    setSavingFeature(feature);
    try {
      await setLlmConfig({ [feature]: name });
    } catch (err) {
      // Revert
      if (aliveRef.current) {
        setConfig((c) => (c ? { ...c, [feature]: previous } : c));
        showToast(
          `Couldn't save selection: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      if (aliveRef.current) setSavingFeature(null);
    }
  }

  // Loading skeleton — shown only on initial mount before either fetch
  // resolves. Keeps the layout from jumping when the data arrives.
  if (!providers && !config && !loadError) {
    return (
      <div className="settings-panel__section ai-providers-section">
        <div className="settings-panel__label">AI Providers</div>
        <div className="ai-providers-section__skeleton">
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
        </div>
      </div>
    );
  }

  if (loadError && (!providers || !config)) {
    return (
      <div className="settings-panel__section ai-providers-section">
        <div className="settings-panel__label">AI Providers</div>
        <div className="ai-providers-section__error" role="alert">
          ⚠ Couldn't load AI provider state.
          <button
            type="button"
            className="ai-providers-section__retry"
            onClick={() => void refresh()}
          >
            Retry
          </button>
          <div className="ai-providers-section__error-detail">{loadError}</div>
        </div>
      </div>
    );
  }

  // From here on `providers` and `config` are non-null.
  return (
    <div className="ai-providers-section">
      <div className="ai-providers-section__intro">
        Pick which AI powers each Flowboard feature. Claude / Gemini /
        OpenAI use your existing subscription via their official CLIs —
        no API key needed. Grok uses a direct API key (xAI hasn't shipped
        a CLI yet).
      </div>

      <FeatureRoutingTable
        config={config!}
        providers={providers!}
        onSelect={handleSelect}
        disabled={savingFeature !== null}
      />

      <ProviderConnections providers={providers!} onChanged={refresh} />

      {toast && (
        <div className="ai-providers-section__toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}
