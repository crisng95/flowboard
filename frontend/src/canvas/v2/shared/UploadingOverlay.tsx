/**
 * UploadingOverlay — full-slot overlay shown while a file is POSTing.
 *
 * Two-tier feedback: a soft skeleton pulse reserves visual weight so
 * the slot doesn't collapse, and an explicit spinner + label tells
 * the user network IO is in flight (not just "thinking").
 */
import { Loader2 } from "lucide-react";

export function UploadingOverlay() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-2/80 backdrop-blur-[2px]">
      <div
        className="absolute inset-0 animate-pulse-soft"
        style={{ backgroundColor: "#1f232c" }}
      />
      <Loader2
        size={20}
        strokeWidth={2}
        className="animate-spin text-accent relative z-10"
      />
      <span className="text-2xs text-ink-primary font-medium relative z-10">
        Uploading…
      </span>
    </div>
  );
}
