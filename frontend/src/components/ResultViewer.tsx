import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore } from "../store/board";
import { useSettingsStore } from "../store/settings";
import { getMediaStatus, mediaUrl, type MediaStatus } from "../api/client";

const ICON: Record<string, string> = {
  character: "◎",
  image: "▣",
  video: "▶",
  prompt: "✦",
  note: "✎",
};

/** Format Flow's aspect-ratio enum to the human label shown on the node
 *  card. Returns "—" when the value is missing or unrecognised so the
 *  metadata grid never displays a stale hardcoded fallback. */
function formatAspectRatio(value: string | undefined): string {
  switch (value) {
    case "IMAGE_ASPECT_RATIO_LANDSCAPE":
    case "VIDEO_ASPECT_RATIO_LANDSCAPE":
      return "16:9";
    case "IMAGE_ASPECT_RATIO_PORTRAIT":
    case "VIDEO_ASPECT_RATIO_PORTRAIT":
      return "9:16";
    case "IMAGE_ASPECT_RATIO_SQUARE":
      return "1:1";
    default:
      return "—";
  }
}

/** Format an ISO timestamp as a Vietnamese relative time string —
 *  "vừa xong", "5 phút trước", "2 giờ trước", "3 ngày trước". Falls
 *  back to "—" when the timestamp is missing or unparseable. */
function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "vừa xong";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} giờ trước`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} ngày trước`;
  return new Date(t).toLocaleDateString("vi-VN");
}

export function ResultViewer() {
  const openViewer = useGenerationStore((s) => s.openViewer);
  const closeResultViewer = useGenerationStore((s) => s.closeResultViewer);
  const openGenerationDialog = useGenerationStore((s) => s.openGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const projectId = useGenerationStore((s) => s.projectId);
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const settingsImageModel = useSettingsStore((s) => s.imageModel);
  const settingsVideoQuality = useSettingsStore((s) => s.videoQuality);

  const [activeIdx, setActiveIdx] = useState(0);
  const [mediaReady, setMediaReady] = useState(false);
  const [cacheKey, setCacheKey] = useState(0);
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rfId = openViewer.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const data = node?.data;
  const mediaIds = data?.mediaIds ?? (data?.mediaId ? [data.mediaId] : []);

  // METADATA model label — image / character / visual_asset render
  // through the user's chosen image checkpoint, video routes through
  // the Veo quality preset. Falls back to "—" for non-renderable
  // node types (prompt, note) so the row stays present but neutral.
  const metadataModel =
    data?.type === "video"
      ? settingsVideoQuality === "lite"
        ? "Veo 3.1 Lite"
        : "Veo 3.1 Fast"
      : data && ["image", "character", "visual_asset"].includes(data.type)
        ? settingsImageModel
        : "—";

  // Upstream nodes feeding this one as reference images (image/video target).
  const REF_TYPES = new Set(["character", "image", "visual_asset"]);
  const refSourceNodes = rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter(
          (n): n is NonNullable<typeof n> =>
            !!n &&
            REF_TYPES.has(n.data.type) &&
            typeof n.data.mediaId === "string" &&
            n.data.mediaId.length > 0,
        )
    : [];

  const currentMediaId = rfId && data ? (data.mediaIds?.[activeIdx] ?? data.mediaId ?? null) : null;

  // Reset active variant index and media state when viewer opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      // Honor the idx the caller passed via openResultViewer(rfId, idx)
      // so clicking a specific tile in the node card opens at that
      // variant. Bound by current mediaIds length (best-effort).
      setActiveIdx(openViewer.idx ?? 0);
      setMediaReady(false);
      setStatus(null);
      triggerRef.current = document.activeElement;
    } else {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    }
  }, [rfId]);

  // Reset media state when active variant changes
  useEffect(() => {
    setMediaReady(false);
    setStatus(null);
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [currentMediaId]);

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeResultViewer();
      }
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(mediaIds.length, 1));
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + Math.max(mediaIds.length, 1)) % Math.max(mediaIds.length, 1));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

  if (rfId === null || !data) return null;

  const isVideo = data.type === "video";
  const shortMediaId = currentMediaId ? `${currentMediaId.slice(0, 12)}…` : "pending";

  const cacheBust = cacheKey > 0 ? `?t=${cacheKey}` : "";

  function onImgLoad() {
    setMediaReady(true);
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function onImgError() {
    if (!currentMediaId) return;
    setMediaReady(false);
    if (pollTimerRef.current !== null) return; // already polling
    const mid = currentMediaId;
    pollTimerRef.current = setInterval(async () => {
      try {
        const s = await getMediaStatus(mid);
        setStatus(s);
        if (s.available) {
          setCacheKey((k) => k + 1);
          setMediaReady(true);
          if (pollTimerRef.current !== null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      } catch {
        // ignore transient errors; keep polling
      }
    }, 2000);
  }

  function handleRefresh() {
    setCacheKey((k) => k + 1);
  }

  let hintText: string;
  if (status === null) {
    hintText = "Loading…";
  } else if (!status.has_url) {
    hintText = "Open your project on labs.google/flow so Flowboard can capture the image URL.";
  } else {
    hintText = "Fetching bytes from Google…";
  }

  function handleRegenerate() {
    if (!rfId || !data) return;
    // Carry forward the node's persisted setup so regenerate matches the
    // original generation. Without this we silently snap to LANDSCAPE / 1
    // variant — wrong for portrait/square shots, character refs (square),
    // and multi-variant batches.
    const aspectRatio =
      typeof data.aspectRatio === "string" ? data.aspectRatio : undefined;
    const variantCount =
      typeof data.variantCount === "number" && data.variantCount > 0
        ? data.variantCount
        : 1;

    // Critical: video nodes must dispatch with `kind: "video"` AND the
    // upstream source(s). Without `kind`, the store falls back to
    // gen_image — silently produces a still image, overwriting the
    // actual video result on the node.
    if (data.type === "video") {
      const upstreamEdge = edges.find((e) => e.target === rfId);
      const upstreamNode = upstreamEdge
        ? nodes.find((n) => n.id === upstreamEdge.source)
        : undefined;
      // Prefer the full variant list so batch i2v re-runs all N sources;
      // fall back to the singular mediaId for legacy single-source nodes.
      const sourceMediaIds: string[] =
        upstreamNode?.data.mediaIds ??
        (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);
      if (sourceMediaIds.length === 0) {
        useGenerationStore.setState({
          error: "Video re-gen needs an upstream image with rendered media.",
        });
        return;
      }
      const useMulti = sourceMediaIds.length > 1;
      dispatchGeneration(rfId, {
        prompt: data.prompt ?? "",
        kind: "video",
        sourceMediaId: useMulti ? undefined : sourceMediaIds[0],
        sourceMediaIds: useMulti ? sourceMediaIds : undefined,
        aspectRatio,
        variantCount: sourceMediaIds.length,
      });
      return;
    }
    dispatchGeneration(rfId, {
      prompt: data.prompt ?? "",
      aspectRatio,
      variantCount,
    });
  }

  function handleEditPrompt() {
    if (!rfId || !data) return;
    closeResultViewer();
    openGenerationDialog(rfId, data.prompt ?? "");
  }

  async function handleNewVariant() {
    if (!rfId) return;
    const newRfId = await useBoardStore
      .getState()
      .cloneNodeWithUpstream(rfId);
    if (!newRfId) return;
    closeResultViewer();
    // Open the gen dialog on the fresh sibling so the user can hit
    // Generate immediately (or tweak prompt first) — that's the natural
    // next step after cloning.
    openGenerationDialog(newRfId, data?.prompt ?? "");
  }

  return (
    <div
      className="result-viewer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeResultViewer();
      }}
    >
      <div
        className="result-viewer"
        role="dialog"
        aria-labelledby="result-viewer-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Left panel — media tile */}
        <div className="result-viewer__left">
          <div
            className="media-placeholder"
            role={mediaReady ? undefined : "img"}
            aria-label={mediaReady ? undefined : `${data.title} — media pending`}
          >
            {currentMediaId ? (
              <>
                {/* Single media element — always mounted so load/error fires once and
                    there's no flicker from mount/unmount on state flip. */}
                {isVideo ? (
                  <video
                    className="media-placeholder__video"
                    style={mediaReady ? undefined : { display: "none" }}
                    src={mediaUrl(currentMediaId) + cacheBust}
                    controls
                    preload="metadata"
                    onError={onImgError}
                    onLoadedData={onImgLoad}
                  />
                ) : (
                  <img
                    className="media-placeholder__img"
                    style={mediaReady ? undefined : { display: "none" }}
                    src={mediaUrl(currentMediaId) + cacheBust}
                    alt={data.title as string}
                    onError={onImgError}
                    onLoad={onImgLoad}
                  />
                )}
                {!mediaReady && (
                  <div className="media-placeholder__content">
                    <span className="media-placeholder__icon" aria-hidden="true">
                      {ICON[data.type] ?? "□"}
                    </span>
                    <span className="media-placeholder__title">{data.title}</span>
                    <span className="media-placeholder__id">media_id: {shortMediaId}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="media-placeholder__content">
                <span className="media-placeholder__icon" aria-hidden="true">
                  {ICON[data.type] ?? "□"}
                </span>
                <span className="media-placeholder__title">{data.title}</span>
                <span className="media-placeholder__id">media_id: {shortMediaId}</span>
              </div>
            )}
          </div>

          {currentMediaId && !mediaReady && (
            <p className="media-placeholder__hint">{hintText}</p>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {currentMediaId && (
              <button className="media-placeholder__refresh" onClick={handleRefresh}>
                Refresh
              </button>
            )}
            {/* Variant switcher */}
            {mediaIds.length > 0 && (
              <div className="variant-switcher" role="group" aria-label="Variant selection">
                {mediaIds.map((_, idx) => (
                  <button
                    key={idx}
                    className={`variant-switcher__chip${idx === activeIdx ? " variant-switcher__chip--active" : ""}`}
                    onClick={() => setActiveIdx(idx)}
                    aria-label={`Variant ${idx + 1}`}
                    aria-pressed={idx === activeIdx}
                  >
                    {idx + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — metadata */}
        <div className="result-viewer__right">
          <div className="result-viewer__status-pill">Rendered</div>

          <h2 id="result-viewer-title" className="result-viewer__node-title">
            {data.title}
          </h2>
          <span className="result-viewer__node-id">#{data.shortId}</span>

          <hr className="result-viewer__divider" />

          <span className="result-viewer__section-label">PROMPT</span>
          <p className="result-viewer__prompt">{data.prompt ?? "(no prompt)"}</p>
          <button className="result-viewer__edit-prompt" onClick={handleEditPrompt}>
            Edit prompt →
          </button>

          {refSourceNodes.length > 0 && (
            <>
              <hr className="result-viewer__divider" />
              <span className="result-viewer__section-label">
                SOURCE REFERENCES ({refSourceNodes.length})
              </span>
              <div className="ref-source-row">
                {refSourceNodes.map((n) => (
                  <div key={n.id} className="ref-source-chip" title={n.data.title}>
                    <img
                      className="ref-source-chip__img"
                      src={mediaUrl(n.data.mediaId as string)}
                      alt={n.data.title}
                    />
                    <span className="ref-source-chip__id">#{n.data.shortId}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <hr className="result-viewer__divider" />

          <span className="result-viewer__section-label">METADATA</span>
          <dl className="result-viewer__metadata-grid">
            <dt>model</dt>
            <dd>{metadataModel}</dd>
            <dt>aspect</dt>
            <dd>{formatAspectRatio(data?.aspectRatio)}</dd>
            <dt>time</dt>
            <dd>{formatRelativeTime(data?.renderedAt)}</dd>
          </dl>

          <div className="result-viewer__actions">
            <button className="result-viewer__btn result-viewer__btn--primary" onClick={handleRegenerate}>
              Regenerate ⌘R
            </button>
            <button
              className="result-viewer__btn"
              onClick={handleNewVariant}
              title="Clone this node onto the canvas with the same upstream refs"
            >
              New variant +
            </button>
            {projectId ? (
              <a
                className="result-viewer__btn result-viewer__btn--link"
                href={`https://labs.google/fx/tools/flow/project/${projectId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Flow ↗
              </a>
            ) : (
              <button className="result-viewer__btn" disabled>
                Open in Flow ↗
              </button>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <div className="result-viewer__footer-hint">
          esc close · ←/→ variants
        </div>

        {/* Close button */}
        <button
          className="result-viewer__close"
          onClick={closeResultViewer}
          aria-label="Close result viewer"
        >
          ×
        </button>
      </div>
    </div>
  );
}
