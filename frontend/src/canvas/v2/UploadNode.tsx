import { useCallback, useRef, useState } from "react";
import { type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import { ImageUp, Replace, Upload, Copy, Trash2 } from "lucide-react";

import { type FlowNode, useBoardStore } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { useUploadFlow, mediaUrl } from "./shared/useUploadFlow";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { ResizeHandle } from "./shared/ResizeHandle";
import { useNodeWidth } from "./shared/useNodeWidth";
import { persistNodeData } from "./shared/persistNodeData";
import { NodeShell } from "./NodeShell";
import { EmptyState } from "./shared/EmptyState";

const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 280;
const HOVER_LEAVE_DELAY = 200;

function flowAspectToCss(value: string | undefined): string | null {
  if (!value) return null;
  if (value.includes("/")) return value;
  switch (value) {
    case "IMAGE_ASPECT_RATIO_SQUARE":
    case "VIDEO_ASPECT_RATIO_SQUARE":
      return "1 / 1";
    case "IMAGE_ASPECT_RATIO_PORTRAIT":
    case "VIDEO_ASPECT_RATIO_PORTRAIT":
      return "9 / 16";
    case "IMAGE_ASPECT_RATIO_LANDSCAPE":
    case "VIDEO_ASPECT_RATIO_LANDSCAPE":
      return "16 / 9";
    case "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE":
      return "4 / 3";
    case "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR":
      return "3 / 4";
    default:
      return null;
  }
}

function normaliseStatus(status: any): "idle" | "queued" | "running" | "done" | "error" {
  if (!status) return "idle";
  const s = String(status).toLowerCase();
  if (s === "queued" || s === "running" || s === "done" || s === "error") {
    return s as any;
  }
  return "idle";
}

export function UploadNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data, selected);
  const { width: nodeWidth, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });

  const mediaId = data.mediaId as string | undefined;
  const fileName = data.fileName as string | undefined;
  const aspectRatio = data.aspectRatio as string | undefined;

  // Hover with delay
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseEnter = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
  }, []);

  const onMouseLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHovered(false), HOVER_LEAVE_DELAY);
  }, []);

  const showControls = hovered || !!selected;

  // Seed imgSize from persisted node data
  const persistedW = data.imageWidth as number | undefined;
  const persistedH = data.imageHeight as number | undefined;
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(
    persistedW && persistedH ? { w: persistedW, h: persistedH } : null,
  );

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setImgSize({ w, h });
    if (w && h && (persistedW !== w || persistedH !== h)) {
      persistNodeData(rfId, { imageWidth: w, imageHeight: h });
    }
  }

  function truncateId(id: string, len = 24) {
    return id.length > len ? id.slice(0, len) + "..." : id;
  }

  function stopNodeAction(event: React.MouseEvent) {
    event.stopPropagation();
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative"
    >
      {/* Floating Quick Action Overlay */}
      <NodeToolbar position={Position.Top} offset={12} isVisible={showControls}>
        <div 
          onMouseDown={stopNodeAction}
          onClick={stopNodeAction}
          onDoubleClick={stopNodeAction}
          className="flex items-center gap-1 px-1.5 py-1 rounded-full"
          style={{
            backgroundColor: "rgba(20, 20, 20, 0.92)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 8px 28px -10px rgba(0,0,0,0.6)",
          }}
        >
          <button
            type="button"
            onClick={() => useBoardStore.getState().cloneNodeWithUpstream(rfId)}
            title="Duplicate Node"
            className="nodrag nowheel w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] cursor-pointer text-white/70 hover:text-white"
          >
            <Copy size={13} />
          </button>
          <span className="h-4 w-px bg-white/10 mx-0.5" />
          <button
            type="button"
            onClick={() => useBoardStore.getState().deleteNodeByRfId(rfId)}
            title="Delete Node"
            className="nodrag nowheel w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] cursor-pointer text-[#ef4444]"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </NodeToolbar>

      <NodeShell
        id={rfId}
        Icon={ImageUp}
        title={data.title || (mediaId ? truncateId(mediaId) : "Upload")}
        shortId={data.shortId}
        selected={selected}
        width={nodeWidth}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: ImageUp, label: "Uploaded Image" }}
        padded={false}
      >
        {/* Image slot */}
        <div
          onDrop={flow.onDrop}
          onDragOver={flow.onDragOver}
          onDragLeave={flow.onDragLeave}
          className={cn(
            "w-full relative flex items-center justify-center cursor-pointer overflow-hidden",
            "transition-all duration-300 ease-out",
            flow.dragOver && "ring-2 ring-accent/40",
            flow.bodyState === "uploading" && "ring-2 ring-accent/30",
            flow.bodyState === "error" && "ring-2 ring-red-500/40",
          )}
          style={{
            backgroundColor: "#1a1d25",
            borderRadius: "13px",
            aspectRatio: mediaId
              ? imgSize
                ? `${imgSize.w} / ${imgSize.h}`
                : flowAspectToCss(aspectRatio) ?? "1 / 1"
              : "4 / 3",
          }}
        >
          {/* Filled state */}
          {flow.bodyState === "filled" && mediaId && (
            <>
              <img
                src={mediaUrl(mediaId)}
                alt={fileName ?? "upload"}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                className="absolute inset-0 size-full object-cover rounded-[13px] animate-fade-in outline-none focus-visible:ring-2 focus-visible:ring-accent"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    useGenerationStore.getState().openResultViewer(rfId);
                  }
                }}
                onLoad={onImageLoad}
                onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId)}
              />
              {/* Size badge top-right */}
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
            <div onClick={flow.pickFile} className="w-full h-full flex items-center justify-center">
              <EmptyState
                Icon={ImageUp}
                title="Drop an image here"
                hint="Or click to browse files"
                minHeight={100}
              />
            </div>
          )}

          {/* Drag over */}
          {flow.bodyState === "empty" && flow.dragOver && (
            <div className="flex flex-col items-center gap-1.5 text-accent">
              <Upload size={18} strokeWidth={1.75} />
              <span className="text-2xs font-medium">Drop to upload</span>
            </div>
          )}

          {/* Error */}
          {flow.bodyState === "error" && flow.error && (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <span className="text-2xs text-red-400">{flow.error}</span>
              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={flow.pickFile}
                className="nodrag nowheel text-2xs text-accent hover:underline"
              >
                Try again
              </button>
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

        {/* Replace button bottom left hover only */}
        {mediaId && (
          <div className={cn("absolute bottom-3 left-3 z-10 transition-all duration-300 ease-out", showControls ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none")}>
            <button
              type="button"
              onMouseDown={stopNodeAction}
              onDoubleClick={stopNodeAction}
              onClick={flow.pickFile}
              className={cn(
                "nodrag nowheel flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                "text-2xs font-medium text-ink-primary",
                "transition-all duration-300 ease-out cursor-pointer",
                "hover:bg-white/[0.12]",
              )}
              style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(8px)" }}
            >
              <Replace size={12} strokeWidth={2} />
              Replace
            </button>
          </div>
        )}

        {/* Resize handle */}
        <ResizeHandle
          nodeId={rfId}
          corners={["br", "bl", "tr"]}
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          currentWidth={nodeWidth}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          forceVisible={!!selected}
        />
      </NodeShell>

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
