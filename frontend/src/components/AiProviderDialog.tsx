import { useEffect, useRef } from "react";
import { AiProvidersSection } from "./settings/AiProvidersSection";

/**
 * Standalone dialog for the AI Providers panel. Mirrors SettingsPanel's
 * backdrop + click-outside + ESC pattern, but is conceptually distinct:
 * SettingsPanel is for the *Google Flow* generation context (tier, video
 * quality, image model), AiProviderDialog is for the *LLM provider* layer
 * (which AI powers Auto-Prompt / Vision / Planner).
 *
 * Triggered from the AiProviderBadge in the toolbar (top-right, left of
 * Sponsor). Keeping the two surfaces separate matches how the user
 * thinks about them — Flow billing decisions don't belong with LLM
 * provider switches.
 */

interface AiProviderDialogProps {
  open: boolean;
  onClose(): void;
}

export function AiProviderDialog({ open, onClose }: AiProviderDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

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
      className="ai-provider-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="ai-provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI Providers"
      >
        <div className="ai-provider-dialog__header">
          <span className="ai-provider-dialog__title">AI Providers</span>
          <button
            type="button"
            className="ai-provider-dialog__close"
            onClick={onClose}
            aria-label="Close AI Providers"
          >
            ×
          </button>
        </div>
        <AiProvidersSection />
      </div>
    </div>
  );
}
