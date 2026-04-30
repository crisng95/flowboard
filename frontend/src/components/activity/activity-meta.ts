// Static maps for type → icon/label and status → color/icon. Kept in
// one file so adding a new activity type means touching one place.

export const ACTIVITY_TYPE_META: Record<
  string,
  { icon: string; label: string; group: "llm" | "gen" | "upload" }
> = {
  auto_prompt:       { icon: "✨", label: "Auto-Prompt",        group: "llm" },
  auto_prompt_batch: { icon: "✨", label: "Auto-Prompt (batch)", group: "llm" },
  vision:            { icon: "👁",  label: "Vision",             group: "llm" },
  planner:           { icon: "💬", label: "Planner",            group: "llm" },
  gen_image:         { icon: "🖼",  label: "Generate image",     group: "gen" },
  gen_video:         { icon: "🎬", label: "Generate video",     group: "gen" },
  edit_image:        { icon: "✏",  label: "Edit image",         group: "gen" },
  upload:            { icon: "⬆",  label: "Upload (file)",      group: "upload" },
  upload_url:        { icon: "🔗", label: "Upload (link)",      group: "upload" },
};

// Fallback for unknown types — keeps the UI rendering forward-compat
// when the backend ships a new type before the frontend catches up.
export function metaFor(type: string) {
  return (
    ACTIVITY_TYPE_META[type] ?? { icon: "•", label: type, group: "llm" as const }
  );
}

export const STATUS_META: Record<
  string,
  { icon: string; label: string; tone: "muted" | "running" | "ok" | "fail" }
> = {
  queued:  { icon: "⋯", label: "queued",  tone: "muted" },
  running: { icon: "⟳", label: "running", tone: "running" },
  done:    { icon: "✓", label: "done",    tone: "ok" },
  failed:  { icon: "✗", label: "failed",  tone: "fail" },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { icon: "•", label: status, tone: "muted" as const };
}

export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${min}m ${s}s`;
}
