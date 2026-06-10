import { X } from "lucide-react";
import type { AuthFlowMode } from "../cloud/auth";
import { AuthFlowSurface } from "./AuthFlowSurface";

interface AuthGateModalProps {
  isOpen: boolean;
  mode: AuthFlowMode;
  onClose: () => void;
  onModeChange(mode: AuthFlowMode): void;
  onAuthenticated(): void;
}

export function AuthGateModal({
  isOpen,
  mode,
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

      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.08] bg-[#16161a] p-8 shadow-2xl transition-all duration-300 md:max-w-lg">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
        <div className="absolute -right-20 -bottom-20 h-40 w-40 rounded-full bg-accent/10 blur-3xl pointer-events-none" />

        <button
          type="button"
          onClick={onClose}
          className="absolute right-6 top-6 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-white/50 hover:bg-white/[0.08] hover:text-white transition-all"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <AuthFlowSurface
          mode={mode}
          layout="modal"
          onModeChange={onModeChange}
          onAuthenticated={onAuthenticated}
        />
      </div>
    </div>
  );
}
