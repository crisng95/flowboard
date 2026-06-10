/**
 * ResultViewerV2 - premium modal for viewing generated media.
 *
 * Magnific-inspired:
 *   - Backdrop blur (glass overlay)
 *   - Image full-bleed left panel, click to zoom
 *   - Right panel: metadata card (prompt, model, aspect, time)
 *   - Download button
 *   - Variant navigation (thumbnail strip bottom)
 *   - Keyboard: Esc close, left/right navigate, D download
 */
import { useCallback, useEffect, useState } from "react";
import { Download, X, ChevronLeft, ChevronRight } from "lucide-react";

import { mediaUrl } from "../api/client";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { cn } from "../lib/utils";

const VIDEO_MODEL_LABELS: Record<string, string> = {
  lite: "Lite",
  fast: "Fast",
  quality: "Quality",
  lite_relaxed: "Lite (Low Priority)",
  abra_r2v_4s: "Omni Flash · 4s",
  abra_r2v_6s: "Omni Flash · 6s",
  abra_r2v_8s: "Omni Flash · 8s",
  abra_r2v_10s: "Omni Flash · 10s",
};

function formatModelLabel(data: Record<string, unknown>): string {
  const imageModel = typeof data.imageModel === "string" ? data.imageModel : undefined;
  if (imageModel) return imageModel;
  const videoQuality = typeof data.videoQuality === "string" ? data.videoQuality : undefined;
  if (!videoQuality) return "—";
  return VIDEO_MODEL_LABELS[videoQuality] ?? videoQuality;
}

type ViewerEntry = {
  idx: number;
  kind: "image" | "video";
  title: string | null;
  text: string | null;
  mediaRef: string;
  posterUrl: string | null;
};

function isDirectUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveMediaSrc(value: string): string {
  return isDirectUrl(value) ? value : mediaUrl(value);
}

export function ResultViewerV2() {
  const openViewer = useGenerationStore((s) => s.openViewer);
  const closeResultViewer = useGenerationStore((s) => s.closeResultViewer);
  const nodes = useBoardStore((s) => s.nodes);

  const rfId = openViewer.rfId;
  const node = rfId ? nodes.find((n) => n.id === rfId) : undefined;
  const data = node?.data;
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    setActiveIdx(openViewer.idx ?? 0);
  }, [openViewer.idx, rfId]);

  const listEntries: ViewerEntry[] = data?.type === "list" && Array.isArray(data.listItems)
    ? data.listItems
        .map((rawItem, idx) => {
          const item = rawItem as Record<string, unknown>;
          const mediaRef = typeof item.mediaId === "string" && item.mediaId
            ? item.mediaId
            : typeof item.mediaUrl === "string" && item.mediaUrl
              ? item.mediaUrl
              : null;
          if (!mediaRef) return null;
          const kind = item.kind === "video" ? "video" : "image";
          return {
            idx,
            kind,
            title: typeof item.title === "string" ? item.title : null,
            text: typeof item.text === "string" ? item.text : null,
            mediaRef,
            posterUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
          } satisfies ViewerEntry;
        })
        .filter((item): item is ViewerEntry => item !== null)
    : [];

  const nodeEntries: ViewerEntry[] = listEntries.length > 0
    ? listEntries
    : (data?.mediaIds ?? (data?.mediaId ? [data.mediaId] : []))
        .filter((m): m is string => typeof m === "string" && !!m)
        .map((mediaRef, idx) => ({
          idx,
          kind: (data?.type as string) === "video" || (data?.type as string) === "turntable" ? "video" : "image",
          title: typeof data?.title === "string" ? data.title : null,
          text: null,
          mediaRef,
          posterUrl: null,
        }));

  const currentEntry = nodeEntries[activeIdx] ?? nodeEntries[0];
  const currentMediaRef = currentEntry?.mediaRef ?? null;
  const hasMultiple = nodeEntries.length > 1;

  const downloadCurrent = useCallback(() => {
    if (!currentMediaRef) return;
    const a = document.createElement("a");
    a.href = resolveMediaSrc(currentMediaRef);
    const extension = currentEntry?.kind === "video" ? "mp4" : "png";
    a.download = `${currentEntry?.title ?? data?.title ?? "media"}-${activeIdx + 1}.${extension}`;
    a.click();
  }, [activeIdx, currentEntry?.kind, currentEntry?.title, currentMediaRef, data?.title]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!rfId) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeResultViewer();
      }
      if (e.key === "ArrowRight" && hasMultiple) {
        setActiveIdx((i) => (i + 1) % nodeEntries.length);
      }
      if (e.key === "ArrowLeft" && hasMultiple) {
        setActiveIdx((i) => (i - 1 + nodeEntries.length) % nodeEntries.length);
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        downloadCurrent();
      }
    },
    [rfId, hasMultiple, nodeEntries.length, closeResultViewer, downloadCurrent],
  );

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  if (!rfId || !data || !currentMediaRef) return null;

  const nodeType = data.type as string;
  const isVideo = currentEntry.kind === "video" || nodeType === "video" || nodeType === "turntable";
  const prompt = currentEntry.text ?? (data.prompt as string | undefined) ?? "(no prompt)";
  const model = formatModelLabel(data as Record<string, unknown>);
  const aspect = (data.aspectRatio as string | undefined)?.replace("IMAGE_ASPECT_RATIO_", "").toLowerCase() ?? "—";
  const renderedAt = data.renderedAt
    ? new Date(data.renderedAt as string).toLocaleString()
    : "—";

  return (
    <div
      className="fixed inset-0 z-[300] flex"
      style={{
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeResultViewer();
      }}
    >
      <div className="flex-1 flex items-center justify-center p-6 relative">
        {isVideo ? (
          <video
            src={resolveMediaSrc(currentMediaRef)}
            controls
            autoPlay
            loop
            poster={currentEntry.posterUrl ?? undefined}
            className="max-w-full max-h-full rounded-xl shadow-2xl"
          />
        ) : (
          <img
            src={resolveMediaSrc(currentMediaRef)}
            alt={(currentEntry.title ?? data.title) as string}
            className="max-w-full max-h-full rounded-xl shadow-2xl object-contain animate-fade-in"
          />
        )}

        {hasMultiple && (
          <>
            <button
              type="button"
              onClick={() => setActiveIdx((i) => (i - 1 + nodeEntries.length) % nodeEntries.length)}
              className="absolute left-4 top-1/2 -translate-y-1/2 size-10 rounded-full bg-black/50 backdrop-blur-sm inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-colors"
              aria-label="Previous variant"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              onClick={() => setActiveIdx((i) => (i + 1) % nodeEntries.length)}
              className="absolute right-[340px] top-1/2 -translate-y-1/2 size-10 rounded-full bg-black/50 backdrop-blur-sm inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-colors"
              aria-label="Next variant"
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}

        {hasMultiple && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {nodeEntries.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={cn(
                  "size-2 rounded-full transition-all",
                  i === activeIdx ? "bg-accent scale-125" : "bg-white/30 hover:bg-white/50",
                )}
                aria-label={`Variant ${i + 1}`}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="w-[320px] shrink-0 flex flex-col overflow-y-auto"
        style={{
          backgroundColor: "#12141a",
          borderLeft: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-status-done/20 text-status-done mb-1.5">
              Rendered
            </span>
            <h2 className="text-sm font-semibold text-ink-primary">
              {(currentEntry.title ?? data.title) as string}
            </h2>
            <span className="text-2xs text-ink-muted font-mono">
              #{data.shortId}
            </span>
          </div>
          <button
            type="button"
            onClick={closeResultViewer}
            className="size-8 rounded-lg inline-flex items-center justify-center text-ink-muted hover:text-ink-primary hover:bg-white/[0.06] transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 border-t border-white/[0.04]">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5 block">
            Prompt
          </span>
          <p className="text-2xs text-ink-primary leading-relaxed whitespace-pre-wrap">
            {prompt}
          </p>
        </div>

        <div className="px-5 py-3 border-t border-white/[0.04]">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
            Metadata
          </span>
          <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-2xs">
            <div>
              <span className="text-ink-muted">model</span>
              <p className="text-ink-primary font-medium">{model}</p>
            </div>
            <div>
              <span className="text-ink-muted">aspect</span>
              <p className="text-ink-primary font-medium">{aspect}</p>
            </div>
            <div>
              <span className="text-ink-muted">variants</span>
              <p className="text-ink-primary font-medium">{nodeEntries.length}</p>
            </div>
            <div>
              <span className="text-ink-muted">time</span>
              <p className="text-ink-primary font-medium">{renderedAt}</p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-white/[0.04] mt-auto">
          <button
            type="button"
            onClick={downloadCurrent}
            className="w-full h-9 rounded-lg inline-flex items-center justify-center gap-2 text-xs font-medium text-white transition-all hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: "linear-gradient(135deg, #9d80ff 0%, #7c5cff 50%, #5e3ee5 100%)",
              boxShadow: "0 4px 14px rgba(124,92,255,0.35)",
            }}
          >
            <Download size={14} /> Download
          </button>

          <div className="flex items-center justify-center gap-3 mt-3 text-[9px] text-ink-placeholder">
            <span>Esc close</span>
            {hasMultiple && <span>Left/Right navigate</span>}
            <span>D download</span>
          </div>
        </div>
      </div>
    </div>
  );
}
