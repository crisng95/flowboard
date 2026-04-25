import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardStore, type FlowboardNodeData, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { mediaUrl, patchNode, uploadImage } from "../api/client";

const ICON: Record<string, string> = {
  character: "◎",
  image: "▣",
  video: "▶",
  prompt: "✦",
  note: "✎",
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

function CharacterBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
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
      // Optimistic local update so the image renders immediately.
      useBoardStore.getState().updateNodeData(rfId, { mediaId: resp.media_id });
      // Persist mediaId so the node survives reload.
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          data: {
            title: data.title,
            prompt: data.prompt,
            mediaId: resp.media_id,
          },
        }).catch(() => {
          // Non-fatal — local state is still correct for this session.
        });
      }
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
    if (f) handleFile(f);
    // Reset so picking the same file twice still triggers change.
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
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

  const dropClass = `character-drop${dragOver ? " character-drop--over" : ""}${uploading ? " character-drop--uploading" : ""}`;

  return (
    <div className="node-body node-body--character">
      {mediaId ? (
        <div
          className={dropClass}
          onClick={onPick}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          role="button"
          aria-label="Replace character image"
          tabIndex={0}
        >
          <img
            className="thumbnail-circle thumbnail-circle--filled"
            src={mediaUrl(mediaId)}
            alt={data.title}
          />
          {uploading && <span className="character-drop__overlay">…</span>}
        </div>
      ) : (
        <div
          className={dropClass}
          onClick={onPick}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          role="button"
          aria-label="Upload character image"
          tabIndex={0}
        >
          <div className="thumbnail-circle" aria-hidden="true" />
          <span className="character-drop__hint">
            {uploading ? "Uploading…" : dragOver ? "Drop image" : "Click or drop image"}
          </span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_MIME}
        style={{ display: "none" }}
        onChange={onChange}
      />
      {error && <p className="character-drop__error" role="alert">{error}</p>}
      {data.prompt && <p className="node-description">{data.prompt}</p>}
    </div>
  );
}

function ImageBodyPlaceholder() {
  return (
    <div className="thumbnail-grid">
      <div className="thumbnail-tile" aria-hidden="true" />
      <div className="thumbnail-tile" aria-hidden="true" />
      <div className="thumbnail-tile" aria-hidden="true" />
      <div className="thumbnail-tile" aria-hidden="true" />
    </div>
  );
}

const MAX_IMG_RETRIES = 5;

function ImageBody({ data }: { data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset loader state when media id changes (new generation, page load, etc.)
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

  if (!mediaId) {
    return (
      <div className="node-body node-body--image">
        <ImageBodyPlaceholder />
      </div>
    );
  }

  const givenUp = attempt >= MAX_IMG_RETRIES;
  // Cache-bust on retry so the browser re-fetches the cached-404 response.
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);

  return (
    <div className="node-body node-body--image node-body--image-with-media">
      {!loaded && <ImageBodyPlaceholder />}
      {!givenUp && (
        <img
          key={attempt}
          className="node-card__thumbnail"
          src={src}
          alt={data.title as string}
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

const MAX_VIDEO_RETRIES = 5;

function VideoBody({ data }: { data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset loader state when media id changes
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
    <div className="video-placeholder" aria-hidden="true">
      <span className="video-play">▶</span>
      <span className="video-duration">0:00</span>
    </div>
  );

  if (!mediaId) {
    return (
      <div className="node-body node-body--video">
        {placeholder}
      </div>
    );
  }

  const givenUp = attempt >= MAX_VIDEO_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);

  return (
    <div className="node-body node-body--video node-body--video-with-media">
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
          aria-label={data.title as string}
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
      return <ImageBody data={data} />;
    case "video":
      return <VideoBody data={data} />;
    case "prompt":
      return <PromptBody data={data} />;
    case "note":
      return <NoteBody data={data} />;
  }
}

export function NodeCard(props: NodeProps<FlowNode>) {
  const data = props.data;
  const isNote = data.type === "note";
  const isGenerable = ["image", "prompt", "video"].includes(data.type);
  const isRunning = data.status === "running";

  function handleGenerate(e: React.MouseEvent) {
    e.stopPropagation();
    useGenerationStore.getState().openGenerationDialog(props.id, data.prompt ?? "");
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

      <NodeBody rfId={props.id} data={data} />

      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  );
}
