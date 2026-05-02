import type { LLMProviderInfo, LLMProviderName } from "../../api/client";

/**
 * One provider card — clickable tile that shows provider identity +
 * connection status + selection state. Used in the OAuth Providers and
 * API Key Providers groups inside AiProvidersSection.
 *
 * Visual contract (matches the screenshot reference):
 *   - Logo dot + name on the left, status badge below
 *   - Right-edge indicator: filled when this card is the user's
 *     pending selection, hollow when not
 *   - Active border when selected; muted border otherwise
 *   - Disabled visual (lower opacity, no pointer) when the provider
 *     can't be activated yet (CLI missing for OAuth) — clicking still
 *     selects so the panel below can guide the user through setup.
 */

interface ProviderCardProps {
  provider: LLMProviderInfo;
  /** True when this card is the user's pending selection (highlighted). */
  selected: boolean;
  /** True when this card matches the currently-applied config (badge). */
  current: boolean;
  /** Click handler — flips selection. Always fires; the section above
   * decides whether to render setup guidance vs. test flow. */
  onSelect(name: LLMProviderName): void;
}

const PROVIDER_META: Record<
  LLMProviderName,
  { name: string; tagline: string }
> = {
  claude:  { name: "Claude Code",   tagline: "Anthropic CLI · OAuth" },
  gemini:  { name: "Gemini CLI",    tagline: "Google CLI · OAuth" },
  openai:  { name: "OpenAI Codex",  tagline: "ChatGPT CLI · OAuth" },
};

function statusLabel(p: LLMProviderInfo): string {
  if (p.available && p.configured) return "Connected";
  if (p.lastError === "not_authenticated") return "Not signed in";
  if (p.requiresKey && !p.configured) return "API key needed";
  return "Setup needed";
}

function statusKind(p: LLMProviderInfo): "ok" | "warn" {
  return p.available && p.configured ? "ok" : "warn";
}

export function ProviderCard({ provider, selected, current, onSelect }: ProviderCardProps) {
  const meta = PROVIDER_META[provider.name];
  const kind = statusKind(provider);

  return (
    <button
      type="button"
      className={`provider-card${selected ? " provider-card--selected" : ""}${
        kind === "warn" ? " provider-card--unconfigured" : ""
      }`}
      onClick={() => onSelect(provider.name)}
      aria-pressed={selected}
    >
      <div className="provider-card__head">
        <span className="provider-card__name">{meta.name}</span>
        <span className="provider-card__tagline">{meta.tagline}</span>
      </div>
      <div className="provider-card__foot">
        <span className={`provider-card__status provider-card__status--${kind}`}>
          <span className="provider-card__status-dot" aria-hidden="true">●</span>
          {statusLabel(provider)}
        </span>
        {current && !selected && (
          <span className="provider-card__current-badge">Active</span>
        )}
      </div>
      <span
        className={`provider-card__radio${selected ? " provider-card__radio--on" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}
