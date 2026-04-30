import { useState } from "react";
import type { LLMProviderInfo } from "../../api/client";
import { setLlmApiKey, testLlmProvider } from "../../api/client";
import { ApiKeyField } from "./ApiKeyField";

/**
 * Grok row — API-key-only state machine (per UI Spec):
 *   GR1  ⚠ API key needed (empty)
 *   GR2  ✓ Connected (saved + last test ok or fresh save)
 *   GR3  ✗ Test failed
 */

interface GrokRowProps {
  provider: LLMProviderInfo;
  onChanged(): void; // refresh list / config after save/clear/test
  onSetupHelp(): void;
}

const GROK_KEY_FORMAT = /^xai-[A-Za-z0-9_-]+$/;

export function GrokRow({ provider, onChanged, onSetupHelp }: GrokRowProps) {
  const [testResultMsg, setTestResultMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);

  // The frontend never sees the actual saved key. Backend reports
  // `configured: true` once a key is present; we render a placeholder
  // masked form (the field component handles its own state).
  const savedKeyMask = provider.configured ? "•••saved•••" : null;

  async function handleSave(key: string) {
    await setLlmApiKey("grok", key);
    setTestResultMsg(null);
    setTestOk(null);
    onChanged();
  }

  async function handleClear() {
    await setLlmApiKey("grok", null);
    setTestResultMsg(null);
    setTestOk(null);
    onChanged();
  }

  async function handleTest() {
    setTestResultMsg("Testing…");
    setTestOk(null);
    const r = await testLlmProvider("grok");
    if (r.ok) {
      setTestResultMsg(`Connected · ${r.latencyMs}ms`);
      setTestOk(true);
      // Auto-fade success message after 3s.
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

  const state = resolveState(provider, testOk);

  return (
    <div className={`provider-row provider-row--${state.kind}`}>
      <div className="provider-row__head">
        <span className="provider-row__dot">⚫</span>
        <span className="provider-row__name">Grok</span>
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
      <div className="provider-row__detail">
        <ApiKeyField
          savedKey={savedKeyMask}
          formatHint={GROK_KEY_FORMAT}
          placeholder="xai-..."
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
    </div>
  );

  function resolveState(
    p: LLMProviderInfo,
    lastTestExplicit: boolean | null,
  ): { kind: "ready" | "missing" | "test_failed"; icon: string; title: string } {
    if (lastTestExplicit === false) {
      return { kind: "test_failed", icon: "✗", title: "Test failed" };
    }
    if (!p.configured) {
      return { kind: "missing", icon: "⚠", title: "API key needed" };
    }
    return { kind: "ready", icon: "✓", title: "Connected (API key)" };
  }
}
