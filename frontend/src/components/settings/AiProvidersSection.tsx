import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLlmConfig,
  getLlmProviderModels,
  getLlmProviders,
  setLlmConfig,
  testLlmProvider,
  type LLMConfig,
  type LLMConfigUpdate,
  type LLMFeature,
  type LLMFeatureConfig,
  type LLMModelInfo,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../api/client";
import { FeatureConfigRow, type FeatureTest } from "./FeatureConfigRow";
import { ProviderSetupModal } from "./ProviderSetupModal";

/**
 * Per-feature provider configuration. Each of Auto-prompt / Vision /
 * Planner independently picks a provider, a model and an effort level.
 *
 * Why the single-provider model was dropped: it forced one decision to
 * serve three very different jobs. Auto-prompt fires on every node and
 * wants something cheap and fast; Planner runs once per board and is
 * worth a slow expensive model; Vision only works on providers that can
 * read an image at all. One row per feature costs a little more screen
 * space and removes the compromise.
 *
 * "Configured" now means every feature has a provider — model and
 * effort stay optional (null = let the provider pick its default), so
 * a user who doesn't care about model choice can finish setup with
 * three provider picks.
 *
 * Draft vs. saved state: the three rows edit a local `draft` that is
 * seeded once from /config and re-seeded after Apply. The 30s poll
 * deliberately never overwrites it — a background refresh landing
 * mid-edit and resetting the user's half-made selection would be
 * maddening.
 *
 * CLI-only philosophy: only OAuth-CLI providers are surfaced
 * (Claude Code / Gemini via the agy CLI / OpenAI Codex).
 */

const REFRESH_INTERVAL_MS = 30_000;
// Order matters — this is the option order in every provider select.
// Gemini first (lowest install friction), Claude middle, Codex last.
const SHOWN_PROVIDERS: LLMProviderName[] = ["gemini", "claude", "openai"];
const FEATURES: LLMFeature[] = ["auto_prompt", "vision", "planner"];

const FEATURE_META: Record<LLMFeature, { title: string; blurb: string }> = {
  auto_prompt: {
    title: "Auto-prompt",
    blurb: "Expands a short idea into a full image / video prompt. Runs often — favour speed.",
  },
  vision: {
    title: "Vision",
    blurb: "Describes uploaded images. Only vision-capable providers are listed.",
  },
  planner: {
    title: "Planner",
    blurb: "Breaks a goal into a board of connected nodes. Runs rarely — favour quality.",
  },
};

// Gemini is labelled with its CLI because the binary is `agy`, not
// `gemini` — users who go looking for the process need that hint.
const PROVIDER_LABEL: Record<LLMProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini (agy)",
  openai: "OpenAI (Codex)",
};

const UNTESTED: FeatureTest = { state: "untested" };
const INITIAL_TESTS: Record<LLMFeature, FeatureTest> = {
  auto_prompt: UNTESTED,
  vision: UNTESTED,
  planner: UNTESTED,
};

type Draft = Record<LLMFeature, LLMFeatureConfig>;

function draftFrom(config: LLMConfig): Draft {
  // Structural copy — the draft is mutated by the rows and must not
  // alias the fetched config (which `dirty` compares against).
  return {
    auto_prompt: { ...config.auto_prompt },
    vision: { ...config.vision },
    planner: { ...config.planner },
  };
}

function sameFeature(a: LLMFeatureConfig, b: LLMFeatureConfig): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/** Effort default when the user switches providers. The backend has no
 * `defaultEffort` field, so we pick the middle of the road: "medium"
 * when the provider offers it, otherwise the first level it reports. */
function defaultEffortFor(p: LLMProviderInfo | undefined): string | null {
  if (!p || !p.supportsEffort || p.efforts.length === 0) return null;
  return p.efforts.includes("medium") ? "medium" : p.efforts[0];
}

export function AiProvidersSection() {
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Local edits, seeded from /config (see the draft note in the header).
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tests, setTests] = useState<Record<LLMFeature, FeatureTest>>(INITIAL_TESTS);
  // Catalogs fetched via the ⟳ button, overlaid on top of whatever
  // GET /providers shipped. Keyed by provider so two features sharing a
  // provider share the refreshed list.
  const [catalogs, setCatalogs] = useState<
    Partial<Record<LLMProviderName, LLMModelInfo[]>>
  >({});
  // Tracked per provider rather than as one global flag: two rows on
  // different providers can refresh at the same time, and two rows on
  // the SAME provider must both show the spinner (they share a catalog).
  const [refreshingModels, setRefreshingModels] = useState<
    Partial<Record<LLMProviderName, boolean>>
  >({});
  const [applying, setApplying] = useState(false);
  const [helpFor, setHelpFor] = useState<LLMProviderName | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<LLMConfig | null> => {
    try {
      const [p, c] = await Promise.all([getLlmProviders(), getLlmConfig()]);
      if (!aliveRef.current) return null;
      setProviders(p);
      setConfig(c);
      setLoadError(null);
      return c;
    } catch (err) {
      if (!aliveRef.current) return null;
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Initial load + 30s polling, visibility-aware.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  // Seed the draft the first time /config lands. Guarded on
  // `draft === null` so later polls leave in-progress edits alone.
  useEffect(() => {
    if (draft !== null || config === null) return;
    setDraft(draftFrom(config));
  }, [config, draft]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function patchFeature(feature: LLMFeature, patch: Partial<LLMFeatureConfig>) {
    setDraft((prev) => (prev ? { ...prev, [feature]: { ...prev[feature], ...patch } } : prev));
  }

  function handleProviderChange(feature: LLMFeature, name: LLMProviderName) {
    const info = providers?.find((p) => p.name === name);
    // Model + effort belong to the provider that offered them, so a
    // provider switch resets both to that provider's defaults rather
    // than carrying over an id the new CLI has never heard of.
    patchFeature(feature, {
      provider: name,
      model: info?.defaultModel ?? null,
      effort: defaultEffortFor(info),
    });
    // The previous test result was against a different target.
    setTests((prev) => ({ ...prev, [feature]: UNTESTED }));
  }

  function catalogFor(name: LLMProviderName | null): LLMModelInfo[] {
    if (!name) return [];
    return catalogs[name] ?? providers?.find((p) => p.name === name)?.models ?? [];
  }

  async function refreshModels(name: LLMProviderName) {
    if (refreshingModels[name]) return;
    setRefreshingModels((prev) => ({ ...prev, [name]: true }));
    try {
      const { models } = await getLlmProviderModels(name, true);
      if (!aliveRef.current) return;
      setCatalogs((prev) => ({ ...prev, [name]: models }));
      showToast(
        models.length > 0
          ? `${PROVIDER_LABEL[name]}: ${models.length} models.`
          : `${PROVIDER_LABEL[name]} returned no models — type a model id instead.`,
      );
    } catch (err) {
      showToast(
        `Couldn't refresh models: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (aliveRef.current) {
        setRefreshingModels((prev) => ({ ...prev, [name]: false }));
      }
    }
  }

  async function runTest(feature: LLMFeature) {
    const pin = draft?.[feature];
    if (!pin?.provider) return;
    setTests((prev) => ({ ...prev, [feature]: { state: "testing" } }));
    // Tests carry the row's exact model + effort: a provider that
    // answers on its default model can still fail on an exotic one.
    const result = await testLlmProvider(pin.provider, {
      model: pin.model,
      effort: pin.effort,
    });
    if (!aliveRef.current) return;
    setTests((prev) => ({
      ...prev,
      [feature]: result.ok
        ? { state: "ok", latencyMs: result.latencyMs }
        : { state: "fail", error: result.error || "test failed" },
    }));
  }

  async function handleApply() {
    if (!draft || applying) return;
    setApplying(true);
    try {
      const body: LLMConfigUpdate = {};
      for (const feature of FEATURES) {
        const pin = draft[feature];
        // A feature with no provider has nothing to pin — leave it out
        // rather than PUTting a null the backend would have to special
        // case. model/effort DO go out as null when unset: that's the
        // signal for "use the provider default", and omitting them
        // would leave a stale id from the previous provider in place.
        if (!pin.provider) continue;
        body[feature] = { provider: pin.provider, model: pin.model, effort: pin.effort };
      }
      await setLlmConfig(body);
      showToast("AI provider settings saved.");
      const fresh = await refresh();
      if (fresh && aliveRef.current) setDraft(draftFrom(fresh));
      // Broadcast so the badge + ForcedSetupGate refresh immediately
      // instead of waiting up to 30s for their own poll. Plain window
      // event keeps the contract loose — anyone interested subscribes,
      // no shared store coupling.
      window.dispatchEvent(new CustomEvent("flowboard:llm-config-changed"));
    } catch (err) {
      showToast(
        `Couldn't apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }

  // ── Render guards ───────────────────────────────────────────────

  if ((!providers || !config || !draft) && !loadError) {
    return (
      <div className="ai-providers-section">
        <div className="ai-providers-section__skeleton">
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
        </div>
      </div>
    );
  }

  if (loadError && (!providers || !config || !draft)) {
    return (
      <div className="ai-providers-section">
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

  // Past this point providers / config / draft are all non-null.
  const allProviders = providers!;
  const currentDraft = draft!;
  const ordered = SHOWN_PROVIDERS.map((name) =>
    allProviders.find((p) => p.name === name),
  ).filter((p): p is LLMProviderInfo => p !== undefined);
  const visionCapable = ordered.filter((p) => p.supportsVision);

  const missing = FEATURES.filter((f) => !currentDraft[f].provider);
  const dirty = FEATURES.some((f) => !sameFeature(currentDraft[f], config![f]));

  return (
    <div className="ai-providers-section">
      <div className="ai-providers-section__intro">
        Each feature picks its own provider, model and effort. Cheap and
        fast where it runs often, slow and strong where it matters.
      </div>

      {missing.length > 0 && (
        // Setup isn't complete until every feature has a provider —
        // that's exactly what the backend's `configured` flag (and the
        // forced-setup gate) keys off.
        <div className="ai-providers-section__mixed-notice" role="alert">
          ⓘ Still unset: {missing.map((f) => FEATURE_META[f].title).join(", ")}.
          Pick a provider for each, then Apply.
        </div>
      )}

      <div className="feature-config-list">
        {FEATURES.map((feature) => {
          const pin = currentDraft[feature];
          const options = feature === "vision" ? visionCapable : ordered;
          // Resolved against the full list, not `options` — see the
          // `selected` prop docs on FeatureConfigRow.
          const selected = pin.provider
            ? allProviders.find((p) => p.name === pin.provider) ?? null
            : null;
          return (
            <FeatureConfigRow
              key={feature}
              title={FEATURE_META[feature].title}
              blurb={FEATURE_META[feature].blurb}
              options={options}
              selected={selected}
              value={pin}
              models={catalogFor(pin.provider)}
              modelsRefreshing={pin.provider ? refreshingModels[pin.provider] === true : false}
              test={tests[feature]}
              providerLabel={(name) => PROVIDER_LABEL[name]}
              onProviderChange={(name) => handleProviderChange(feature, name)}
              onPatch={(patch) => patchFeature(feature, patch)}
              onTest={() => void runTest(feature)}
              onRefreshModels={() => {
                if (pin.provider) void refreshModels(pin.provider);
              }}
              onSetupHelp={() => setHelpFor(pin.provider)}
            />
          );
        })}
      </div>

      <div className="selection-panel__actions">
        <button
          type="button"
          className="selection-panel__apply-btn"
          onClick={handleApply}
          disabled={!dirty || applying}
          title={
            dirty
              ? "Save these provider / model / effort pins."
              : "Nothing changed since the last save."
          }
        >
          {applying ? "Applying…" : dirty ? "Apply changes" : "Saved"}
        </button>
      </div>

      {toast && (
        <div className="ai-providers-section__toast" role="alert">
          {toast}
        </div>
      )}

      <ProviderSetupModal
        provider={helpFor ?? "claude"}
        open={helpFor !== null}
        onClose={() => setHelpFor(null)}
      />
    </div>
  );
}
