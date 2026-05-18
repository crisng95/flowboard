/**
 * ErrorOverlay — full-slot error treatment with retry + dismiss.
 *
 * Used by every V2 node when a local upload or generation step fails.
 * Renders an alert icon, the error message (multi-line, breaks long
 * codes), a Retry button that re-opens the file picker, and an X to
 * dismiss the error so the user can fall back to the empty state.
 *
 * Stops click propagation on its own click handler so triggering
 * Retry inside a slot that ALSO opens a viewer on click doesn't fire
 * both.
 */
import { AlertCircle, Upload, X } from "lucide-react";

export interface ErrorOverlayProps {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}

export function ErrorOverlay({ message, onRetry, onDismiss }: ErrorOverlayProps) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center"
      style={{ backgroundColor: "rgba(239, 68, 68, 0.08)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <AlertCircle size={20} strokeWidth={1.75} className="text-red-400" />
      <p className="text-2xs text-red-300 leading-snug max-w-full break-words">
        {message}
      </p>
      <div className="flex items-center gap-1 mt-1">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-md px-2 h-6 text-2xs font-medium bg-red-500/15 text-red-200 hover:bg-red-500/25 border border-red-500/30 transition-colors"
        >
          <Upload size={11} strokeWidth={2} /> Retry
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="inline-flex items-center justify-center size-6 rounded-md text-ink-muted hover:bg-white/[0.06] hover:text-ink-primary transition-colors"
        >
          <X size={11} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
