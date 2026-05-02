import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLlmConfig,
  getLlmProviders,
  setLlmConfig,
  testLlmProvider,
  type LLMConfig,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../api/client";
import { ProviderCard } from "./ProviderCard";
import { ProviderSetupModal } from "./ProviderSetupModal";

/**
 * Single-provider model — one AI provider serves all 3 features
 * (Auto-Prompt / Vision / Planner). User picks one card, runs ONE
 * connection test, then Apply commits the change to all 3 features.
 *
 * Why one test instead of three: in single-provider mode, the 3 tests
 * were 3 identical pings against the same endpoint with the same
 * prompt. Running them in parallel triggered Google's per-user
 * MODEL_CAPACITY_EXHAUSTED 429s on Gemini (the first call wins, the
 * other two retry-wait and often time out at 120s). Running them in
 * series is wasteful and slow. One ping is sufficient — if the provider
 * answers `.` once, all 3 dispatch paths can use it.
 *
 * CLI-only philosophy: only OAuth-CLI providers are surfaced
 * (Claude / Gemini / OpenAI Codex). xAI Grok was considered but never
 * shipped an end-user CLI, so it was dropped from both UI and backend.
 *
 * Layout:
 *   1. Cards row — 3 OAuth provider cards
 *   2. Selection panel (visible only after a card is selected) —
 *      either inline setup (Setup help link) when the provider isn't
 *      ready, OR the connection test + Apply button when ready.
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
// First-run default selection. Gemini wins because it's free for personal
// use, has the lowest CLI install friction, and (on a configured machine)
// passes the test gate fastest. The user can still click any other card —
// this just gives them a sensible starting point instead of a blank panel.
const FIRST_RUN_DEFAULT: LLMProviderName = "gemini";

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
};
type TestState = "untested" | "testing" | "ok" | "fail";
interface ConnectionTestResult {
  state: TestState;
  error?: string;
  latencyMs?: number;
}

const INITIAL_TEST: ConnectionTestResult = { state: "untested" };

function deriveCurrent(config: LLMConfig | null): LLMProviderName | null {
  // "Current active provider" = the one all 3 features point at. Any
  // null slot or any divergence (legacy mixed config / partial pick)
  // returns null so the UI prompts the user to consolidate.
  if (!config) return null;
  const a = config.auto_prompt;
  if (a === null) return null;
  if (a === config.vision && config.vision === config.planner) {
    return a;
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
  const [test, setTest] = useState<ConnectionTestResult>(INITIAL_TEST);
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

  // Once the first /config arrives, seed the pending selection. Two
  // cases:
  //   - User already has a configured provider → seed with it so Apply
  //     is a no-op until they pick something different.
  //   - Fresh install (no current) → seed with FIRST_RUN_DEFAULT (Gemini)
  //     so the panel opens with one card pre-selected and the user sees
  //     the next-step CTA (Setup help OR test list) immediately, instead
  //     of a blank state that hides what to do next.
  const current = deriveCurrent(config);
  useEffect(() => {
    if (pending !== null || config === null) return;
    if (current !== null && SHOWN_PROVIDERS.includes(current)) {
      setPending(current);
    } else {
      setPending(FIRST_RUN_DEFAULT);
    }
  }, [current, pending, config]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function handleSelect(name: LLMProviderName) {
    if (name === pending) return;
    setPending(name);
    // Switching the candidate provider invalidates any prior test
    // result — it was against a different target.
    setTest(INITIAL_TEST);
  }

  async function runTest() {
    if (!pending) return;
    setTest({ state: "testing" });
    const result = await testLlmProvider(pending);
    setTest(
      result.ok
        ? { state: "ok", latencyMs: result.latencyMs }
        : { state: "fail", error: result.error || "test failed" },
    );
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
      // Broadcast so the badge + ForcedSetupGate refresh immediately
      // instead of waiting up to 30s for their own poll. Plain window
      // event keeps the contract loose — anyone interested subscribes,
      // no shared store coupling.
      window.dispatchEvent(new CustomEvent("flowboard:llm-config-changed"));
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
  };

  const pendingProvider = pending ? byName[pending] : null;
  const ready = !!pendingProvider && pendingProvider.available && pendingProvider.configured;
  const testPassed = test.state === "ok";
  const testRunning = test.state === "testing";
  const selectionUnchanged = pending !== null && pending === current;
  const canApply =
    ready
    && testPassed
    && !applying
    && !testRunning
    && !selectionUnchanged;

  return (
    <div className="ai-providers-section">
      <div className="ai-providers-section__intro">
        Pick which AI powers Flowboard. One provider serves all three
        features — switching is one decision, not three.
      </div>

      {current === null && config !== null && !config.configured
        && (config.auto_prompt || config.vision || config.planner) && (
        // Mixed-state notice — at least one feature has been pinned but
        // not all three (or they diverge). Pick one card to consolidate.
        <div className="ai-providers-section__mixed-notice" role="alert">
          ⓘ Your providers don't match across features
          ({config.auto_prompt ?? "—"} / {config.vision ?? "—"} / {config.planner ?? "—"}).
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
            // Ready branch: provider is connected. Show ONE connection
            // test + Apply. One ping is sufficient — Auto-Prompt /
            // Vision / Planner all hit the same provider in
            // single-provider mode, so a working ping for one is a
            // working ping for all three. (3 parallel pings used to
            // trigger MODEL_CAPACITY_EXHAUSTED on Gemini's CodeAssist
            // backend — Google throttles concurrent calls per user.)
            <>
              <div className="selection-panel__heading">
                Test the connection, then Apply
              </div>
              <ConnectionTestRow
                providerLabel={labelOf(pending)}
                result={test}
                onTest={runTest}
              />
              <div className="selection-panel__actions">
                <button
                  type="button"
                  className="selection-panel__apply-btn"
                  onClick={handleApply}
                  disabled={!canApply}
                  title={
                    selectionUnchanged
                      ? `${labelOf(pending)} is already active.`
                      : !testPassed
                        ? "Run the connection test successfully to enable Apply."
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

interface ConnectionTestRowProps {
  providerLabel: string;
  result: ConnectionTestResult;
  onTest(): void;
}

/** Single connection test for the selected provider. Replaces the old
 * 3-feature test list — one ping is sufficient because all 3 features
 * point at the same provider in single-provider mode. */
function ConnectionTestRow({ providerLabel, result, onTest }: ConnectionTestRowProps) {
  const icon =
    result.state === "ok"
      ? "✓"
      : result.state === "fail"
        ? "✗"
        : result.state === "testing"
          ? "⏳"
          : "○";
  const subtitle =
    result.state === "ok" && result.latencyMs != null
      ? `Connected · ${result.latencyMs}ms · powers Auto-Prompt, Vision, Planner`
      : result.state === "fail" && result.error
        ? result.error
        : result.state === "testing"
          ? "Pinging the CLI…"
          : "Sends one tiny prompt to verify the CLI answers.";
  return (
    <div className={`feature-test-row feature-test-row--${result.state}`}>
      <span
        className={`feature-test-row__icon feature-test-row__icon--${result.state}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="feature-test-row__body">
        <span className="feature-test-row__name">
          {providerLabel} connection
        </span>
        <span
          className={
            result.state === "fail"
              ? "feature-test-row__error"
              : result.state === "ok"
                ? "feature-test-row__latency"
                : "feature-test-row__hint"
          }
        >
          {subtitle}
        </span>
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
  }
}
