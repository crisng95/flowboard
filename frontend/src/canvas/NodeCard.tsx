import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardStore, type FlowboardNodeData, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { mediaUrl, patchEdge, patchNode, uploadImage, uploadImageFromUrl } from "../api/client";
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
  if (data.autoPromptStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ Composing prompt…</p>;
  }
  if (data.aiBriefStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ Analyzing…</p>;
  }
  if (data.aiBrief) {
    return <p className="brief-hint" title={data.aiBrief}>✨ {data.aiBrief}</p>;
  }
  return null;
}

/**
 * True while the LLM layer is doing work on this node — composing an
 * auto-prompt or describing media for an aiBrief. Used to add a busy
 * treatment + disable Generate so the user can't double-fire.
 */
function isLLMBusy(data: FlowboardNodeData): boolean {
  return (
    data.autoPromptStatus === "pending"
    || data.aiBriefStatus === "pending"
  );
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
      // Backend merges `data`, so we only need to send the deltas.
      // `null` is the explicit "clear this key" sentinel — undefined
      // gets dropped by JSON.stringify and would leave the stale brief
      // in place after the merge.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
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
  onUseAsRef,
}: {
  rfId: string;
  mediaId: string | undefined;
  isProcessing: boolean;
  alt: string;
  onClick?: () => void;
  /** When provided, render an overlay button on hover that pins this
   * variant to a downstream edge and triggers Generate on the target.
   * The parent only sets this when the node has multi-variant output
   * AND has a downstream image/video target — keeps the affordance
   * scoped to cases where it actually does something. */
  onUseAsRef?: () => void;
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
      {onUseAsRef && (
        // Overlay action — visible on hover via CSS. Stops propagation
        // so clicking the chip doesn't also trigger the tile's
        // openResultViewer. Title doubles as accessible label.
        <button
          type="button"
          className="thumbnail-tile__use-btn"
          onClick={(e) => {
            e.stopPropagation();
            onUseAsRef();
          }}
          title="Use this variant as the reference for a downstream node"
          aria-label="Use this variant as reference"
        >
          Use →
        </button>
      )}
    </div>
  );
}

// ── Variant-click → bind upstream variant to a downstream edge ───────────
//
// Workflow: user clicks "Use →" on a specific variant tile of an
// upstream multi-variant node. We find the downstream image/video
// targets connected to it, pin the chosen variant index on the right
// edge (PATCH /api/edges/{id}), refresh the local edge.data so the
// `v{N+1}` chip surfaces immediately, and then dispatch Generate on
// the target. One click → one pinned ref → one Flow API call.
//
// Multi-target case: when the upstream has 2+ outgoing edges to gen
// targets, we surface a small picker so the user disambiguates which
// downstream this variant should feed.

interface VariantTarget {
  edgeId: string;
  targetRfId: string;
  title: string;
  kind: "image" | "video";
  hasPrompt: boolean;
}

interface VariantPickerState {
  variantIdx: number;
  targets: VariantTarget[];
}

function collectGenTargets(srcRfId: string): VariantTarget[] {
  const { nodes, edges } = useBoardStore.getState();
  const out: VariantTarget[] = [];
  for (const e of edges) {
    if (e.source !== srcRfId) continue;
    const t = nodes.find((n) => n.id === e.target);
    if (!t) continue;
    if (t.data.type !== "image" && t.data.type !== "video") continue;
    out.push({
      edgeId: e.id,
      targetRfId: t.id,
      title: t.data.title || `#${t.data.shortId}`,
      kind: t.data.type as "image" | "video",
      hasPrompt: typeof t.data.prompt === "string" && t.data.prompt.trim().length > 0,
    });
  }
  return out;
}

async function applyVariantToTarget(variantIdx: number, target: VariantTarget) {
  const edgeDbId = parseInt(target.edgeId, 10);
  if (!isNaN(edgeDbId)) {
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(target.edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }
  // If the target doesn't have a prompt yet, we open the GenerationDialog
  // instead of dispatching blind — the dialog gives the user the
  // auto-prompt path or a place to type. The pin we just persisted will
  // apply to whichever Generate is fired from the dialog.
  const targetNode = useBoardStore
    .getState()
    .nodes.find((n) => n.id === target.targetRfId);
  if (!targetNode) return;
  const prompt = (targetNode.data.prompt ?? "").trim();
  if (!prompt) {
    useGenerationStore.getState().openGenerationDialog(target.targetRfId, "");
    return;
  }
  await useGenerationStore.getState().dispatchGeneration(target.targetRfId, {
    prompt,
    kind: target.kind,
    aspectRatio: targetNode.data.aspectRatio,
    variantCount: targetNode.data.variantCount,
  });
}

function VariantPicker({
  state,
  onPick,
  onCancel,
}: {
  state: VariantPickerState;
  onPick(target: VariantTarget): void;
  onCancel(): void;
}) {
  return (
    <div className="variant-picker" role="dialog" aria-label="Pick downstream target">
      <div className="variant-picker__heading">
        Use variant v{state.variantIdx + 1} for:
      </div>
      <ul className="variant-picker__list">
        {state.targets.map((t) => (
          <li key={t.edgeId}>
            <button
              type="button"
              className="variant-picker__btn"
              onClick={() => onPick(t)}
            >
              {t.title}
              <span className="variant-picker__kind">
                {t.kind === "video" ? "video" : "image"}
                {!t.hasPrompt ? " · empty" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="variant-picker__cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

function ImageBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const hasMedia = ids.length > 0;
  const isProcessing = data.status === "queued" || data.status === "running";

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Variant-picker state for the multi-downstream "Use →" flow. MUST be
  // declared above the empty-state early-return below — Rules of Hooks
  // require the same call order on every render, and the empty/filled
  // branches change which JSX renders but not which hooks run.
  const [picker, setPicker] = useState<VariantPickerState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: undefined,
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`. `null` is the explicit "delete this key"
      // sentinel — used here to drop stale variant arrays + cached brief
      // when the user replaces a generated set with a single uploaded image.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: null,
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
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

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={ACCEPT_MIME}
      style={{ display: "none" }}
      onChange={onChange}
    />
  );

  // Empty state — same action-bar UX as character/visual_asset so users
  // can drop a reference image directly onto an image node instead of
  // having to wire one up via a separate visual_asset node.
  if (!hasMedia && !isProcessing) {
    return (
      <div
        className="node-body node-body--image"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div className={`character-empty${dragOver ? " character-empty--over" : ""}`}>
          {dragOver ? (
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
        <BriefHint data={data} />
        {hiddenFileInput}
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Variant-click flow: when this node is multi-variant AND has a
  // downstream image/video target, each tile gets a "Use →" overlay
  // button. Clicking it pins this variant on the appropriate edge and
  // dispatches Generate on the target. See `applyVariantToTarget` above.
  const isMultiVariant = ids.length >= 2;

  function onUseVariantClick(variantIdx: number) {
    const targets = collectGenTargets(rfId);
    if (targets.length === 0) {
      useGenerationStore.setState({
        error: "Connect this image to a downstream image/video target first.",
      });
      return;
    }
    if (targets.length === 1) {
      void applyVariantToTarget(variantIdx, targets[0]);
      return;
    }
    setPicker({ variantIdx, targets });
  }

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    // Click a tile → open viewer at that variant. The "Use →" overlay
    // (when present) is a separate action handled by onUseAsRef.
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
        onUseAsRef={
          isMultiVariant && mid && !isProcessing
            ? () => onUseVariantClick(i)
            : undefined
        }
      />
    );
  }

  return (
    <div
      className={`node-body node-body--image${dragOver ? " node-body--image--over" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className={`thumbnail-grid thumbnail-grid--${tileCount}`}>
        {tiles}
      </div>
      {picker && (
        <VariantPicker
          state={picker}
          onPick={(target) => {
            void applyVariantToTarget(picker.variantIdx, target);
            setPicker(null);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
      <BriefHint data={data} />
      {hiddenFileInput}
      {error && <p className="character-drop__error" role="alert">{error}</p>}
    </div>
  );
}

const MAX_VIDEO_RETRIES = 5;

function VideoTile({
  mediaId,
  posterMediaId,
  isProcessing,
  isError,
  slotError,
  alt,
  onClick,
}: {
  mediaId: string | undefined;
  // Upstream image's mediaId — used as the static poster so the tile
  // shows the source-image framing (subject centered, just like the
  // image-tile preview) instead of the video's frame-0 which often
  // catches a setup beat (ceiling, empty room) before the subject is
  // composed in.
  posterMediaId?: string | undefined;
  isProcessing: boolean;
  isError: boolean;
  // Per-slot error code (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION") when
  // this specific variant got blocked by Veo's safety classifier. Only
  // surfaced for the partial-batch case so the tile can render a
  // distinctive ⚠ + tooltip instead of the generic empty placeholder.
  slotError?: string | null;
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

  const blockedTitle = slotError
    ? `Variant blocked: ${slotError} — click for details`
    : undefined;

  const placeholder = (
    <div
      className={`video-placeholder${isProcessing ? " video-placeholder--processing" : ""}${isError ? " video-placeholder--error" : ""}${slotError ? " video-placeholder--blocked" : ""}`}
      aria-hidden="true"
      title={blockedTitle}
    >
      {slotError ? (
        <>
          <span className="video-blocked-icon">⚠</span>
          <span className="video-blocked-label">Blocked</span>
        </>
      ) : (
        <>
          <span className="video-play">▶</span>
          <span className="video-duration">0:00</span>
        </>
      )}
    </div>
  );

  if (!mediaId) {
    // Pending / failed tile — just the placeholder. When `slotError` is
    // set the placeholder swaps to the warning treatment above. We
    // still attach onClick so the user can click through to the
    // detail viewer to read the full error.
    const cls = `video-tile${slotError ? " video-tile--blocked" : ""}${onClick ? " video-tile--clickable" : ""}`;
    return (
      <div
        className={cls}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={blockedTitle ?? (onClick ? `Open variant ${alt}` : undefined)}
        title={blockedTitle}
        onClick={onClick}
        onKeyDown={(e) => {
          if (!onClick) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {placeholder}
      </div>
    );
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
      {!givenUp && posterMediaId ? (
        // Thumbnail = static poster image (the upstream i2v source).
        // Mounting a <video> here decodes frame 0 in Chrome and
        // overrides the poster attribute, which is what made every
        // tile display the video's setup beat (often empty ceiling)
        // instead of the subject-centered framing. The full video
        // with controls plays in the ResultViewer modal — clicking
        // a tile already routes there.
        <img
          key={`poster-${attempt}`}
          className="video-tile__poster"
          src={mediaUrl(posterMediaId)}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      ) : !givenUp ? (
        // Fallback: no upstream poster available (orphan video node).
        // Mount the <video> directly with `preload="none"` so the
        // browser shows the bare frame instead of decoding frame 0.
        <video
          key={attempt}
          className="node-card__thumbnail"
          data-kind="video"
          src={src}
          preload="none"
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
      ) : null}
      {posterMediaId && (
        <span className="video-tile__play-badge" aria-hidden="true">▶</span>
      )}
    </div>
  );
}

function VideoBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const isProcessing = data.status === "queued" || data.status === "running";
  const isError = data.status === "error";
  // Partial-batch case: status="done" + an error string means some
  // variants succeeded and others got blocked (filter / timeout).
  // Slot-level signal: `mediaIds[i] === null` is a positional
  // placeholder for a blocked variant — render the tile as filtered
  // rather than empty/processing.
  const isPartial = data.status === "done" && Boolean(data.error);

  // Resolve the upstream image used as the i2v source — its variants
  // become the per-tile poster so the static preview shows the same
  // subject-centered framing as the upstream image card. Multi-source
  // i2v: variant i of the video came from variant i of the upstream
  // image; single-source: every tile shares the same poster.
  const { nodes, edges } = useBoardStore.getState();
  const upstreamEdge = edges.find((e) => e.target === rfId);
  const upstreamNode = upstreamEdge
    ? nodes.find((n) => n.id === upstreamEdge.source)
    : undefined;
  const posterIds: (string | null)[] =
    upstreamNode?.data.mediaIds ??
    (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    const slotError = data.slotErrors?.[i] ?? null;
    const slotBlocked = isPartial && rawMid === null;
    // Even blocked tiles get a click handler so the user can open the
    // detail viewer and read the full filter reason — without it the
    // tile is dead and the user has no way to understand why it's
    // empty.
    const onClick =
      mid || slotBlocked
        ? () => useGenerationStore.getState().openResultViewer(rfId, i)
        : undefined;
    // Pick the i-th source variant if available; fall back to the
    // first non-null source for single-source i2v where every video
    // shares it.
    const rawPoster = posterIds[i] ?? posterIds.find((p) => Boolean(p)) ?? null;
    const poster = typeof rawPoster === "string" ? rawPoster : undefined;
    tiles.push(
      <VideoTile
        key={i}
        mediaId={mid}
        posterMediaId={poster}
        isProcessing={isProcessing && !mid}
        isError={(isError && !mid) || slotBlocked}
        slotError={slotError}
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
      {(isError || isPartial) && data.error && (
        <p
          className={`node-error${isPartial ? " node-error--partial" : ""}`}
          role={isError ? "alert" : "status"}
        >
          {data.error}
        </p>
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
      // Backend merges `data`, so we only need to send the deltas.
      // `null` clears aiBrief explicitly (undefined would be dropped
      // by JSON.stringify and leave the stale brief in place).
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: [newMediaId],
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
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

// Shared editable body for prompt + note nodes. Both store free-form text
// in `data.prompt`; only display markup differs. Double-click swaps to a
// textarea; blur or Cmd/Ctrl+Enter saves; Esc cancels.
function EditableTextBody({
  rfId,
  data,
  variant,
}: {
  rfId: string;
  data: FlowboardNodeData;
  variant: "prompt" | "note";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.prompt ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(data.prompt ?? "");
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  }, [editing]);

  function save() {
    const next = draft;
    if (next !== (data.prompt ?? "")) {
      useBoardStore.getState().updateNodeData(rfId, { prompt: next });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        // Backend merges `data`, so only the prompt delta needs shipping.
        patchNode(dbId, { data: { prompt: next } }).catch(() => {});
      }
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={`node-body node-body--${variant} node-body--${variant}-edit`}>
        <textarea
          ref={taRef}
          className={`${variant}-editor`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={
            variant === "prompt"
              ? "Style direction (e.g. cinematic warm tone, magazine editorial mood). Connect into image/video to feed downstream auto-prompt."
              : "Note, TODO, label…"
          }
        />
      </div>
    );
  }

  const text = data.prompt ?? "";
  const placeholder =
    variant === "prompt"
      ? "Double-click to add direction…"
      : "Double-click to add note…";

  return (
    <div
      className={`node-body node-body--${variant}`}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {variant === "prompt" ? (
        <pre className="prompt-text">{text || placeholder}</pre>
      ) : (
        <p className="note-text">{text || placeholder}</p>
      )}
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
      return <EditableTextBody rfId={rfId} data={data} variant="prompt" />;
    case "note":
      return <EditableTextBody rfId={rfId} data={data} variant="note" />;
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
  const llmBusy = isLLMBusy(data);
  const downloadable = !!data.mediaId && data.type !== "prompt" && data.type !== "note";

  function handleGenerate(e: React.MouseEvent) {
    e.stopPropagation();
    if (llmBusy) return; // guard: backend still composing for this node
    useGenerationStore.getState().openGenerationDialog(props.id, data.prompt ?? "");
  }

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    // Download every variant, not just the first. `mediaIds` is the full
    // list — `mediaId` is just the active variant — so a 4-variant image
    // node was previously losing 3 of its 4 outputs. Filter out null
    // placeholders that the partial-batch path may leave in `mediaIds`.
    const rawIds =
      data.mediaIds && data.mediaIds.length > 0
        ? data.mediaIds
        : data.mediaId
          ? [data.mediaId]
          : [];
    const ids = rawIds.filter((m): m is string => typeof m === "string" && m.length > 0);
    if (ids.length === 0) return;
    const safeTitle = (data.title || data.type).replace(/[^A-Za-z0-9_-]+/g, "_");
    const ext = downloadExt(data.type);
    // `<a download>` only honours the suggested filename when the resource
    // is same-origin — `/media/<id>` *is* same-origin (proxied by FastAPI),
    // so the title-based filename sticks.
    ids.forEach((mid, i) => {
      const a = document.createElement("a");
      a.href = mediaUrl(mid);
      const suffix = ids.length > 1 ? `-${i + 1}` : "";
      a.download = `${safeTitle}-${data.shortId}${suffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  return (
    <div
      className={`node-card${isNote ? " node-card--note" : ""}${
        props.selected ? " node-card--selected" : ""
      }${llmBusy ? " node-card--llm-busy" : ""}`}
    >
      <StatusStrip status={data.status} />
      <Handle type="target" position={Position.Left} className="node-handle" />

      <div className="node-header">
        <span className="node-icon" aria-hidden="true">{ICON[data.type] ?? "□"}</span>
        <span className="node-title">{data.title}</span>
        {llmBusy && (
          // Compact pill so the busy state reads at a glance even if the
          // body is collapsed. Title is contextual: composing vs. analysing.
          <span className="node-header__llm-pill" aria-live="polite">
            <span className="node-header__llm-spinner" aria-hidden="true" />
            {data.autoPromptStatus === "pending" ? "Composing…" : "Analyzing…"}
          </span>
        )}
        <div className="node-header__actions">
          {downloadable && (
            <button
              className="node-header__btn"
              onClick={handleDownload}
              aria-label="Download media"
              title="Download"
              tabIndex={0}
            >
              ⬇
            </button>
          )}
          {isGenerable && (
            <button
              className={`node-header__btn${isRunning ? " node-header__btn--running" : ""}`}
              onClick={handleGenerate}
              aria-label="Generate from this node"
              title={llmBusy ? "Backend is still composing — try again in a moment" : "Generate"}
              tabIndex={0}
              disabled={llmBusy}
            >
              ▶
            </button>
          )}
        </div>
        <span className="node-short-id">#{data.shortId}</span>
      </div>

      <NodeBody rfId={props.id} data={data} />

      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  );
}
