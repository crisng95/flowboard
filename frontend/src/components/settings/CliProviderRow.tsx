import type { LLMProviderInfo, LLMProviderName } from "../../api/client";

/**
 * Provider row used by Claude + Gemini (identical state machine —
 * both are CLI-only with OAuth). Renders one of the four states
 * documented in the plan UI Spec:
 *
 *   S1  ✓ Connected (CLI · OAuth)
 *   S2  ⚠ CLI not found
 *   S3  ⚠ CLI installed but not signed in
 *   S4  ✗ Last test failed
 */

interface CliProviderRowProps {
  provider: LLMProviderInfo;
  onSetupHelp(): void;
  onTest(): Promise<void>;
  testing: boolean;
}

const META: Record<
  Extract<LLMProviderName, "claude" | "gemini">,
  { label: string; dot: string; installCmd: string; authCmd: string }
> = {
  claude: {
    label: "Claude",
    dot: "⚪",
    installCmd: "npm install -g @anthropic-ai/claude-code",
    authCmd: "claude",
  },
  gemini: {
    label: "Gemini",
    dot: "🔵",
    installCmd: "npm install -g @google/gemini-cli",
    authCmd: "gemini auth login",
  },
};

export function CliProviderRow({ provider, onSetupHelp, onTest, testing }: CliProviderRowProps) {
  // Type narrowing — this component is only used for claude/gemini.
  const meta = META[provider.name as "claude" | "gemini"];
  const state = resolveState(provider);

  return (
    <div className={`provider-row provider-row--${state.kind}`}>
      <div className="provider-row__head">
        <span className="provider-row__dot">{meta.dot}</span>
        <span className="provider-row__name">{meta.label}</span>
        <span
          className={`provider-row__status provider-row__status--${state.kind}`}
        >
          {state.icon} {state.title}
        </span>
        <button
          type="button"
          className="provider-row__setup-btn"
          onClick={onSetupHelp}
        >
          Setup help
        </button>
      </div>
      {state.detail && (
        <div className="provider-row__detail">
          {state.detail}
          {state.cmdHint && (
            <code className="provider-row__cmd-inline">{state.cmdHint}</code>
          )}
        </div>
      )}
      {state.kind === "test_failed" && (
        <div className="provider-row__actions">
          <button
            type="button"
            className="provider-row__retry-btn"
            onClick={onTest}
            disabled={testing}
          >
            {testing ? "Retrying…" : "Retry test"}
          </button>
        </div>
      )}
    </div>
  );

  function resolveState(p: LLMProviderInfo): {
    kind: "ready" | "missing" | "unauth" | "test_failed";
    icon: string;
    title: string;
    detail?: string;
    cmdHint?: string;
  } {
    if (p.lastTest && !p.lastTest.ok) {
      return {
        kind: "test_failed",
        icon: "✗",
        title: `Last test failed: ${p.lastTest.error || "unknown"}`,
      };
    }
    if (p.available) {
      return {
        kind: "ready",
        icon: "✓",
        title: `Connected (${meta.label} CLI · OAuth)`,
      };
    }
    // Map lastError to S2 / S3 — backend writes "not_installed" or
    // "not_authenticated" when the probe fails.
    if (p.lastError === "not_authenticated") {
      return {
        kind: "unauth",
        icon: "⚠",
        title: "CLI installed but not signed in",
        detail: "Run ",
        cmdHint: meta.authCmd,
      };
    }
    // Default to "not installed" — the more common first-time state.
    return {
      kind: "missing",
      icon: "⚠",
      title: "CLI not found",
      detail: "Run ",
      cmdHint: meta.installCmd,
    };
  }
}
