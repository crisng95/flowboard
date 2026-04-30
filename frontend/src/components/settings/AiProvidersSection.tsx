import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLlmConfig,
  getLlmProviders,
  setLlmConfig,
  testLlmProvider,
  type LLMConfig,
  type LLMFeature,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../api/client";
import { ProviderCard } from "./ProviderCard";
import { ProviderSetupModal } from "./ProviderSetupModal";

/**
 * Single-provider model — one AI provider serves all 3 features
 * (Auto-Prompt / Vision / Planner). User picks one card, runs the
 * 3 feature tests, then Apply commits the change.
 *
 * CLI-only philosophy: only OAuth-CLI providers are surfaced
 * (Claude / Gemini / OpenAI Codex). Grok was considered but xAI hasn't
 * shipped an end-user CLI, so it doesn't fit. The backend still has
 * Grok wired up — only the UI excludes it.
 *
 * Layout:
 *   1. Cards row — 3 OAuth provider cards
 *   2. Selection panel (visible only after a card is selected) —
 *      either inline setup (Setup help link) when the provider isn't
 *      ready, OR the 3-feature test list + Apply button when ready.
 *
 * Backend support: setLlmConfig accepts partial updates; we always send
 * all 3 features pointed at the same provider. The backend keeps its
 * per-feature routing capability so future power-user surfaces can opt
 * into the granular model — this dialog just constrains it for clarity.
 */

const REFRESH_INTERVAL_MS = 30_000;
// Order matters — this is the left-to-right card order in the dialog.
// Gemini first (Google's most popular CLI), Claude middle, OpenAI Codex last.
const SHOWN_PROVIDERS: LLMProviderName[] = ["gemini", "claude", "openai"];
const FEATURES: LLMFeature[] = ["auto_prompt", "vision", "planner"];

// CLI install reference — shown as a footer under the test checklist so
// users know how to upgrade / reinstall the CLI without leaving the
// dialog. Docs URL points at the official repo / quickstart for each.
const CLI_REFERENCE: Record<
  LLMProviderName,
  { installCmd: string; docsUrl: string; docsLabel: string }
> = {
  claude: {
    installCmd: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
    docsLabel: "Anthropic docs",
  },
  gemini: {
    installCmd: "npm install -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    docsLabel: "Gemini CLI repo",
  },
  openai: {
    installCmd: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex",
    docsLabel: "Codex CLI repo",
  },
  grok: {
    installCmd: "",
    docsUrl: "https://docs.x.ai/api/quickstart",
    docsLabel: "xAI API docs",
  },
};
const FEATURE_LABEL: Record<LLMFeature, string> = {
  auto_prompt: "Auto-Prompt",
  vision: "Vision",
  planner: "Planner",
};
const FEATURE_HINT: Record<LLMFeature, string> = {
  auto_prompt: "Composes prompts when you click Generate without typing one.",
  vision: "Describes uploaded images into short factual aiBriefs.",
  planner: "Drafts the JSON plan in chat replies.",
};

type TestState = "untested" | "testing" | "ok" | "fail";
interface FeatureTestResult {
  state: TestState;
  error?: string;
  latencyMs?: number;
}

const INITIAL_TESTS: Record<LLMFeature, FeatureTestResult> = {
  auto_prompt: { state: "untested" },
  vision: { state: "untested" },
  planner: { state: "untested" },
};

function deriveCurrent(config: LLMConfig | null): LLMProviderName | null {
  // "Current active provider" = the one all 3 features point at. If
  // they diverge (config drift from a previous version that supported
  // per-feature routing), report null and prompt the user to consolidate.
  if (!config) return null;
  if (config.auto_prompt === config.vision && config.vision === config.planner) {
    return config.auto_prompt;
  }
  return null;
}

export function AiProvidersSection() {
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The card the user has clicked (their pending selection). Defaults
  // to whatever's currently active so opening the dialog doesn't show
  // a blank state.
  const [pending, setPending] = useState<LLMProviderName | null>(null);
  const [tests, setTests] = useState<Record<LLMFeature, FeatureTestResult>>(INITIAL_TESTS);
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

  // Once the first /config arrives, seed the pending selection with
  // the currently-active provider so Apply is a no-op until the user
  // picks something different.
  const current = deriveCurrent(config);
  useEffect(() => {
    if (pending === null && current !== null && SHOWN_PROVIDERS.includes(current)) {
      setPending(current);
    }
  }, [current, pending]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function handleSelect(name: LLMProviderName) {
    if (name === pending) return;
    setPending(name);
    // Switching the candidate provider invalidates any prior test
    // results — they were against a different target.
    setTests(INITIAL_TESTS);
  }

  async function runTest(feature: LLMFeature) {
    if (!pending) return;
    setTests((t) => ({ ...t, [feature]: { state: "testing" } }));
    const result = await testLlmProvider(pending);
    setTests((t) => ({
      ...t,
      [feature]: result.ok
        ? { state: "ok", latencyMs: result.latencyMs }
        : { state: "fail", error: result.error || "test failed" },
    }));
  }

  async function runAllTests() {
    if (!pending) return;
    for (const f of FEATURES) {
      await runTest(f);
    }
  }

  async function handleApply() {
    if (!pending || applying) return;
    setApplying(true);
    try {
      // Single-provider model: every feature points at the same name.
      await setLlmConfig({
        auto_prompt: pending,
        vision: pending,
        planner: pending,
      });
      showToast(`AI provider switched to ${labelOf(pending)}.`);
      await refresh();
      // Tests stay valid after Apply — provider hasn't changed, we
      // just persisted the selection.
    } catch (err) {
      showToast(
        `Couldn't apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }

  // ── Render guards ───────────────────────────────────────────────

  if (!providers && !config && !loadError) {
    return (
      <div className="ai-providers-section">
        <div className="ai-providers-section__skeleton">
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
        </div>
      </div>
    );
  }

  if (loadError && (!providers || !config)) {
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

  // Past this point, providers + config are non-null.
  const byName: Record<LLMProviderName, LLMProviderInfo | undefined> = {
    claude: providers!.find((p) => p.name === "claude"),
    gemini: providers!.find((p) => p.name === "gemini"),
    openai: providers!.find((p) => p.name === "openai"),
    grok: providers!.find((p) => p.name === "grok"),
  };

  const pendingProvider = pending ? byName[pending] : null;
  const ready = !!pendingProvider && pendingProvider.available && pendingProvider.configured;
  const allTestsPassed = FEATURES.every((f) => tests[f].state === "ok");
  const anyTestRunning = FEATURES.some((f) => tests[f].state === "testing");
  const selectionUnchanged = pending !== null && pending === current;
  const canApply =
    ready
    && allTestsPassed
    && !applying
    && !anyTestRunning
    && !selectionUnchanged;

  return (
    <div className="ai-providers-section">
      <div className="ai-providers-section__intro">
        Pick which AI powers Flowboard. One provider serves all three
        features — switching is one decision, not three.
      </div>

      {current === null && config !== null && (
        // Mixed-state notice — config has different providers per feature
        // (legacy or hand-edited secrets.json). Pick one to consolidate.
        <div className="ai-providers-section__mixed-notice" role="alert">
          ⓘ Your config has different providers per feature
          ({config.auto_prompt} / {config.vision} / {config.planner}).
          Pick one below and Apply to consolidate.
        </div>
      )}

      <div className="provider-group">
        <div className="provider-group__title">OAuth Providers</div>
        <div className="provider-group__cards">
          {SHOWN_PROVIDERS.map((name) => {
            const p = byName[name];
            if (!p) return null;
            return (
              <ProviderCard
                key={name}
                provider={p}
                selected={pending === name}
                current={current === name}
                onSelect={handleSelect}
              />
            );
          })}
        </div>
      </div>

      {pending && pendingProvider && (
        <div className="selection-panel">
          {!ready ? (
            // Setup-needed branch: surface install/auth guidance before
            // letting the user attempt to test or apply.
            <div className="selection-panel__setup">
              <div className="selection-panel__heading">
                {labelOf(pending)} needs setup
              </div>
              <div className="selection-panel__setup-text">
                {pendingProvider.lastError === "not_authenticated"
                  ? "The CLI is installed but not signed in. Open Setup help for the login command."
                  : "Install the CLI from npm and sign in. Open Setup help for the exact commands."}
              </div>
              <button
                type="button"
                className="selection-panel__setup-btn"
                onClick={() => setHelpFor(pending)}
              >
                Setup help →
              </button>
            </div>
          ) : (
            // Ready branch: provider is connected. Show the 3 feature
            // tests + Apply button. User must run all 3 tests green
            // before Apply enables.
            <>
              <div className="selection-panel__heading">
                Test {labelOf(pending)} on each feature before applying
              </div>
              <div className="feature-test-list">
                {FEATURES.map((f) => (
                  <FeatureTestRow
                    key={f}
                    feature={f}
                    result={tests[f]}
                    onTest={() => runTest(f)}
                  />
                ))}
              </div>
              <div className="selection-panel__actions">
                <button
                  type="button"
                  className="selection-panel__test-all-btn"
                  onClick={runAllTests}
                  disabled={anyTestRunning}
                >
                  {anyTestRunning ? "Testing…" : "Test all"}
                </button>
                <button
                  type="button"
                  className="selection-panel__apply-btn"
                  onClick={handleApply}
                  disabled={!canApply}
                  title={
                    selectionUnchanged
                      ? `${labelOf(pending)} is already active.`
                      : !allTestsPassed
                        ? "Run all 3 feature tests successfully to enable Apply."
                        : `Apply ${labelOf(pending)} to all features.`
                  }
                >
                  {applying
                    ? "Applying…"
                    : selectionUnchanged
                      ? "Already active"
                      : "Apply changes"}
                </button>
              </div>

              <CliReference provider={pending} />
            </>
          )}
        </div>
      )}

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

interface FeatureTestRowProps {
  feature: LLMFeature;
  result: FeatureTestResult;
  onTest(): void;
}

function FeatureTestRow({ feature, result, onTest }: FeatureTestRowProps) {
  const icon =
    result.state === "ok"
      ? "✓"
      : result.state === "fail"
        ? "✗"
        : result.state === "testing"
          ? "⏳"
          : "○";
  return (
    <div className={`feature-test-row feature-test-row--${result.state}`}>
      <span
        className={`feature-test-row__icon feature-test-row__icon--${result.state}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="feature-test-row__body">
        <span className="feature-test-row__name">{FEATURE_LABEL[feature]}</span>
        <span className="feature-test-row__hint">{FEATURE_HINT[feature]}</span>
        {result.state === "ok" && result.latencyMs != null && (
          <span className="feature-test-row__latency">
            ✓ Connected · {result.latencyMs}ms
          </span>
        )}
        {result.state === "fail" && result.error && (
          <span className="feature-test-row__error">✗ {result.error}</span>
        )}
      </div>
      <button
        type="button"
        className="feature-test-row__btn"
        onClick={onTest}
        disabled={result.state === "testing"}
      >
        {result.state === "testing"
          ? "Testing…"
          : result.state === "ok"
            ? "Re-test"
            : result.state === "fail"
              ? "Retry"
              : "Test"}
      </button>
    </div>
  );
}

/**
 * Footer shown below the test checklist with the install command + a
 * link to the CLI's official docs. Lets the user copy the upgrade
 * command without leaving the dialog and points them at the canonical
 * source if they need deeper setup help.
 */
interface CliReferenceProps {
  provider: LLMProviderName;
}

function CliReference({ provider }: CliReferenceProps) {
  const ref = CLI_REFERENCE[provider];
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(ref.installCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent — the command is selectable / readable as text fallback.
    }
  }

  if (!ref.installCmd) return null; // Grok has no CLI; nothing to show

  return (
    <div className="cli-reference">
      <div className="cli-reference__row">
        <span className="cli-reference__label">Install / upgrade</span>
        <code className="cli-reference__cmd">{ref.installCmd}</code>
        <button
          type="button"
          className="cli-reference__copy-btn"
          onClick={handleCopy}
          aria-label="Copy install command"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <a
        className="cli-reference__docs-link"
        href={ref.docsUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open {ref.docsLabel} ↗
      </a>
    </div>
  );
}

function labelOf(name: LLMProviderName): string {
  switch (name) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "openai":
      return "OpenAI";
    case "grok":
      return "Grok";
  }
}
