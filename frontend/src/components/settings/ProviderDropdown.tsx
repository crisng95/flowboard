import type { LLMFeature, LLMProviderInfo, LLMProviderName } from "../../api/client";

/**
 * Single feature → provider dropdown. Used 3× by FeatureRoutingTable
 * (Auto-Prompt / Vision / Planner).
 *
 * Behavior per the plan UI Spec:
 *   - Disabled options for providers where `available === false` (with
 *     a tooltip pointing to the Provider connections subsection).
 *   - Vision dropdown specifically filters out non-vision providers.
 *     All 4 currently support vision; the filter is forward-compat.
 *   - Selection commits optimistically; parent reverts on backend reject.
 */

interface ProviderDropdownProps {
  feature: LLMFeature;
  value: LLMProviderName;
  providers: LLMProviderInfo[];
  onChange(name: LLMProviderName): void;
  disabled?: boolean;
}

const FEATURE_LABEL: Record<LLMFeature, string> = {
  auto_prompt: "Auto-Prompt",
  vision: "Vision",
  planner: "Planner",
};

const PROVIDER_LABEL: Record<LLMProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  grok: "Grok",
};

function authHint(p: LLMProviderInfo): string {
  if (p.requiresKey) return "API key";
  if (p.name === "openai" && p.mode === "api") return "via API key";
  if (p.name === "openai") return "via Codex CLI (ChatGPT OAuth)";
  return "via CLI";
}

function statusIcon(p: LLMProviderInfo): string {
  if (p.lastTest && !p.lastTest.ok) return "✗";
  if (p.available && p.configured) return "✓";
  return "⚠";
}

function statusAria(p: LLMProviderInfo): string {
  if (p.lastTest && !p.lastTest.ok) return "test failed";
  if (p.available && p.configured) return "ready";
  return "needs setup";
}

export function ProviderDropdown({
  feature,
  value,
  providers,
  onChange,
  disabled = false,
}: ProviderDropdownProps) {
  // Vision dropdown excludes non-vision providers. Currently all 4
  // support vision so this is a no-op; kept for forward-compat with
  // any future text-only provider that gets added.
  const visible = providers.filter(
    (p) => feature !== "vision" || p.supportsVision,
  );

  const current = providers.find((p) => p.name === value);
  // Surface a warning beneath the dropdown when the currently selected
  // provider isn't actually configured — UI guardrail before the user
  // dispatches and gets a backend error.
  const warning =
    current && !current.available
      ? `${PROVIDER_LABEL[current.name]} not configured — see Provider connections below.`
      : null;

  return (
    <div className="provider-dropdown-row">
      <label
        htmlFor={`provider-${feature}`}
        className="provider-dropdown__label"
      >
        {FEATURE_LABEL[feature]}
      </label>
      <div className="provider-dropdown__wrapper">
        <select
          id={`provider-${feature}`}
          className={`provider-dropdown${
            current && !current.available ? " provider-dropdown--warning" : ""
          }`}
          value={value}
          onChange={(e) => onChange(e.target.value as LLMProviderName)}
          disabled={disabled}
          aria-label={`${FEATURE_LABEL[feature]} provider`}
        >
          {visible.map((p) => (
            <option
              key={p.name}
              value={p.name}
              disabled={!p.available}
              title={
                !p.available
                  ? `${PROVIDER_LABEL[p.name]} not configured — see Provider connections below.`
                  : undefined
              }
            >
              {PROVIDER_LABEL[p.name]} {statusIcon(p)} · {authHint(p)}
              {!p.available ? " (not configured)" : ""}
            </option>
          ))}
        </select>
        {/* Hidden status text so screen readers can announce the
            currently-selected provider's state without parsing the
            option label. */}
        {current && (
          <span className="visually-hidden">
            Status: {statusAria(current)}
          </span>
        )}
      </div>
      {warning && (
        <div className="provider-dropdown__warning" role="alert">
          ⚠ {warning}
        </div>
      )}
    </div>
  );
}
