import { useCallback, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import { ImageUp, Replace, Upload, Tag } from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { useUploadFlow, mediaUrl } from "./shared/useUploadFlow";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { ResizeHandle } from "./shared/ResizeHandle";
import { useNodeWidth } from "./shared/useNodeWidth";
import { persistNodeData } from "./shared/persistNodeData";
import { requestAutoBrief } from "../../api/autoBrief";
import { REFERENCE_TYPES, type ReferenceTypeKey } from "../../constants/concept";

const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 280;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;

export function AddReferenceNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data);
  const { width: nodeWidth, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId, data, min: MIN_WIDTH, max: MAX_WIDTH, fallback: DEFAULT_WIDTH,
  });

  const mediaId = data.mediaId as string | undefined;
  const refType = (data.refType as ReferenceTypeKey | undefined) ?? "texture";
  const shortId = data.shortId as string | undefined;
  const aspectRatio = data.aspectRatio as string | undefined;

  // Hover with delay
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMouseEnter = useCallback(() => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHovered(true);
  }, []);
  const onMouseLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHovered(false), HOVER_LEAVE_DELAY);
  }, []);
  const showControls = hovered || !!selected;

  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [showTypePicker, setShowTypePicker] = useState(false);

  // Handle visibility
  const edges = useEdges();
  const hasConnectedEdge = edges.some((e) => e.source === rfId);
  const connection = useConnection();
  const isConnecting = connection.inProgress && connection.fromNode?.id === rfId;
  const showHandle = showControls || hasConnectedEdge || isConnecting;

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function setRefType(key: ReferenceTypeKey) {
    // Switching tags changes the role of the image (structural vs.
    // material vs. lighting...). The cached `aiBrief` was generated
    // under the OLD tag's vision profile, so it now describes the
    // image at the wrong abstraction layer (e.g. a `texture` brief
    // baked under the legacy annotator naming the pictured object).
    // Clearing it forces a re-describe under the correct profile.
    //
    // `null` is the explicit "clear" sentinel both the board store
    // and the backend patch route understand; `undefined` would be
    // dropped from the patchNode payload.
    persistNodeData(rfId, { refType: key, aiBrief: null, aiBriefStatus: undefined });
    setShowTypePicker(false);

    // Trigger a fresh vision call when there is media to describe.
    // `requestAutoBrief` reads the (already-updated) node and picks
    // the new tag's profile - we don't pass `key` separately, the
    // helper goes back to the store as its source of truth.
    if (typeof mediaId === "string" && mediaId.length > 0) {
      requestAutoBrief(rfId, mediaId);
    }
  }

  const currentTypeLabel = REFERENCE_TYPES.find((t) => t.key === refType)?.label ?? "Texture";

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width: nodeWidth, padding: "0 16px 0 0" }}
    >
      {/* External header */}
      <div className="flex items-center gap-1.5 mb-2 pl-1">
        <ImageUp size={12} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-primary font-medium leading-none">Reference</span>
        {shortId && <span className="font-mono text-2xs text-ink-placeholder leading-none">#{shortId}</span>}
      </div>

      {/* Card */}
      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-visible transition-all duration-300 ease-out",
          "border-[3px] border-white/[0.14] shadow-lg",
          selected && "ring-2 ring-accent/50",
          flow.dragOver && "ring-2 ring-accent/40",
        )}
        style={{ borderRadius: BORDER_RADIUS, backgroundColor: "#1a1a1a" }}
      >
        {/* Image slot */}
        <div
          onDrop={flow.onDrop}
          onDragOver={flow.onDragOver}
          onDragLeave={flow.onDragLeave}
          className={cn(
            "relative flex items-center justify-center cursor-pointer overflow-hidden",
            "transition-all duration-300 ease-out",
            !mediaId && "min-h-[180px]",
          )}
          style={{
            aspectRatio: mediaId ? aspectRatio || "1 / 1" : "4 / 3",
            borderRadius: BORDER_RADIUS - 3,
          }}
        >
          {/* Filled state */}
          {flow.bodyState === "filled" && mediaId && (
            <>
              <img
                src={mediaUrl(mediaId)}
                alt="reference"
                className="size-full object-contain"
                onLoad={onImageLoad}
                onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId)}
              />
              {imgSize && showControls && (
                <div
                  className="absolute top-2 right-2 px-2 py-0.5 rounded-md text-2xs font-medium text-ink-muted"
                  style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
                >
                  {imgSize.w} x {imgSize.h}
                </div>
              )}
            </>
          )}

          {/* Uploading */}
          {flow.bodyState === "uploading" && <UploadingOverlay />}

          {/* Empty state */}
          {flow.bodyState === "empty" && !flow.dragOver && (
            <div
              className="flex flex-col items-center gap-2 text-ink-muted"
              onClick={flow.pickFile}
            >
              <ImageUp size={24} strokeWidth={1.5} className="opacity-50" />
              <span className="text-xs">Drop a reference image</span>
            </div>
          )}

          {/* Drag over */}
          {flow.bodyState === "empty" && flow.dragOver && (
            <div className="flex flex-col items-center gap-1.5 text-accent">
              <Upload size={20} strokeWidth={1.75} />
              <span className="text-2xs font-medium">Drop to upload</span>
            </div>
          )}

          {/* Error */}
          {flow.bodyState === "error" && flow.error && (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <span className="text-2xs text-red-400">{flow.error}</span>
              <button onClick={flow.pickFile} className="text-2xs text-accent hover:underline">Try again</button>
            </div>
          )}

          {/* Upload success pulse */}
          {flow.uploadJustFinished && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-fade-in">
              <span className="rounded-full bg-status-done/20 backdrop-blur-sm border border-status-done/50 text-status-done text-2xs font-medium px-3 py-1">
                Uploaded
              </span>
            </div>
          )}
        </div>

        {/* AI Description */}
        {mediaId && (
          <div className="px-3 py-2">
            {(data.aiBriefStatus as string) === "pending" && (
              <p className="text-2xs text-accent animate-pulse">Analyzing image...</p>
            )}
            {typeof data.aiBrief === "string" && (data.aiBrief as string).length > 0 && (
              <p className="text-2xs text-ink-muted leading-relaxed line-clamp-3" title={data.aiBrief as string}>
                {data.aiBrief as string}
              </p>
            )}
          </div>
        )}

        {/* Bottom bar: type picker + replace */}
        <div className={cn("absolute bottom-3 left-3 right-3 z-10 flex items-center gap-2 transition-all duration-300 ease-out", showControls ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none")}>
          {/* Reference type picker */}
          <div className="relative">
            <button
              onClick={() => setShowTypePicker(!showTypePicker)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                "text-2xs font-medium text-ink-primary",
                "transition-all duration-300 ease-out cursor-pointer",
                "hover:bg-white/[0.12]",
              )}
              style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(8px)" }}
            >
              <Tag size={12} strokeWidth={2} />
              {currentTypeLabel}
              <span className="text-[8px] opacity-50">▾</span>
            </button>
            {showTypePicker && (
              <div className="absolute bottom-full left-0 mb-1 rounded-lg p-1 shadow-xl border border-white/[0.08] z-50" style={{ backgroundColor: "#2a2a2a" }}>
                {REFERENCE_TYPES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setRefType(t.key as ReferenceTypeKey)}
                    className={cn("block w-full text-left px-3 py-1.5 rounded-md text-2xs whitespace-nowrap transition-colors", t.key === refType ? "text-accent bg-accent/10" : "text-white/80 hover:text-white hover:bg-white/[0.06]")}
                  >
                    {t.label}
                    <span className="ml-2 text-ink-placeholder">{t.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1" />

          {/* Replace button */}
          {mediaId && (
            <button
              onClick={flow.pickFile}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                "text-2xs font-medium text-ink-primary",
                "transition-all duration-300 ease-out cursor-pointer",
                "hover:bg-white/[0.12]",
              )}
              style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(8px)" }}
            >
              <Replace size={12} strokeWidth={2} />
              Replace
            </button>
          )}
        </div>

        {/* Resize handle */}
        <ResizeHandle
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          currentWidth={nodeWidth}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          forceVisible={!!selected}
        />
      </div>

      {/* Source handle (output) - right side, 48px from top */}
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className={cn(
          "!absolute !-right-0 !top-[48px] !h-7 !w-7 !border-0 !bg-transparent",
          "transition-opacity duration-300 ease-out",
          showHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none",
        )}
      >
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-300 ease-out"
          style={{
            backgroundColor: "#2b2b2b",
            borderColor: hasConnectedEdge ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <ImageUp size={11} strokeWidth={2} />
        </div>
      </Handle>

      {/* Hidden file input */}
      <input
        type="file"
        className="hidden"
        ref={flow.fileInputProps.ref}
        accept={flow.fileInputProps.accept}
        onChange={flow.fileInputProps.onChange}
      />
    </div>
  );
}
