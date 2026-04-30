import { useState } from "react";
import type { LLMProviderInfo } from "../../api/client";
import { setLlmApiKey, testLlmProvider } from "../../api/client";
import { ApiKeyField } from "./ApiKeyField";

/**
 * OpenAI dual-mode row. The plan UI Spec lays out 7 visible layouts —
 * we collapse them via `mode` (cli | api | none) + `keyConfigured` flag
 * into 4 functional states:
 *
 *   OA0  No mode resolved (no CLI, no key)         → "Setup needed"
 *   OA1  CLI available + vision-capable             → ✓ Connected via Codex
 *   OA2  CLI available + text-only (no key)         → ✓ Codex CLI · ⓘ vision needs key
 *   OA3  CLI available + text-only + key present    → ✓ both modes (vision via API key)
 *   OA4  No CLI + key present                        → ✓ Connected via API key
 *
 * Adding/clearing the API key fallback is always one click — when
 * collapsed, "Add API key" / "Manage API key" expands the inline form.
 */

interface OpenAiRowProps {
  provider: LLMProviderInfo;
  onChanged(): void;
  onSetupHelp(): void;
}

const OPENAI_KEY_FORMAT = /^sk-[A-Za-z0-9_-]+$/;

export function OpenAiRow({ provider, onChanged, onSetupHelp }: OpenAiRowProps) {
  // Tracks whether the user has expanded the API-key panel from the
  // collapsed CLI-only states (OA1, OA2 without key).
  const [keyExpanded, setKeyExpanded] = useState(false);
  const [testResultMsg, setTestResultMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);

  // Backend reports `configured: true` if either CLI is present OR a key
  // is saved. We need a tighter signal — does the user have an API key
  // saved? — but the response doesn't expose that bit directly. Heuristic:
  // when mode === "api", we know the key is the only thing keeping the
  // provider available. Otherwise we infer key presence from `requiresKey`
  // (false for openai) and `mode === "cli"` together; key MAY also be set
  // in addition. Without a backend signal we treat key presence as
  // unknown — the user can always click "Add API key" to discover state.
  // For now: assume key is saved iff mode === "api" (no CLI fallback).
  // Future: backend can expose `apiKeyConfigured: bool` per provider.
  const cliAvailable = provider.mode === "cli";
  const apiKeyConfigured = provider.mode === "api";
  const savedKeyMask = apiKeyConfigured ? "•••saved•••" : null;

  async function handleSave(key: string) {
    await setLlmApiKey("openai", key);
    setKeyExpanded(false);
    setTestResultMsg(null);
    setTestOk(null);
    onChanged();
  }

  async function handleClear() {
    await setLlmApiKey("openai", null);
    setTestResultMsg(null);
    setTestOk(null);
    onChanged();
  }

  async function handleTest() {
    setTestResultMsg("Testing…");
    setTestOk(null);
    const r = await testLlmProvider("openai");
    if (r.ok) {
      setTestResultMsg(`Connected · ${r.latencyMs}ms`);
      setTestOk(true);
      setTimeout(() => {
        setTestResultMsg(null);
        setTestOk(null);
      }, 3000);
    } else {
      setTestResultMsg(r.error || "test failed");
      setTestOk(false);
    }
    onChanged();
  }

  // Layout decision tree
  const showKeyForm = keyExpanded || apiKeyConfigured;
  const state = resolveState();

  return (
    <div className={`provider-row provider-row--${state.kind}`}>
      <div className="provider-row__head">
        <span className="provider-row__dot">🟢</span>
        <span className="provider-row__name">OpenAI</span>
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
      {state.note && (
        <div className="provider-row__note">ⓘ {state.note}</div>
      )}
      {!showKeyForm && cliAvailable && (
        <div className="provider-row__actions">
          <button
            type="button"
            className="provider-row__expand-btn"
            onClick={() => setKeyExpanded(true)}
          >
            + Add API key fallback
          </button>
        </div>
      )}
      {!showKeyForm && !cliAvailable && (
        // OA0 — neither CLI nor key. Two CTAs to help the user decide.
        <div className="provider-row__actions">
          <button
            type="button"
            className="provider-row__cta-btn provider-row__cta-btn--primary"
            onClick={onSetupHelp}
          >
            Install Codex CLI
          </button>
          <button
            type="button"
            className="provider-row__cta-btn"
            onClick={() => setKeyExpanded(true)}
          >
            Use API key
          </button>
        </div>
      )}
      {showKeyForm && (
        <div className="provider-row__detail">
          <ApiKeyField
            savedKey={savedKeyMask}
            formatHint={OPENAI_KEY_FORMAT}
            placeholder="sk-..."
            onSave={handleSave}
            onClear={handleClear}
            onTest={savedKeyMask ? handleTest : undefined}
          />
          {testResultMsg && (
            <div
              className={`provider-row__test-msg${
                testOk === true
                  ? " provider-row__test-msg--ok"
                  : testOk === false
                    ? " provider-row__test-msg--err"
                    : ""
              }`}
            >
              {testOk === true ? "✓ " : testOk === false ? "✗ " : ""}
              {testResultMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );

  function resolveState(): {
    kind: "ready" | "missing";
    icon: string;
    title: string;
    note?: string;
  } {
    if (cliAvailable && apiKeyConfigured) {
      // OA3 — paranoia (current backend reports ONE mode at a time, so
      // this state isn't strictly observable yet, but we render it
      // optimistically right after a key save during the brief window
      // before the next refresh).
      return {
        kind: "ready",
        icon: "✓",
        title: "Connected (Codex CLI + API key fallback)",
      };
    }
    if (cliAvailable) {
      // OA1 / OA2 — Codex CLI is the active mode. We don't know whether
      // the user's Codex version supports vision (the backend does, via
      // `_cli_image_flag`, but doesn't currently expose it on /providers).
      // Keep the row simple and let the user opt into adding a key.
      return {
        kind: "ready",
        icon: "✓",
        title: "Connected via Codex CLI (ChatGPT OAuth)",
      };
    }
    if (apiKeyConfigured) {
      return {
        kind: "ready",
        icon: "✓",
        title: "Connected via API key",
      };
    }
    return {
      kind: "missing",
      icon: "⚠",
      title: "Setup needed",
      note: "Install Codex CLI for ChatGPT OAuth, or paste an OpenAI API key.",
    };
  }
}
