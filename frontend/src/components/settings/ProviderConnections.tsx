import { useState } from "react";
import type { LLMProviderInfo, LLMProviderName } from "../../api/client";
import { testLlmProvider } from "../../api/client";
import { CliProviderRow } from "./CliProviderRow";
import { GrokRow } from "./GrokRow";
import { OpenAiRow } from "./OpenAiRow";
import { ProviderSetupModal } from "./ProviderSetupModal";

/**
 * The four provider rows + the shared setup modal. Owns:
 *   - Which provider's setup help is open (single modal at a time)
 *   - The transient "testing" state per provider for CLI rows
 *
 * Refresh after any state-changing op flows up to AiProvidersSection.
 */

interface ProviderConnectionsProps {
  providers: LLMProviderInfo[];
  onChanged(): void;
}

export function ProviderConnections({ providers, onChanged }: ProviderConnectionsProps) {
  const [helpFor, setHelpFor] = useState<LLMProviderName | null>(null);
  const [testingCli, setTestingCli] = useState<LLMProviderName | null>(null);

  async function handleCliTest(name: LLMProviderName) {
    setTestingCli(name);
    try {
      await testLlmProvider(name);
    } finally {
      setTestingCli(null);
      onChanged();
    }
  }

  // Stable order: claude → gemini → openai → grok per UI Spec sketch.
  const byName: Record<LLMProviderName, LLMProviderInfo | undefined> = {
    claude: providers.find((p) => p.name === "claude"),
    gemini: providers.find((p) => p.name === "gemini"),
    openai: providers.find((p) => p.name === "openai"),
    grok: providers.find((p) => p.name === "grok"),
  };

  return (
    <div className="provider-connections">
      <div className="provider-connections__subtitle">Provider connections</div>
      {byName.claude && (
        <CliProviderRow
          provider={byName.claude}
          onSetupHelp={() => setHelpFor("claude")}
          onTest={() => handleCliTest("claude")}
          testing={testingCli === "claude"}
        />
      )}
      {byName.gemini && (
        <CliProviderRow
          provider={byName.gemini}
          onSetupHelp={() => setHelpFor("gemini")}
          onTest={() => handleCliTest("gemini")}
          testing={testingCli === "gemini"}
        />
      )}
      {byName.openai && (
        <OpenAiRow
          provider={byName.openai}
          onChanged={onChanged}
          onSetupHelp={() => setHelpFor("openai")}
        />
      )}
      {byName.grok && (
        <GrokRow
          provider={byName.grok}
          onChanged={onChanged}
          onSetupHelp={() => setHelpFor("grok")}
        />
      )}
      <ProviderSetupModal
        provider={helpFor ?? "claude"}
        open={helpFor !== null}
        onClose={() => setHelpFor(null)}
      />
    </div>
  );
}
