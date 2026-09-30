import { useEffect, useState } from "react";
import type { LLMProviderName } from "../../api/client";

/**
 * Inline setup guide opened from the "Setup help" button on each
 * provider row. Content varies by provider per the plan UI Spec:
 *   - Claude: install + auth + verify (CLI subscription)
 *   - Gemini: install + auth + verify (CLI subscription)
 *   - OpenAI: 2-tab layout — Codex CLI (preferred) / API key (fallback)
 *
 * Backdrop click + ESC + Close button all dismiss. Focus trap is
 * provided by the Settings panel backdrop already (we render inside it).
 */

interface ProviderSetupModalProps {
  provider: LLMProviderName;
  open: boolean;
  onClose(): void;
}

interface CommandLineProps {
  cmd: string;
}

function CommandLine({ cmd }: CommandLineProps) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail on insecure contexts — silently no-op,
      // user can still select+copy by hand.
    }
  }
  return (
    <div className="setup-modal__cmd">
      <code className="setup-modal__cmd-text">{cmd}</code>
      <button
        type="button"
        className="setup-modal__copy"
        onClick={handleCopy}
        aria-label="Copy command"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

export function ProviderSetupModal({ provider, open, onClose }: ProviderSetupModalProps) {
  // OpenAI is the only modal with tabs. Default to "cli" (the recommended
  // path); user can flip to "api" for the fallback.
  const [openaiTab, setOpenaiTab] = useState<"cli" | "api">("cli");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="setup-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="setup-modal" role="dialog" aria-modal="true">
        <div className="setup-modal__header">
          <span className="setup-modal__title">{titleFor(provider)}</span>
          <button
            type="button"
            className="setup-modal__close"
            onClick={onClose}
            aria-label="Close setup guide"
          >
            ×
          </button>
        </div>

        {provider === "claude" && <ClaudeContent />}
        {provider === "gemini" && <GeminiContent />}
        {provider === "openai" && (
          <OpenAiContent tab={openaiTab} onTabChange={setOpenaiTab} />
        )}
        {provider === "muse" && <MuseContent />}

        <div className="setup-modal__footer">
          <a
            className="setup-modal__docs-link"
            href={docsLinkFor(provider)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open {labelFor(provider)} docs ↗
          </a>
          <button
            type="button"
            className="setup-modal__close-btn"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ClaudeContent() {
  return (
    <div className="setup-modal__body">
      <p>
        Flowboard uses your existing Claude subscription via the official
        CLI — no API key needed.
      </p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">Install</span>
          <CommandLine cmd="npm install -g @anthropic-ai/claude-code" />
        </li>
        <li>
          <span className="setup-modal__step-label">Authenticate</span>
          <CommandLine cmd="claude" />
          <span className="setup-modal__step-hint">
            Opens a browser for OAuth — sign in with your Claude account.
          </span>
        </li>
        <li>
          <span className="setup-modal__step-label">Verify</span>
          <CommandLine cmd="claude --version" />
        </li>
      </ol>
      <p className="setup-modal__note">
        Once installed + authenticated, the Claude row above flips to
        ✓ Connected automatically (the panel polls every 30s).
      </p>
    </div>
  );
}

function GeminiContent() {
  return (
    <div className="setup-modal__body">
      <p>
        Flowboard uses your existing Gemini subscription via the official
        CLI — no API key needed.
      </p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">Install</span>
          <CommandLine cmd="npm install -g @google/gemini-cli" />
        </li>
        <li>
          <span className="setup-modal__step-label">Authenticate</span>
          <CommandLine cmd="gemini auth login" />
        </li>
        <li>
          <span className="setup-modal__step-label">Verify</span>
          <CommandLine cmd="gemini --version" />
        </li>
      </ol>
      <p className="setup-modal__note">
        Once authenticated, the Gemini row will flip to ✓ Connected on
        the next 30s poll.
      </p>
    </div>
  );
}

interface OpenAiContentProps {
  tab: "cli" | "api";
  onTabChange(t: "cli" | "api"): void;
}

function OpenAiContent({ tab, onTabChange }: OpenAiContentProps) {
  return (
    <div className="setup-modal__body">
      <div className="setup-modal__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cli"}
          className={`setup-modal__tab${tab === "cli" ? " setup-modal__tab--active" : ""}`}
          onClick={() => onTabChange("cli")}
        >
          Codex CLI (recommended)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "api"}
          className={`setup-modal__tab${tab === "api" ? " setup-modal__tab--active" : ""}`}
          onClick={() => onTabChange("api")}
        >
          API key
        </button>
      </div>

      {tab === "cli" ? (
        <>
          <p>ChatGPT Plus or Pro subscription required.</p>
          <ol className="setup-modal__steps">
            <li>
              <span className="setup-modal__step-label">Install</span>
              <CommandLine cmd="npm install -g @openai/codex" />
            </li>
            <li>
              <span className="setup-modal__step-label">Authenticate</span>
              <CommandLine cmd="codex login" />
            </li>
            <li>
              <span className="setup-modal__step-label">Verify</span>
              <CommandLine cmd="codex --version" />
            </li>
          </ol>
          <p className="setup-modal__note">
            If your Codex version is text-only, you can add an OpenAI API
            key below as a Vision fallback in the OpenAI row above.
          </p>
        </>
      ) : (
        <>
          <p>For users without ChatGPT Plus or Pro.</p>
          <ol className="setup-modal__steps">
            <li>
              <span className="setup-modal__step-label">Get a key</span>
              <a
                className="setup-modal__step-link"
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                platform.openai.com/api-keys ↗
              </a>
            </li>
            <li>
              <span className="setup-modal__step-label">Save it</span>
              <span className="setup-modal__step-hint">
                Paste in the OpenAI row above and click Save.
              </span>
            </li>
          </ol>
          <p className="setup-modal__note">
            The key stays in <code>~/.flowboard/secrets.json</code>{" "}
            (mode 600, local only) and is never sent anywhere except
            api.openai.com.
          </p>
        </>
      )}
    </div>
  );
}

function MuseContent() {
  return (
    <div className="setup-modal__body">
      <p>
        Muse needs no CLI and no key in this dialog. Pick one transport:
        the <strong>muse2api</strong> gateway (muse.ai as an
        OpenAI-compatible API), or a <strong>Pax worker</strong> polling
        Flowboard's job queue.
      </p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">
            Option A — muse2api gateway
          </span>
          <CommandLine cmd="FLOWBOARD_MUSE2API_BASE=http://127.0.0.1:18610" />
          <CommandLine cmd="FLOWBOARD_MUSE2API_KEY=<MUSE2API_API_KEY>" />
          <span className="setup-modal__step-hint">
            Add both to <code>.env</code> at the repo root and restart the
            agent. LLM features, image and video generation then call
            muse2api directly; the row flips to ✓ Connected when its
            /readyz reports ready.
          </span>
        </li>
        <li>
          <span className="setup-modal__step-label">
            Option B — Pax worker
          </span>
          <CommandLine cmd="python agent/scripts/muse_worker.py --worker-id pax-1" />
          <span className="setup-modal__step-hint">
            Used only when FLOWBOARD_MUSE2API_BASE is unset. Run on the
            same host as the agent; the row flips to ✓ Connected on its
            first poll (~30s).
          </span>
        </li>
        <li>
          <span className="setup-modal__step-label">Test</span>
          <span className="setup-modal__step-hint">
            Click “Test” on a feature row — it sends a real round-trip
            and reports latency.
          </span>
        </li>
      </ol>
      <p className="setup-modal__note">
        See docs/muse-provider.md for what each transport supports.
      </p>
    </div>
  );
}

function titleFor(p: LLMProviderName): string {
  switch (p) {
    case "claude":
      return "🤖 Claude CLI Setup";
    case "gemini":
      return "🤖 Gemini CLI Setup";
    case "openai":
      return "🤖 OpenAI Setup";
    case "muse":
      return "🤖 Muse Setup";
  }
}

function labelFor(p: LLMProviderName): string {
  switch (p) {
    case "claude":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "openai":
      return "OpenAI";
    case "muse":
      return "Muse";
  }
}

function docsLinkFor(p: LLMProviderName): string {
  switch (p) {
    case "claude":
      return "https://docs.anthropic.com/en/docs/claude-code/quickstart";
    case "gemini":
      return "https://github.com/google/gemini-cli";
    case "openai":
      return "https://platform.openai.com/docs/quickstart";
    case "muse":
      return "https://muse.ai";
  }
}
