import { useCallback, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import { ImageUp, Replace, Upload } from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { useUploadFlow, mediaUrl } from "./shared/useUploadFlow";
import { UploadingOverlay } from "./shared/UploadingOverlay";

const NODE_WIDTH = 280;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;

export function UploadNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data);
  const mediaId = data.mediaId as string | undefined;
  const fileName = data.fileName as string | undefined;
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

  // Check if this node has any connected edges (source)
  const edges = useEdges();
  const hasConnectedEdge = edges.some((e) => e.source === rfId);

  // Check if currently dragging a connection from this node
  const connection = useConnection();
  const isConnecting = connection.inProgress && connection.fromNode?.id === rfId;

  // Handle visible when hovered OR has connected edge OR currently connecting
  const showHandle = showControls || hasConnectedEdge || isConnecting;

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function truncateId(id: string, len = 24) {
    return id.length > len ? id.slice(0, len) + "..." : id;
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width: NODE_WIDTH, padding: "0 16px 0 0" }}
    >
      {/* External header - outside card, Magnific style */}
      <div className="flex items-center gap-1.5 mb-2 pl-1">
        <ImageUp size={12} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-2xs text-ink-muted font-mono truncate leading-none">
          {mediaId ? truncateId(mediaId) : "Upload"}
        </span>
      </div>

      {/* Card */}
      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-hidden transition-all duration-150",
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
            "relative flex items-center justify-center cursor-pointer",
            "transition-all duration-150",
            !mediaId && "min-h-[180px]",
          )}
          style={{
            aspectRatio: mediaId ? aspectRatio || "1 / 1" : "4 / 3",
          }}
        >
          {/* Filled state */}
          {flow.bodyState === "filled" && mediaId && (
            <>
              <img
                src={mediaUrl(mediaId)}
                alt={fileName ?? "upload"}
                className="size-full object-contain"
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
            <div
              className="flex flex-col items-center gap-2 text-ink-muted"
              onClick={flow.pickFile}
            >
              <ImageUp size={24} strokeWidth={1.5} className="opacity-50" />
              <span className="text-xs">Drop an image here</span>
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
              <button
                onClick={flow.pickFile}
                className="text-2xs text-accent hover:underline"
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
        {showControls && mediaId && (
          <div className="absolute bottom-3 left-3 z-10">
            <button
              onClick={flow.pickFile}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                "text-2xs font-medium text-ink-primary",
                "transition-all duration-150 cursor-pointer",
                "hover:bg-white/[0.12]",
              )}
              style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(8px)" }}
            >
              <Replace size={12} strokeWidth={2} />
              Replace
            </button>
          </div>
        )}
      </div>

      {/* Source handle (output only) - right side fixed 48px from top */}
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className={cn(
          "!absolute !-right-0 !top-[48px] !h-7 !w-7 !border-0 !bg-transparent",
          "transition-opacity duration-150",
          showHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none",
        )}
      >
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150"
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