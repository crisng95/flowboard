import type {
  LLMFeatureConfig,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderName,
} from "../../api/client";

/**
 * One feature's pin — provider → model → effort — plus a Test button
 * that pings exactly the combination the row is about to save.
 *
 * Why per-feature instead of the old single-provider card row: the
 * three features have genuinely different cost/latency profiles.
 * Auto-prompt runs on every node and wants a cheap fast model; Planner
 * runs once per board and is worth a slow expensive one; Vision is
 * constrained to providers that can actually read an image. Forcing all
 * three onto one provider/model made the user optimise for the worst
 * case.
 *
 * Everything selectable here is rendered from the provider payload —
 * `efforts` and `models` differ per provider (Claude has low…max,
 * agy has low/medium/high, Codex reports its own), so nothing about
 * the vocabulary is hardcoded in the UI.
 */

export type FeatureTestState = "untested" | "testing" | "ok" | "fail";

export interface FeatureTest {
  state: FeatureTestState;
  latencyMs?: number;
  error?: string;
}

interface FeatureConfigRowProps {
  title: string;
  blurb: string;
  /** Providers selectable for this feature. Vision receives a list with
   * the non-vision providers already filtered out by the parent. */
  options: LLMProviderInfo[];
  /** Record for `value.provider`, resolved against the FULL provider
   * list rather than `options`: a stale config can pin a provider that
   * `options` excludes (Vision pinned at a provider that later dropped
   * image support), and we render it rather than silently swapping the
   * user's choice out from under them. */
  selected: LLMProviderInfo | null;
  value: LLMFeatureConfig;
  /** Catalog for `value.provider` — the ⟳ refresh overlay when the user
   * asked for one, otherwise whatever GET /providers shipped. */
  models: LLMModelInfo[];
  modelsRefreshing: boolean;
  test: FeatureTest;
  providerLabel(name: LLMProviderName): string;
  /** Separate from onPatch because switching providers has to reset
   * model + effort to the new provider's defaults, and only the parent
   * holds the provider records those defaults come from. */
  onProviderChange(name: LLMProviderName): void;
  onPatch(patch: Partial<LLMFeatureConfig>): void;
  onTest(): void;
  onRefreshModels(): void;
  onSetupHelp(): void;
}

export function FeatureConfigRow({
  title,
  blurb,
  options,
  selected,
  value,
  models,
  modelsRefreshing,
  test,
  providerLabel,
  onProviderChange,
  onPatch,
  onTest,
  onRefreshModels,
  onSetupHelp,
}: FeatureConfigRowProps) {
  const hasProvider = selected !== null;
  const ready = hasProvider && selected.available && selected.configured;
  const efforts = selected?.supportsEffort ? selected.efforts : [];
  // A pinned provider that `options` filtered out (see `selected` docs)
  // still needs an entry in the select, otherwise the control would
  // render blank and the first interaction would silently rewrite it.
  const offListProvider =
    hasProvider && !options.some((p) => p.name === selected.name)
      ? selected.name
      : null;
  // Same story for the model: the user's saved id can be absent from a
  // freshly-fetched catalog (model retired, catalog partial). Keep it
  // as an option so re-saving doesn't quietly downgrade them.
  const offListModel =
    value.model && !models.some((m) => m.id === value.model)
      ? value.model
      : null;

  return (
    <div className="feature-config-row">
      <div className="feature-config-row__head">
        <span className="feature-config-row__title">{title}</span>
        <span className="feature-config-row__blurb">{blurb}</span>
      </div>

      <div className="feature-config-row__controls">
        <label className="feature-config-row__field">
          <span className="feature-config-row__label">Provider</span>
          <select
            className="gen-dialog__select"
            value={value.provider ?? ""}
            onChange={(e) => onProviderChange(e.target.value as LLMProviderName)}
          >
            {!value.provider && (
              <option value="" disabled>
                Choose…
              </option>
            )}
            {options.map((p) => (
              <option key={p.name} value={p.name}>
                {providerLabel(p.name)}
                {p.available && p.configured ? "" : " · setup needed"}
              </option>
            ))}
            {offListProvider && (
              <option value={offListProvider}>
                {providerLabel(offListProvider)} · no vision support
              </option>
            )}
          </select>
        </label>

        <label className="feature-config-row__field">
          <span className="feature-config-row__label">Model</span>
          {models.length > 0 ? (
            <select
              className="gen-dialog__select"
              value={value.model ?? ""}
              disabled={!hasProvider}
              onChange={(e) => onPatch({ model: e.target.value || null })}
            >
              <option value="">
                {selected?.defaultModel
                  ? `Default · ${selected.defaultModel}`
                  : "Provider default"}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {offListModel && (
                <option value={offListModel}>{offListModel} · not in catalog</option>
              )}
            </select>
          ) : (
            // Catalog fetch failed or the CLI doesn't publish one — a
            // free-text id keeps the user moving instead of blocking
            // them on a list we couldn't load.
            <input
              type="text"
              className="feature-config-row__model-input"
              value={value.model ?? ""}
              disabled={!hasProvider}
              placeholder={selected?.defaultModel ?? "provider default"}
              onChange={(e) => onPatch({ model: e.target.value.trim() || null })}
            />
          )}
        </label>

        <label className="feature-config-row__field feature-config-row__field--effort">
          <span className="feature-config-row__label">Effort</span>
          {efforts.length > 0 ? (
            <select
              className="gen-dialog__select"
              value={value.effort ?? ""}
              onChange={(e) => onPatch({ effort: e.target.value || null })}
            >
              <option value="">Default</option>
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          ) : (
            <span
              className="feature-config-row__na"
              title={
                hasProvider
                  ? `${providerLabel(selected.name)} doesn't expose effort levels.`
                  : "Pick a provider first."
              }
            >
              —
            </span>
          )}
        </label>

        <div className="feature-config-row__buttons">
          <button
            type="button"
            className="feature-test-row__btn"
            onClick={onRefreshModels}
            disabled={!hasProvider || modelsRefreshing}
            title="Re-fetch this provider's model list from the CLI."
            aria-label="Refresh model list"
          >
            {modelsRefreshing ? "⟳…" : "⟳"}
          </button>
          <button
            type="button"
            className="feature-test-row__btn"
            onClick={onTest}
            disabled={!hasProvider || test.state === "testing"}
            title="Send one tiny prompt through this exact provider/model/effort."
          >
            {test.state === "testing"
              ? "Testing…"
              : test.state === "untested"
                ? "Test"
                : "Re-test"}
          </button>
        </div>
      </div>

      <div className="feature-config-row__status">
        {test.state === "ok" && (
          <span className="feature-test-row__latency">
            ✓ Connected · {test.latencyMs ?? "?"}ms
          </span>
        )}
        {test.state === "fail" && (
          <span className="feature-test-row__error">✗ {test.error}</span>
        )}
        {test.state === "testing" && (
          <span className="feature-test-row__hint">Pinging the CLI…</span>
        )}
        {test.state === "untested" && !hasProvider && (
          <span className="feature-test-row__hint">
            No provider pinned — this feature can't run yet.
          </span>
        )}
        {test.state === "untested" && ready && (
          <span className="feature-test-row__hint">
            Not tested. Testing is optional — Apply saves either way.
          </span>
        )}
        {hasProvider && !ready && (
          // Shown regardless of test state: an unavailable CLI is the
          // thing to fix first, and it explains any test failure above.
          <span className="feature-config-row__setup">
            <span className="feature-test-row__error">
              {selected.lastError === "not_authenticated"
                ? `${providerLabel(selected.name)} CLI is installed but not signed in.`
                : `${providerLabel(selected.name)} CLI isn't ready.`}
            </span>
            <button
              type="button"
              className="selection-panel__setup-btn"
              onClick={onSetupHelp}
            >
              Setup help →
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
