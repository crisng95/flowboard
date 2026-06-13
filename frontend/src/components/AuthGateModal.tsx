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
