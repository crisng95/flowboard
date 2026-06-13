import { X } from "lucide-react";
import type { AuthFlowMode } from "../cloud/auth";
import { AuthFlowSurface } from "./AuthFlowSurface";

interface AuthGateModalProps {
  isOpen: boolean;
  mode: AuthFlowMode;
  notice?: string | null;
  onClose: () => void;
  onModeChange(mode: AuthFlowMode): void;
  onAuthenticated(): void;
}

export function AuthGateModal({
  isOpen,
  mode,
  notice,
  onClose,
  onModeChange,
  onAuthenticated,
}: AuthGateModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/72 backdrop-blur-md transition-opacity duration-300"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm md:max-w-md">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-white/50 hover:bg-white/[0.08] hover:text-white transition-all"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <AuthFlowSurface
          mode={mode}
          notice={notice}
          onModeChange={onModeChange}
          onAuthenticated={onAuthenticated}
        />
      </div>
    </div>
  );
}
