import type { LLMConfig, LLMFeature, LLMProviderInfo, LLMProviderName } from "../../api/client";
import { ProviderDropdown } from "./ProviderDropdown";

/**
 * Three rows of provider dropdowns — Auto-Prompt / Vision / Planner.
 * The owner (AiProvidersSection) handles the optimistic update + revert
 * on backend reject; this component is presentational.
 */

interface FeatureRoutingTableProps {
  config: LLMConfig;
  providers: LLMProviderInfo[];
  onSelect(feature: LLMFeature, name: LLMProviderName): void;
  disabled?: boolean;
}

const FEATURES: LLMFeature[] = ["auto_prompt", "vision", "planner"];

export function FeatureRoutingTable({
  config,
  providers,
  onSelect,
  disabled = false,
}: FeatureRoutingTableProps) {
  return (
    <div className="feature-routing-table">
      <div className="feature-routing-table__subtitle">Per-feature routing</div>
      {FEATURES.map((f) => (
        <ProviderDropdown
          key={f}
          feature={f}
          value={config[f]}
          providers={providers}
          onChange={(name) => onSelect(f, name)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
