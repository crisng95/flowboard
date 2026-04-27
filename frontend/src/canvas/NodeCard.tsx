import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardStore, type FlowboardNodeData, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { mediaUrl, patchNode, uploadImage, uploadImageFromUrl } from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";

const ICON: Record<string, string> = {
  character: "◎",
  image: "▣",
  video: "▶",
  prompt: "✦",
  note: "✎",
  visual_asset: "◇",
};

const STATUS_COLOR: Record<string, string> = {
  idle: "transparent",
  queued: "rgba(245, 179, 1, 0.6)",
  running: "var(--accent)",
  done: "rgba(110, 231, 183, 0.8)",
  error: "#ef4444",
};

function StatusStrip({ status }: { status?: string }) {
  const color = STATUS_COLOR[status ?? "idle"] ?? "transparent";
  const isRunning = status === "running";
  return (
    <div
      className={isRunning ? "status-strip status-strip--running" : "status-strip"}
      style={{ background: color }}
    />
  );
}

const ACCEPT_MIME = "image/png,image/jpeg,image/webp,image/gif";

function BriefHint({ data }: { data: FlowboardNodeData }) {
  const status = data.aiBriefStatus;
  if (data.aiBrief) {
    return <p className="brief-hint" title={data.aiBrief}>✨ {data.aiBrief}</p>;
  }
  if (status === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ Analyzing…</p>;
  }
  return null;
}

function CharacterBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        status: "done",
        data: {
          title: data.title,
          prompt: data.prompt,
          mediaId: newMediaId,
          aiBrief: undefined,
          aspectRatio,
        },
      }).catch(() => {});
    }
    // Background vision call — fire-and-forget. Sets aiBrief on the node
    // when it returns; failure is silent.
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onPick() {
    fileInputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadOwn(f);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadOwn(f);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  // Filled state — show the avatar circle. Drag-drop on the avatar replaces it.
  if (mediaId) {
    return (
      <div
        className="node-body node-body--character"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div
          className={`character-avatar${dragOver ? " character-avatar--over" : ""}${uploading ? " character-avatar--uploading" : ""}`}
          onClick={onPick}
          role="button"
          aria-label="Replace character image"
          tabIndex={0}
        >
          <img
            className="character-avatar__img"
            src={mediaUrl(mediaId)}
            alt={data.title}
          />
          {uploading && <span className="character-drop__overlay">…</span>}
        </div>
        <BriefHint data={data} />
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_MIME}
          style={{ display: "none" }}
          onChange={onChange}
        />
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Empty state — compact action row (no oversized placeholder), but the
  // whole body still accepts drag-drop.
  return (
    <div
      className="node-body node-body--character"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div
        className={`character-empty${dragOver ? " character-empty--over" : ""}${isProcessing ? " character-empty--processing" : ""}`}
      >
        {isProcessing ? (
          <span className="visual-asset__hint">Generating…</span>
        ) : dragOver ? (
          <span className="visual-asset__hint">Drop image</span>
        ) : (
          <>
            <button
              type="button"
              className="visual-asset__action"
              onClick={onPick}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
            <button
              type="button"
              className="visual-asset__action"
              onClick={openGenerate}
              disabled={uploading}
            >
              Generate
            </button>
          </>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_MIME}
        style={{ display: "none" }}
        onChange={onChange}
      />
      {error && <p className="character-drop__error" role="alert">{error}</p>}
    </div>
  );
}

const MAX_IMG_RETRIES = 5;

function tileCountFor(data: FlowboardNodeData): number {
  const fromVariants = data.variantCount;
  const fromMedia = data.mediaIds?.length;
  const n = fromVariants && fromVariants > 0 ? fromVariants : fromMedia ?? 1;
  return Math.max(1, Math.min(n, 4));
}

function ImageTile({
  rfId,
  mediaId,
  isProcessing,
  alt,
  onClick,
}: {
  rfId: string;
  mediaId: string | undefined;
  isProcessing: boolean;
  alt: string;
  onClick?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId, rfId]);

  if (!mediaId) {
    return (
      <div
        className={`thumbnail-tile${isProcessing ? " thumbnail-tile--processing" : ""}`}
        aria-hidden="true"
      >
        <span className="thumbnail-tile__icon">▣</span>
      </div>
    );
  }

  const givenUp = attempt >= MAX_IMG_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `thumbnail-tile thumbnail-tile--filled` +
    (onClick ? " thumbnail-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Open variant ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && (
        <div className="thumbnail-tile__placeholder" aria-hidden="true" />
      )}
      {!givenUp && (
        <img
          key={attempt}
          className="thumbnail-tile__img"
          src={src}
          alt={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      )}
    </div>
  );
}

function ImageBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const isProcessing = data.status === "queued" || data.status === "running";

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const mid = ids[i];
    // Click a tile → open viewer at that variant. There is no "active /
    // selected variant" anymore — every variant is equally available
    // downstream (image refs send all, video can multi-select).
    const onClick = mid
      ? () => useGenerationStore.getState().openResultViewer(rfId, i)
      : undefined;
    tiles.push(
      <ImageTile
        key={i}
        rfId={rfId}
        mediaId={mid}
        isProcessing={isProcessing && !mid}
        alt={data.title}
        onClick={onClick}
      />
    );
  }

  return (
    <div className="node-body node-body--image">
      <div className={`thumbnail-grid thumbnail-grid--${tileCount}`}>
        {tiles}
      </div>
    </div>
  );
}

const MAX_VIDEO_RETRIES = 5;

function VideoTile({
  mediaId,
  isProcessing,
  isError,
  alt,
  onClick,
}: {
  mediaId: string | undefined;
  isProcessing: boolean;
  isError: boolean;
  alt: string;
  onClick?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId]);

  const placeholder = (
    <div
      className={`video-placeholder${isProcessing ? " video-placeholder--processing" : ""}${isError ? " video-placeholder--error" : ""}`}
      aria-hidden="true"
    >
      <span className="video-play">▶</span>
      <span className="video-duration">0:00</span>
    </div>
  );

  if (!mediaId) {
    // Pending tile — just the placeholder (with shimmer when processing).
    return <div className="video-tile">{placeholder}</div>;
  }

  const givenUp = attempt >= MAX_VIDEO_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `video-tile video-tile--filled` +
    (onClick ? " video-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Open variant ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && placeholder}
      {!givenUp && (
        <video
          key={attempt}
          className="node-card__thumbnail"
          data-kind="video"
          src={src}
          controls
          preload="metadata"
          muted
          aria-label={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoadedData={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      )}
    </div>
  );
}

function VideoBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const isProcessing = data.status === "queued" || data.status === "running";
  const isError = data.status === "error";

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const mid = ids[i];
    const onClick = mid
      ? () => useGenerationStore.getState().openResultViewer(rfId, i)
      : undefined;
    tiles.push(
      <VideoTile
        key={i}
        mediaId={mid}
        isProcessing={isProcessing && !mid}
        isError={isError && !mid}
        alt={data.title}
        onClick={onClick}
      />,
    );
  }

  return (
    <div className="node-body node-body--video">
      <div className={`video-grid video-grid--${tileCount}`}>
        {tiles}
      </div>
      {isError && data.error && (
        <p className="node-error" role="alert">{data.error}</p>
      )}
    </div>
  );
}

function VisualAssetBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refRefreshKey, setRefRefreshKey] = useState(0);
  const [refMediaId, setRefMediaId] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: [newMediaId],
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        status: "done",
        data: {
          title: data.title,
          prompt: data.prompt,
          mediaId: newMediaId,
          mediaIds: [newMediaId],
          variantCount: 1,
          aiBrief: undefined,
          aspectRatio,
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadFromLink(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImageFromUrl(
        trimmed,
        projectId,
        isNaN(dbId) ? undefined : dbId,
      );
      persistMedia(resp.media_id, resp.aspect_ratio);
      setLinkMode(false);
      setLinkValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "link upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadRef(file: File) {
    setError(null);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const resp = await uploadImage(file, projectId);
      setRefMediaId(resp.media_id);
      setRefRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ref upload failed");
    }
  }

  async function submitRefine() {
    if (!mediaId) return;
    if (!refinePrompt.trim()) return;
    await useGenerationStore.getState().refineImage(rfId, {
      prompt: refinePrompt.trim(),
      refMediaIds: refMediaId ? [refMediaId] : [],
    });
    setRefineOpen(false);
    setRefinePrompt("");
    setRefMediaId(null);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  if (!mediaId) {
    return (
      <div className="node-body node-body--visual-asset">
        <div
          className={`visual-asset__empty${isProcessing ? " visual-asset__empty--processing" : ""}`}
        >
          {isProcessing ? (
            <span className="visual-asset__hint">Generating…</span>
          ) : linkMode ? (
            <div className="visual-asset__link-row">
              <input
                type="url"
                className="visual-asset__link-input"
                placeholder="https://… (png/jpg/webp)"
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") uploadFromLink(linkValue);
                  if (e.key === "Escape") {
                    setLinkMode(false);
                    setLinkValue("");
                    setError(null);
                  }
                }}
                disabled={uploading}
                autoFocus
              />
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => uploadFromLink(linkValue)}
                disabled={uploading || !linkValue.trim()}
              >
                {uploading ? "Fetching…" : "Save"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setLinkMode(false);
                  setLinkValue("");
                  setError(null);
                }}
                disabled={uploading}
              >
                ×
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setError(null);
                  setLinkMode(true);
                }}
                disabled={uploading}
              >
                Add link
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={openGenerate}
                disabled={uploading}
              >
                Generate
              </button>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadOwn(f);
            e.target.value = "";
          }}
        />
        {error && <p className="visual-asset__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="node-body node-body--visual-asset node-body--visual-asset-with-media">
      <div className="visual-asset__media">
        <img
          className="visual-asset__image"
          src={mediaUrl(mediaId)}
          alt={data.title}
        />
        {!isProcessing && (
          <button
            type="button"
            className="visual-asset__refine-btn"
            onClick={() => setRefineOpen((o) => !o)}
            aria-label="Refine image"
          >
            Refine
          </button>
        )}
      </div>
      <BriefHint data={data} />
      {refineOpen && (
        <div className="visual-asset__refine-panel" role="region" aria-label="Refine">
          <textarea
            className="visual-asset__refine-textarea"
            placeholder="Describe the change…"
            rows={2}
            value={refinePrompt}
            onChange={(e) => setRefinePrompt(e.target.value)}
          />
          <div className="visual-asset__refine-actions">
            <button
              type="button"
              className="visual-asset__refine-ref"
              onClick={() => refInputRef.current?.click()}
            >
              {refMediaId ? `Ref ✓ (${refRefreshKey})` : "Add ref"}
            </button>
            <button
              type="button"
              className="visual-asset__refine-submit"
              disabled={!refinePrompt.trim()}
              onClick={submitRefine}
            >
              Refine →
            </button>
          </div>
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadRef(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {error && <p className="visual-asset__error">{error}</p>}
    </div>
  );
}

function PromptBody({ data }: { data: FlowboardNodeData }) {
  return (
    <div className="node-body node-body--prompt">
      <pre className="prompt-text">{data.prompt ?? "(no prompt)"}</pre>
    </div>
  );
}

function NoteBody({ data }: { data: FlowboardNodeData }) {
  return (
    <div className="node-body node-body--note">
      <p className="note-text">{data.prompt ?? data.title}</p>
    </div>
  );
}

function NodeBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  switch (data.type) {
    case "character":
      return <CharacterBody rfId={rfId} data={data} />;
    case "image":
      return <ImageBody rfId={rfId} data={data} />;
    case "video":
      return <VideoBody rfId={rfId} data={data} />;
    case "prompt":
      return <PromptBody data={data} />;
    case "note":
      return <NoteBody data={data} />;
    case "visual_asset":
      return <VisualAssetBody rfId={rfId} data={data} />;
  }
}

function downloadExt(type: string): string {
  if (type === "video") return "mp4";
  return "png";
}

export function NodeCard(props: NodeProps<FlowNode>) {
  const data = props.data;
  const isNote = data.type === "note";
  const isGenerable = ["image", "prompt", "video", "visual_asset", "character"].includes(data.type);
  const isRunning = data.status === "running";
  const downloadable = !!data.mediaId && data.type !== "prompt" && data.type !== "note";

  function handleGenerate(e: React.MouseEvent) {
    e.stopPropagation();
    useGenerationStore.getState().openGenerationDialog(props.id, data.prompt ?? "");
  }

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    if (!data.mediaId) return;
    // `<a download>` only honours the suggested filename when the resource is
    // same-origin — `/media/<id>` *is* same-origin (proxied by FastAPI), so
    // the title-based filename will stick. Falls back to `image.png` etc.
    const a = document.createElement("a");
    a.href = mediaUrl(data.mediaId);
    const safeTitle = (data.title || data.type).replace(/[^A-Za-z0-9_-]+/g, "_");
    a.download = `${safeTitle}-${data.shortId}.${downloadExt(data.type)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className={`node-card${isNote ? " node-card--note" : ""}${props.selected ? " node-card--selected" : ""}`}>
      <StatusStrip status={data.status} />
      <Handle type="target" position={Position.Left} className="node-handle" />

      <div className="node-header">
        <span className="node-icon" aria-hidden="true">{ICON[data.type] ?? "□"}</span>
        <span className="node-title">{data.title}</span>
        <span className="node-short-id">#{data.shortId}</span>
      </div>

      {isGenerable && (
        <button
          className={`node-card__gen${isRunning ? " node-card__gen--running" : ""}`}
          onClick={handleGenerate}
          aria-label="Generate from this node"
          tabIndex={0}
        >
          ▶
        </button>
      )}

      {downloadable && (
        <button
          className="node-card__download"
          onClick={handleDownload}
          aria-label="Download media"
          title="Download"
          tabIndex={0}
        >
          ⬇
        </button>
      )}

      <NodeBody rfId={props.id} data={data} />

      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  );
}
