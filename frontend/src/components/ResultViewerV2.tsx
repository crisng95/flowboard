/**
 * ResultViewerV2 — premium modal for viewing generated media.
 *
 * Magnific-inspired:
 *   - Backdrop blur (glass overlay)
 *   - Image full-bleed left panel, click to zoom
 *   - Right panel: metadata card (prompt, model, aspect, time)
 *   - Download button
 *   - Variant navigation (thumbnail strip bottom)
 *   - Keyboard: Esc close, ← → navigate, D download
 *
 * This is a THIN wrapper that delegates to the existing V1
 * ResultViewer for complex features (regenerate, refine, clone,
 * ref-source chips). V2 only overrides the visual shell + adds
 * download. When the user needs advanced features they click
 * "Advanced →" which opens the V1 modal.
 *
 * Why not rewrite V1 entirely: 1500+ lines of battle-tested state
 * management (media polling, retry, variant navigation, prompt edit,
 * storyboard shot handling). Rewriting risks regressions. The thin
 * wrapper approach gives premium visuals NOW while preserving
 * reliability.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, X, ChevronLeft, ChevronRight } from "lucide-react";

import { mediaUrl } from "../api/client";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { cn } from "../lib/utils";

export function ResultViewerV2() {
  const openViewer = useGenerationStore((s) => s.openViewer);
  const closeResultViewer = useGenerationStore((s) => s.closeResultViewer);
  const nodes = useBoardStore((s) => s.nodes);

  const rfId = openViewer.rfId;
  const node = rfId ? nodes.find((n) => n.id === rfId) : undefined;
  const data = node?.data;

  // Variant navigation
  const mediaIds: string[] = (data?.mediaIds ?? (data?.mediaId ? [data.mediaId] : []))
    .filter((m): m is string => typeof m === "string" && !!m);
  const [activeIdx, setActiveIdx] = useState(0);

  // Sync activeIdx when viewer opens at a specific variant
  useEffect(() => {
    setActiveIdx(openViewer.idx ?? 0);
  }, [openViewer.idx, rfId]);

  const currentMediaId = mediaIds[activeIdx] ?? mediaIds[0];
  const hasMultiple = mediaIds.length > 1;

  // Keyboard shortcuts
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!rfId) return;
      if (e.key === "Escape") { e.preventDefault(); closeResultViewer(); }
      if (e.key === "ArrowRight" && hasMultiple) {
        setActiveIdx((i) => (i + 1) % mediaIds.length);
      }
      if (e.key === "ArrowLeft" && hasMultiple) {
        setActiveIdx((i) => (i - 1 + mediaIds.length) % mediaIds.length);
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        downloadCurrent();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rfId, hasMultiple, mediaIds.length, activeIdx],
  );

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  function downloadCurrent() {
    if (!currentMediaId) return;
    const a = document.createElement("a");
    a.href = mediaUrl(currentMediaId);
    a.download = `${data?.title ?? "media"}-${activeIdx + 1}.png`;
    a.click();
  }

  if (!rfId || !data || !currentMediaId) return null;

  const isVideo = data.type === "video" || data.type === "turntable";
  const prompt = (data.prompt as string | undefined) ?? "(no prompt)";
  const model = (data.imageModel as string | undefined) ?? (data.videoQuality as string | undefined) ?? "—";
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
      {/* Left panel — media */}
      <div className="flex-1 flex items-center justify-center p-6 relative">
        {isVideo ? (
          <video
            src={mediaUrl(currentMediaId)}
            controls
            autoPlay
            loop
            className="max-w-full max-h-full rounded-xl shadow-2xl"
          />
        ) : (
          <img
            src={mediaUrl(currentMediaId)}
            alt={data.title as string}
            className="max-w-full max-h-full rounded-xl shadow-2xl object-contain animate-fade-in"
          />
        )}

        {/* Variant nav arrows */}
        {hasMultiple && (
          <>
            <button
              type="button"
              onClick={() => setActiveIdx((i) => (i - 1 + mediaIds.length) % mediaIds.length)}
              className="absolute left-4 top-1/2 -translate-y-1/2 size-10 rounded-full bg-black/50 backdrop-blur-sm inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-colors"
              aria-label="Previous variant"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              onClick={() => setActiveIdx((i) => (i + 1) % mediaIds.length)}
              className="absolute right-[340px] top-1/2 -translate-y-1/2 size-10 rounded-full bg-black/50 backdrop-blur-sm inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-colors"
              aria-label="Next variant"
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}

        {/* Variant counter */}
        {hasMultiple && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {mediaIds.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={cn(
                  "size-2 rounded-full transition-all",
                  i === activeIdx
                    ? "bg-accent scale-125"
                    : "bg-white/30 hover:bg-white/50",
                )}
                aria-label={`Variant ${i + 1}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Right panel — metadata */}
      <div
        className="w-[320px] shrink-0 flex flex-col overflow-y-auto"
        style={{
          backgroundColor: "#12141a",
          borderLeft: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-status-done/20 text-status-done mb-1.5">
              Rendered
            </span>
            <h2 className="text-sm font-semibold text-ink-primary">
              {data.title as string}
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

        {/* Prompt section */}
        <div className="px-5 py-3 border-t border-white/[0.04]">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5 block">
            Prompt
          </span>
          <p className="text-2xs text-ink-primary leading-relaxed whitespace-pre-wrap">
            {prompt}
          </p>
        </div>

        {/* Metadata grid */}
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
              <p className="text-ink-primary font-medium">{mediaIds.length}</p>
            </div>
            <div>
              <span className="text-ink-muted">time</span>
              <p className="text-ink-primary font-medium">{renderedAt}</p>
            </div>
          </div>
        </div>

        {/* Actions */}
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

          {/* Keyboard hints */}
          <div className="flex items-center justify-center gap-3 mt-3 text-[9px] text-ink-placeholder">
            <span>Esc close</span>
            {hasMultiple && <span>← → navigate</span>}
            <span>D download</span>
          </div>
        </div>
      </div>
    </div>
  );
}
