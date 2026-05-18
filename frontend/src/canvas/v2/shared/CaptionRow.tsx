/**
 * CaptionRow — persistent caption strip rendered below a node's media
 * slot. State-aware: shows upload progress, vision-analysing, or the
 * final aiBrief. Shared between Reference / Concept / Multi-view /
 * Part / Variant nodes so the caption rhythm + iconography is
 * consistent across the canvas.
 *
 * Stable vertical rhythm: always `mt-3 text-2xs` so the card height
 * doesn't jitter when the caption swaps copy.
 */
import { Loader2, Sparkles } from "lucide-react";

import type { FlowboardNodeData } from "../../../store/board";

export type BodyState =
  | "empty"
  | "uploading"
  | "processing"
  | "filled"
  | "error";

export interface CaptionRowProps {
  data: FlowboardNodeData;
  bodyState: BodyState;
}

export function CaptionRow({ data, bodyState }: CaptionRowProps) {
  if (bodyState === "uploading") {
    return (
      <p className="mt-3 text-2xs text-ink-muted flex items-center gap-1.5">
        <Loader2 size={10} strokeWidth={2} className="animate-spin text-accent" />
        Uploading to project…
      </p>
    );
  }
  if (bodyState === "error") return null; // overlay carries the error
  if (bodyState === "processing") return null;

  if (data.aiBriefStatus === "pending" && !data.aiBrief) {
    return (
      <p className="mt-3 text-2xs text-ink-muted flex items-center gap-1.5">
        <Sparkles size={10} className="text-accent animate-pulse-soft" />
        Analysing image…
      </p>
    );
  }
  if (data.aiBrief) {
    return (
      <p
        className="mt-3 text-2xs leading-relaxed text-ink-muted line-clamp-2"
        title={data.aiBrief}
      >
        <Sparkles size={10} className="inline mr-1.5 text-accent" />
        {data.aiBrief}
      </p>
    );
  }
  return null;
}
