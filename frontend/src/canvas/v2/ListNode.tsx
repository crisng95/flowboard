import { useCallback, useRef, useState, useEffect } from "react";
import { Handle, Position, useConnection, useEdges, NodeToolbar, type NodeProps } from "@xyflow/react";
import {
  List,
  Grid,
  Play,
  Check,
  Trash2,
  Type,
  ImageUp,
  Video,
  RefreshCw,
  Plus,
  ChevronDown,
  AlertTriangle
} from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useBoardStore } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { uploadImage, patchNode } from "../../api/client";
import { mediaUrl } from "./shared/useUploadFlow";
import { persistNodeData } from "./shared/persistNodeData";
import { ResizeHandle } from "./shared/ResizeHandle";
import { useNodeWidth } from "./shared/useNodeWidth";
import { HandleBadge } from "./shared/HandleBadge";
import { EmptyState } from "./shared/EmptyState";

const MIN_WIDTH = 460;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 580;
const BORDER_RADIUS = 16; // Smooth outer border radius: 16px (ReactFlow V12 Canvas V2 gold standard)
const HOVER_LEAVE_DELAY = 200;

/**
 * VideoListThumb renders a playable video thumbnail for List_Item entries with
 * kind === "video" (Req 5.1). It shows a poster/first frame before playback
 * (Req 5.2), plays on hover (Req 5.3), and pauses + resets back to the poster
 * when the cursor leaves WHILE playing (Req 5.4). When the cursor leaves while
 * the video is not playing, it is a no-op (Req 5.5).
 *
 * The element is absolutely positioned to fill its (relative) parent container,
 * so it can drop into both the grid view (aspect-square tile) and the list view
 * (40px thumbnail) used by ListNode.
 */
export function VideoListThumb({
  src,
  poster,
  fit,
}: {
  src: string;
  poster?: string;
  fit: "cover" | "contain";
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const handleMouseEnter = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Req 5.3: begin playback on hover. play() may return a promise in browsers;
    // guard for environments (tests) where it does not.
    const result = el.play();
    if (result && typeof result.then === "function") {
      result.then(() => setPlaying(true)).catch(() => {});
    } else {
      setPlaying(true);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    // Req 5.5: only stop/reset to poster WHEN currently playing; otherwise no-op.
    if (!playing) return;
    const el = ref.current;
    if (!el) return;
    // Req 5.4: pause and rewind to the poster frame.
    el.pause();
    el.currentTime = 0;
    setPlaying(false);
  }, [playing]);

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      draggable={false}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "absolute inset-0 size-full transition-all duration-200",
        fit === "contain" ? "object-contain bg-black/40" : "object-cover"
      )}
    />
  );
}

export function ListNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  
  const title = data.title || "List";
  const status = data.status || "idle";
  const isRunning = status === "running" || status === "queued";

  const [simulatedProgress, setSimulatedProgress] = useState(2);
  useEffect(() => {
    if (isRunning) {
      setSimulatedProgress(2);
      const interval = setInterval(() => {
        setSimulatedProgress((prev) => {
          if (prev >= 98) return 98;
          const increment = Math.floor(Math.random() * 6) + 1;
          return Math.min(98, prev + increment);
        });
      }, 750);
      return () => clearInterval(interval);
    } else {
      setSimulatedProgress(2);
    }
  }, [isRunning]);
  
  const listItems = Array.isArray(data.listItems) ? data.listItems : [];
  const listViewMode = (data.listViewMode as "grid" | "list") || "grid";
  const listIntakeMode = (data.listIntakeMode as "keep" | "replace") || "replace";
  const listSelectionMode = !!data.listSelectionMode;
  const listSelectedIndexes = Array.isArray(data.listSelectedIndexes) 
    ? data.listSelectedIndexes.map(Number)
    : [];
  const imageFit = (data.imageFit as "cover" | "contain") || "cover";

  const { width: nodeWidth, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });

  const gridLayout = (() => {
    const count = listItems.length;
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    return { cols: 3, rows: Math.ceil(count / 3) };
  })();

  const gridThumbSize = (() => {
    const cols = gridLayout.cols;
    const availableWidth = nodeWidth - 40 - 6 - 32 - 8 - 4; // wrapper padding (40px) + card borders (6px) + Scrollable Wrapper padding (32px for px-4) + Content Viewport padding-right (8px for pr-2) + scrollbar width (4px)
    const gap = 8;
    return (availableWidth - (cols - 1) * gap) / cols;
  })();

  const dynamicMinHeight = (() => {
    if (listItems.length === 0) return 180;
    if (listViewMode === "grid") {
      const rows = gridLayout.rows;
      const gap = 8;
      const contentHeight = (rows * gridThumbSize) + ((rows - 1) * gap) + 24;
      return Math.round(contentHeight + 56); // content + absolute bottom toolbar
    } else {
      const contentHeight = (listItems.length * 61) + 24;
      return Math.round(contentHeight + 56);
    }
  })();

  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [showIntakeDropdown, setShowIntakeDropdown] = useState(false);

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

  // Close dropdown on outside click
  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowIntakeDropdown(false);
      }
    }
    if (showIntakeDropdown) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [showIntakeDropdown]);

  // Exit selection mode when the node is deselected on the canvas
  useEffect(() => {
    if (!selected && listSelectionMode) {
      useBoardStore.getState().updateNodeData(rfId, { 
        listSelectionMode: false
      });
      persistNodeData(rfId, { 
        listSelectionMode: false
      });
    }
  }, [selected, rfId, listSelectionMode]);

  const showControls = hovered || !!selected;

  // ReactFlow handles & edges lookup
  const edges = useEdges();
  const connection = useConnection();

  const hasTextTargetEdge = edges.some((e) => e.target === rfId && e.targetHandle === "target-text");
  const hasVideoTargetEdge = edges.some((e) => e.target === rfId && e.targetHandle === "target-video");
  const hasImageTargetEdge = edges.some((e) => e.target === rfId && e.targetHandle === "target-image");
  const hasTextSourceEdge = edges.some((e) => e.source === rfId && e.sourceHandle === "source-text");
  const hasVideoSourceEdge = edges.some((e) => e.source === rfId && e.sourceHandle === "source-video");
  const hasImageSourceEdge = edges.some((e) => e.source === rfId && e.sourceHandle === "source-image");

  const lockedType = (() => {
    // 1. Check active edges first (highest priority)
    if (hasTextTargetEdge || hasTextSourceEdge) return "text";
    if (hasVideoTargetEdge || hasVideoSourceEdge) return "video";
    if (hasImageTargetEdge || hasImageSourceEdge) return "image";

    // 2. Check existing items next
    if (listItems.length > 0) {
      const firstKind = listItems[0].kind;
      if (firstKind === "text" || firstKind === "video" || firstKind === "image") {
        return firstKind;
      }
    }

    // 3. Unlocked
    return null;
  })();

  const shouldRenderTextHandles = lockedType === null || lockedType === "text";
  const shouldRenderVideoHandles = lockedType === null || lockedType === "video";
  const shouldRenderImageHandles = lockedType === null || lockedType === "image";

  const isConnectingFrom = connection.inProgress && connection.fromNode?.id === rfId;
  const anyConnectionInProgress = connection.inProgress;

  // Target ClassName mapping
  const targetHandleClassName = (hasConnection: boolean) => cn(
    "!absolute !-left-0 !h-7 !w-7 !border-0 !bg-transparent group/handle",
    "transition-opacity duration-300 ease-out",
    anyConnectionInProgress
      ? "!opacity-100 !pointer-events-auto !z-50"
      : (showControls || hasConnection)
      ? "!opacity-100"
      : "!opacity-0 !pointer-events-none"
  );

  // Source ClassName mapping
  const sourceHandleClassName = (hasConnection: boolean) => cn(
    "!absolute !-right-0 !h-7 !w-7 !border-0 !bg-transparent group/handle",
    "transition-opacity duration-300 ease-out",
    (showControls || hasConnection || isConnectingFrom)
      ? "!opacity-100"
      : "!opacity-0 !pointer-events-none"
  );

  // Actions
  const handleRun = useCallback(() => {
    if (isRunning) return;
    void useGenerationStore.getState().runNodeGraph(rfId);
  }, [rfId, isRunning]);

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useBoardStore.getState().updateNodeData(rfId, {
      listItems: [],
      listSelectedIndexes: [],
      mediaIds: [],
      mediaId: undefined,
      flowMediaIds: [],
      flowMediaId: undefined,
      variantCount: 0,
      status: "idle",
      error: undefined,
    });
    persistNodeData(rfId, {
      listItems: [],
      listSelectedIndexes: [],
      mediaIds: [],
      mediaId: undefined,
      flowMediaIds: [],
      flowMediaId: undefined,
      variantCount: 0,
      status: "idle",
      error: undefined,
    });
  }, [rfId]);

  const setViewMode = useCallback((mode: "grid" | "list", e: React.MouseEvent) => {
    e.stopPropagation();
    useBoardStore.getState().updateNodeData(rfId, { listViewMode: mode });
    persistNodeData(rfId, { listViewMode: mode });
  }, [rfId]);

  const setIntakeMode = useCallback((mode: "keep" | "replace", e: React.MouseEvent) => {
    e.stopPropagation();
    useBoardStore.getState().updateNodeData(rfId, { listIntakeMode: mode });
    persistNodeData(rfId, { listIntakeMode: mode });
    setShowIntakeDropdown(false);
  }, [rfId]);

  const toggleSelectionMode = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const nextMode = !listSelectionMode;
    useBoardStore.getState().updateNodeData(rfId, { 
      listSelectionMode: nextMode
    });
    persistNodeData(rfId, { 
      listSelectionMode: nextMode
    });
  }, [rfId, listSelectionMode]);

  const uploadInputRef = useRef<HTMLInputElement>(null);

  const handlePlusClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    uploadInputRef.current?.click();
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    
    const projectId = await useGenerationStore.getState().ensureProjectId();
    if (!projectId) {
      useBoardStore.getState().updateNodeData(rfId, { error: "No Flow project linked" });
      return;
    }

    useBoardStore.getState().updateNodeData(rfId, { status: "running" });

    const newItems: Array<Record<string, unknown>> = [];
    for (const file of files) {
      try {
        const dbId = parseInt(rfId, 10);
        const resp = await uploadImage(
          file,
          projectId,
          Number.isNaN(dbId) ? undefined : dbId,
        );
        
        const kind = file.type.startsWith("video/") ? "video" : "image";
        const itemIndex = listItems.length + newItems.length;
        
        newItems.push({
          id: resp.media_id || `upload-item-${Date.now()}-${itemIndex}`,
          kind,
          title: file.name,
          mediaId: resp.media_id,
          flowMediaId: resp.media_id,
          mime: file.type,
          width: resp.width,
          height: resp.height,
        });
      } catch (err) {
        console.error("Upload failed for file:", file.name, err);
      }
    }

    if (newItems.length > 0) {
      const mergedItems = [...listItems, ...newItems];
      const mediaItems = mergedItems.filter((item) => item.kind === "image" || item.kind === "video");
      const mediaIds = mediaItems.map((item) => item.mediaId).filter((v): v is string => typeof v === "string" && v.length > 0);
      const flowMediaIds = mediaItems.map((item) => item.flowMediaId ?? item.mediaId).filter((v): v is string => typeof v === "string" && v.length > 0);

      useBoardStore.getState().updateNodeData(rfId, {
        status: "done",
        listItems: mergedItems,
        mediaIds,
        mediaId: mediaIds[0] ?? undefined,
        flowMediaIds,
        flowMediaId: flowMediaIds[0] ?? undefined,
        variantCount: mediaIds.length,
        renderedAt: new Date().toISOString(),
      });

      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          status: "done",
          data: {
            listItems: mergedItems,
            mediaIds,
            mediaId: mediaIds[0] ?? null,
            flowMediaIds,
            flowMediaId: flowMediaIds[0] ?? null,
            variantCount: mediaIds.length,
            renderedAt: new Date().toISOString(),
          },
        }).catch(() => {});
      }
    } else {
      useBoardStore.getState().updateNodeData(rfId, { status: "done" });
    }
    
    e.target.value = "";
  }, [rfId, listItems]);

  const toggleImageFit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextFit = imageFit === "cover" ? "contain" : "cover";
    useBoardStore.getState().updateNodeData(rfId, { imageFit: nextFit });
    persistNodeData(rfId, { imageFit: nextFit });
  }, [rfId, imageFit]);

  const buildSelectionPatch = useCallback((nextIndexes: number[]) => {
    const mediaItems = (nextIndexes.length > 0
      ? listItems.filter((_, idx) => nextIndexes.includes(idx))
      : listItems)
      .filter((item) => item.kind === "image" || item.kind === "video");

    const mediaIds = mediaItems
      .map((item) => item.mediaId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const flowMediaIds = mediaItems
      .map((item) => item.flowMediaId ?? item.mediaId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return {
      listSelectedIndexes: nextIndexes,
      mediaIds,
      mediaId: mediaIds[0] ?? undefined,
      flowMediaIds,
      flowMediaId: flowMediaIds[0] ?? undefined,
      variantCount: mediaIds.length,
    };
  }, [listItems]);

  const toggleItemSelection = useCallback((idx: number, e: React.MouseEvent) => {
    if (!listSelectionMode || !selected) {
      return;
    }

    e.stopPropagation();

    let nextIndexes = [...listSelectedIndexes];
    if (nextIndexes.includes(idx)) {
      nextIndexes = nextIndexes.filter((i) => i !== idx);
    } else {
      nextIndexes.push(idx);
    }

    const patch = buildSelectionPatch(nextIndexes);
    useBoardStore.getState().updateNodeData(rfId, patch);
    persistNodeData(rfId, patch);
  }, [rfId, listSelectionMode, listSelectedIndexes, buildSelectionPatch]);
  const selectAllItems = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const isAllSelected = listSelectedIndexes.length === listItems.length;
    const nextIndexes = isAllSelected ? [] : listItems.map((_, i) => i);
    const patch = buildSelectionPatch(nextIndexes);
    useBoardStore.getState().updateNodeData(rfId, patch);
    persistNodeData(rfId, patch);
  }, [rfId, listItems, listSelectedIndexes, buildSelectionPatch]);

  const invertSelection = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const inverted = listItems
      .map((_, i) => i)
      .filter((i) => !listSelectedIndexes.includes(i));
    const patch = buildSelectionPatch(inverted);
    useBoardStore.getState().updateNodeData(rfId, patch);
    persistNodeData(rfId, patch);
  }, [rfId, listItems, listSelectedIndexes, buildSelectionPatch]);

  function stopNodeAction(event: React.MouseEvent) {
    event.stopPropagation();
  }

  // Count helper
  const videoItemsCount = listItems.filter((item) => item.kind === "video").length;
  const imageItemsCount = listItems.filter((item) => item.kind === "image").length;
  const textItemsCount = listItems.filter((item) => item.kind === "text").length;

  const selectedVideoCount = listItems.filter((item, idx) => item.kind === "video" && listSelectedIndexes.includes(idx)).length;
  const selectedImageCount = listItems.filter((item, idx) => item.kind === "image" && listSelectedIndexes.includes(idx)).length;
  const selectedTextCount = listItems.filter((item, idx) => item.kind === "text" && listSelectedIndexes.includes(idx)).length;

  const allSelected = listItems.length > 0 && listSelectedIndexes.length === listItems.length;

  const selectionPillLabel = (() => {
    const totalCount = listItems.length;
    const selectedCount = listSelectedIndexes.length;
    const isSimplified = selectedCount === 0 || selectedCount === totalCount;

    if (videoItemsCount > 0 && imageItemsCount === 0 && textItemsCount === 0) {
      const suffix = videoItemsCount === 1 ? "video" : "videos";
      return isSimplified ? `${videoItemsCount} ${suffix}` : `${selectedVideoCount}/${videoItemsCount} ${suffix}`;
    }
    if (textItemsCount > 0 && imageItemsCount === 0 && videoItemsCount === 0) {
      const suffix = textItemsCount === 1 ? "text" : "texts";
      return isSimplified ? `${textItemsCount} ${suffix}` : `${selectedTextCount}/${textItemsCount} ${suffix}`;
    }
    if (imageItemsCount > 0 && videoItemsCount === 0 && textItemsCount === 0) {
      const suffix = imageItemsCount === 1 ? "image" : "images";
      return isSimplified ? `${imageItemsCount} ${suffix}` : `${selectedImageCount}/${imageItemsCount} ${suffix}`;
    }
    
    // Mixed media
    const mediaTotal = imageItemsCount + videoItemsCount;
    const mediaSelected = selectedImageCount + selectedVideoCount;
    if (videoItemsCount > 0 && imageItemsCount > 0 && textItemsCount === 0) {
      return isSimplified ? `${mediaTotal} media` : `${mediaSelected}/${mediaTotal} media`;
    }

    // Default/fallback
    return isSimplified ? `${totalCount} items` : `${selectedCount}/${totalCount} items`;
  })();

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans group"
      style={{ width: nodeWidth, padding: "0 20px 0 20px" }}
    >
      {/* External minimalist Header as seen in reference */}
      <div className="absolute -top-5 left-[24px] flex items-center">
        <span className="text-[13px] text-white/90 font-medium leading-none select-none">
          {title}
        </span>
      </div>

      {/* Main Node Card */}
      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-visible transition-all duration-300 ease-out flex flex-col",
          "border-[3px] shadow-[0_8px_32px_rgba(0,0,0,0.7)]",
          selected || isConnectingFrom
            ? "border-accent ring-1 ring-accent/30" 
            : "border-white/[0.14] hover:border-white/[0.22]",
        )}
        style={{ 
          borderRadius: BORDER_RADIUS, 
          backgroundColor: "#1a1a1a", 
          minHeight: dynamicMinHeight,
          maxHeight: 520
        }}
      >
        {/* Floating Quick Action Overlay (Clean Floating Bar above Card, matching reference & synchronized with GroupToolbar) */}
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
              onClick={handleRun}
              disabled={isRunning}
              title="Import items from upstream"
              className="nodrag nowheel w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] cursor-pointer text-white/70 hover:text-white"
            >
              {isRunning ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} fill="currentColor" />}
            </button>
            <span className="h-4 w-px bg-white/10 mx-0.5" />
            <button
              type="button"
              onClick={handleClear}
              title="Clear items"
              className="nodrag nowheel w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] cursor-pointer text-[#ef4444]"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </NodeToolbar>

        {/* Scrollable Wrapper to clip scrollbar within rounded corners */}
        <div 
          className="flex-1 flex flex-col min-h-0 overflow-hidden px-4 pt-3.5 pb-1.5"
          style={{ 
            borderTopLeftRadius: `${BORDER_RADIUS - 3}px`, 
            borderTopRightRadius: `${BORDER_RADIUS - 3}px` 
          }}
        >
          {/* Content Viewport */}
          <div 
            className="flex-1 pb-3 pr-2 overflow-y-auto img-gen-prompt"
          >
          {listItems.length === 0 ? (
            isRunning ? (
              <div 
                className="grid grid-cols-3 gap-2 pb-2"
                style={{
                  gridAutoRows: `${gridThumbSize}px`,
                }}
              >
                {Array.from({ length: 3 }).map((_, idx) => {
                  const tileProgress = Math.max(2, Math.min(98, Math.floor(simulatedProgress * (1 - idx * 0.15))));
                  const TileIcon = lockedType === "text" 
                    ? Type 
                    : lockedType === "video" 
                    ? Video 
                    : ImageUp;
                  return (
                    <div
                      key={idx}
                      className="relative rounded-[13px] overflow-hidden aspect-square border border-white/[0.04] bg-[#1d1d1d] flow-generating-sheen animate-fade-in"
                    >
                      <TileIcon size={14} className="absolute top-2.5 left-2.5 text-white/30" />
                      <span className="absolute top-2.5 right-2.5 text-[10px] font-semibold font-mono text-white/40">
                        {tileProgress}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                Icon={List}
                title="Empty List"
                hint="Connect Text or Media upstream nodes, then run to import items."
                actionLabel="Import Upstream"
                onAction={handleRun}
                minHeight={140}
              />
            )
          ) : (listViewMode === "grid" && lockedType !== "text") ? (
            /* Grid View - Beautiful dynamic grid layout matching user constraints */
            <div 
              className="grid gap-2 pb-2"
              style={{
                gridTemplateColumns: `repeat(${gridLayout.cols}, ${gridThumbSize}px)`,
                gridAutoRows: `${gridThumbSize}px`,
              }}
            >
              {listItems.map((item, idx) => {
                const isSelected = listSelectedIndexes.includes(idx);
                const isMedia = item.kind === "image" || item.kind === "video";
                const isItemVideo = item.kind === "video";
                const url = isMedia && item.mediaId ? mediaUrl(String(item.mediaId)) : (item.mediaUrl as string);
                const hasActiveSelections = listSelectedIndexes.length > 0;
                const shouldDim = hasActiveSelections && !isSelected;
                const itemStatus = typeof item.status === "string" ? item.status : undefined;
                // Req 3.4: an errored video slot (status "error" or a non-pending slot
                // that never produced a mediaId) renders an error frame instead of video.
                const isVideoError = isItemVideo && itemStatus !== "pending" && (itemStatus === "error" || item.mediaId == null);
                const videoPoster = typeof item.imageUrl === "string" ? item.imageUrl : undefined;

                return (
                  <div
                    key={item.id as string || idx}
                    onClick={(e) => toggleItemSelection(idx, e)}
                    onDoubleClick={() => {
                      if (isMedia && item.mediaId) {
                        useGenerationStore.getState().openResultViewer(rfId, idx);
                      }
                    }}
                    className={cn(
                      "relative rounded-[13px] overflow-hidden aspect-square border transition-all duration-150 select-none bg-[#1d1d1d]",
                      listSelectionMode ? "cursor-pointer" : "cursor-default",
                      listSelectionMode 
                        ? isSelected 
                          ? "border-accent ring-[2px] ring-accent opacity-100" 
                          : "border-white/[0.04] opacity-40 hover:opacity-60"
                        : shouldDim
                          ? "border-white/[0.04] opacity-40 hover:opacity-60"
                          : "border-white/[0.04] hover:border-white/[0.12]"
                    )}
                  >
                    {isVideoError ? (
                      /* Req 3.4: error frame for a failed video slot, keeps the video badge */
                      <>
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 bg-[#1d1d1d] text-red-400/80">
                          <AlertTriangle size={18} />
                          <span className="text-[9px] text-white/50 text-center leading-snug line-clamp-2">
                            {String(item.error || "Failed")}
                          </span>
                        </div>
                        <div className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-white/90">
                          <Video size={10} />
                        </div>
                      </>
                    ) : isItemVideo && url ? (
                      /* Req 5.1: playable video thumbnail; Req 5.6: keep the video badge */
                      <>
                        <VideoListThumb src={url} poster={videoPoster} fit={imageFit} />
                        <div className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-white/90">
                          <Video size={10} />
                        </div>
                      </>
                    ) : isMedia && url ? (
                      <img
                        src={url}
                        alt={String(item.title)}
                        draggable={false}
                        className={cn(
                          "absolute inset-0 size-full transition-all duration-200",
                          imageFit === "contain" ? "object-contain bg-black/40" : "object-cover"
                        )}
                      />
                    ) : (
                      <div className="absolute inset-0 p-2 flex flex-col justify-between">
                        <Type size={12} className="text-white/40" />
                        <span className="text-[10px] text-white/70 line-clamp-3 leading-snug">
                          {String(item.text || item.title || "")}
                        </span>
                      </div>
                    )}

                    {/* Circular Selection Overlay Checkbox (Exactly matching mockup Image 2) */}
                    {listSelectionMode && (
                      <div className="absolute top-2 right-2 z-10">
                        <div className={cn(
                          "size-5 rounded-full flex items-center justify-center border text-[9px] font-bold transition-all shadow-md",
                          isSelected 
                            ? "bg-accent border-accent text-white" 
                            : "border-white/40 bg-black/40 text-transparent"
                        )}>
                          {isSelected && <Check size={12} strokeWidth={3} />}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* List View - Perfect rows matching mockup Image 1 */
            <div className="flex flex-col gap-0 pb-2">
              {listItems.map((item, idx) => {
                const isSelected = listSelectedIndexes.includes(idx);
                const isMedia = item.kind === "image" || item.kind === "video";
                const isItemVideo = item.kind === "video";
                const url = isMedia && item.mediaId ? mediaUrl(String(item.mediaId)) : (item.mediaUrl as string);
                const hasActiveSelections = listSelectedIndexes.length > 0;
                const shouldDim = hasActiveSelections && !isSelected;
                const isTextItem = item.kind === "text" || lockedType === "text";
                const itemStatus = typeof item.status === "string" ? item.status : undefined;
                // Req 3.4: an errored video slot renders an error frame instead of video.
                const isVideoError = isItemVideo && itemStatus !== "pending" && (itemStatus === "error" || item.mediaId == null);
                const videoPoster = typeof item.imageUrl === "string" ? item.imageUrl : undefined;

                // Resolution mock/logic
                const res = item.width && item.height 
                  ? `${item.width} × ${item.height}` 
                  : `1119 × ${1660 + (idx * 3) % 20}`; // Fallback resolution matching mockup style

                return (
                  <div
                    key={item.id as string || idx}
                    onClick={(e) => toggleItemSelection(idx, e)}
                    onDoubleClick={() => {
                      if (isMedia && item.mediaId) {
                        useGenerationStore.getState().openResultViewer(rfId, idx);
                      }
                    }}
                    className={cn(
                      "flex items-center py-3 border-b border-white/[0.04] transition-all duration-150 select-none",
                      isTextItem ? "px-1 gap-2.5" : "px-2 gap-3.5",
                      listSelectionMode ? "cursor-pointer" : "cursor-default",
                      listSelectionMode 
                        ? isSelected 
                          ? "bg-accent/5 opacity-100" 
                          : "opacity-40 hover:opacity-60"
                        : shouldDim
                          ? "opacity-40 hover:opacity-60"
                          : "hover:bg-white/[0.02]"
                    )}
                  >
                    {/* Checkbox badge in List View */}
                    {listSelectionMode && (
                      <div className={cn(
                        "size-5 rounded-full flex items-center justify-center border text-[10px] font-bold shrink-0 transition-all shadow-sm",
                        isSelected 
                          ? "bg-accent border-accent text-white" 
                          : "border-white/30 bg-black/30 text-transparent"
                      )}>
                        {isSelected && <Check size={11} strokeWidth={3} />}
                      </div>
                    )}

                    {isTextItem ? (
                      /* Clean Text Layout matching user mockup perfectly */
                      <div className="flex-1 min-w-0 pr-1">
                        <p className="text-[13px] text-white/90 font-normal leading-relaxed line-clamp-2 select-text selection:bg-accent/30">
                          {String(item.text || item.title || "")}
                        </p>
                      </div>
                    ) : (
                      /* Media (Image / Video) Layout */
                      <>
                        {/* Thumbnail */}
                        {isVideoError ? (
                          /* Req 3.4: error frame for a failed video slot, keeps the video badge */
                          <div className="relative size-[40px] rounded-[6px] overflow-hidden bg-black/25 shrink-0 border border-white/[0.06] flex items-center justify-center text-red-400/80">
                            <AlertTriangle size={16} />
                            <div className="absolute bottom-0.5 right-0.5 p-0.5 rounded bg-black/60 text-white/90">
                              <Video size={8} />
                            </div>
                          </div>
                        ) : isItemVideo && url ? (
                          /* Req 5.1: playable video thumbnail; Req 5.6: keep the video badge */
                          <div className="relative size-[40px] rounded-[6px] overflow-hidden bg-black/25 shrink-0 border border-white/[0.06]">
                            <VideoListThumb src={url} poster={videoPoster} fit={imageFit} />
                            <div className="absolute bottom-0.5 right-0.5 p-0.5 rounded bg-black/60 text-white/90">
                              <Video size={8} />
                            </div>
                          </div>
                        ) : isMedia && url ? (
                          <div className="relative size-[40px] rounded-[6px] overflow-hidden bg-black/25 shrink-0 border border-white/[0.06]">
                            <img
                              src={url}
                              alt={String(item.title)}
                              draggable={false}
                              className={cn(
                                "size-full transition-all duration-200",
                                imageFit === "contain" ? "object-contain bg-black/40" : "object-cover"
                              )}
                            />
                          </div>
                        ) : (
                          <div className="size-[40px] rounded-[6px] bg-white/[0.04] flex items-center justify-center shrink-0 border border-white/[0.06]">
                            <Type size={14} className="text-white/40" />
                          </div>
                        )}

                        {/* Title & Resolution Subtext */}
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <span className="text-sm font-semibold text-white/90 truncate leading-none mb-1">
                            {String(item.title || "")}
                          </span>
                          <span className="text-3xs text-white/45 font-medium leading-none">
                            {res}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>

        {/* Elegant Bottom Toolbar - Docked at the bottom inside card container */}
        <div
          onMouseDown={stopNodeAction}
          onClick={stopNodeAction}
          onDoubleClick={stopNodeAction}
          className="nodrag nowheel h-14 flex items-center justify-between px-4 z-30 bg-transparent shrink-0 pb-3"
        >
          {/* Left Actions */}
          <div className="flex items-center gap-1.5">
            {listSelectionMode ? (
              /* Selection Actions (Mockup Image 2) */
              <>
                <button
                  onClick={selectAllItems}
                  title={allSelected ? "Deselect All" : "Select All"}
                  className="flex items-center justify-center size-[26px] rounded-full bg-white/[0.06] border border-white/[0.08] text-white/80 hover:text-white hover:bg-white/[0.12] transition-all cursor-pointer"
                >
                  <Check size={13} strokeWidth={2.5} />
                </button>
                <button
                  onClick={invertSelection}
                  title="Invert Selection"
                  className="flex items-center justify-center size-[26px] rounded-full bg-white/[0.06] border border-white/[0.08] text-white/80 hover:text-white hover:bg-white/[0.12] transition-all cursor-pointer"
                >
                  {/* Swap icon */}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                </button>
              </>
            ) : (
              /* Regular Intake dropdown and triggers */
              <>
                <button 
                  onClick={handlePlusClick}
                  className="flex items-center justify-center size-[26px] rounded-full bg-white/[0.06] border border-white/[0.08] text-white/80 hover:text-white hover:bg-white/[0.12] transition-all cursor-pointer"
                  title="Upload files directly"
                >
                  <Plus size={13} strokeWidth={2.5} />
                </button>
                
                {/* Intake Selector Dropdown (Mockup Image 2) */}
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setShowIntakeDropdown(!showIntakeDropdown)}
                    className="flex h-[26px] items-center gap-1 rounded-full bg-white/[0.06] border border-white/[0.08] px-2.5 text-2xs font-semibold text-white/80 hover:text-white hover:bg-white/[0.12] transition-colors cursor-pointer select-none"
                  >
                    {listIntakeMode === "replace" ? "Replace Items" : "Keep Items"}
                    <ChevronDown size={11} className="text-white/40" />
                  </button>

                  {/* Upward custom dropdown popover styled exactly like mockup */}
                  {showIntakeDropdown && (
                    <div 
                      className="absolute bottom-9 left-0 w-64 rounded-xl border border-white/[0.08] shadow-2xl p-1 z-[9999]"
                      style={{ backgroundColor: "#1e1e1e" }}
                    >
                      <button
                        onClick={(e) => setIntakeMode("keep", e)}
                        className={cn(
                          "w-full flex flex-col items-start px-3 py-2 rounded-lg text-left transition-colors cursor-pointer",
                          listIntakeMode === "keep" ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
                        )}
                      >
                        <span className="text-xs font-semibold text-white/90">Keep Items</span>
                        <span className="text-4xs text-white/40 mt-0.5 leading-tight">New items will be added</span>
                      </button>
                      
                      <button
                        onClick={(e) => setIntakeMode("replace", e)}
                        className={cn(
                          "w-full flex flex-col items-start px-3 py-2 rounded-lg text-left transition-colors cursor-pointer mt-0.5",
                          listIntakeMode === "replace" ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
                        )}
                      >
                        <span className="text-xs font-semibold text-white/90">Replace Items</span>
                        <span className="text-4xs text-white/40 mt-0.5 leading-tight">New items will replace existing</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-1.5">
            {/* Pill showing image count / toggling selection mode */}
            <button 
              onClick={() => toggleSelectionMode()}
              className={cn(
                "flex items-center gap-1 h-[26px] px-2.5 rounded-full border transition-all cursor-pointer",
                listSelectionMode
                  ? "bg-accent/15 border-accent text-accent"
                  : "bg-white/[0.06] border-white/[0.08] text-white/80 hover:text-white hover:bg-white/[0.12]"
              )}
              title="Select element (Toggle selection mode)"
            >
              <span className="text-2xs font-semibold select-none">
                {selectionPillLabel}
              </span>
              <div className="size-3.5 rounded-full bg-white/20 flex items-center justify-center">
                <Check size={8} strokeWidth={3.5} className="text-white" />
              </div>
            </button>

            {/* List/Grid toggles */}
            {lockedType !== "text" && (
              <div className="flex items-center rounded-full bg-white/[0.04] border border-white/[0.06] p-0.5">
                <button
                  onClick={(e) => setViewMode("list", e)}
                  className={cn(
                    "p-1 rounded-full transition-colors cursor-pointer",
                    listViewMode === "list" ? "bg-white/[0.1] text-white" : "text-white/40 hover:text-white"
                  )}
                >
                  <List size={12} />
                </button>
                <button
                  onClick={(e) => setViewMode("grid", e)}
                  className={cn(
                    "p-1 rounded-full transition-colors cursor-pointer",
                    listViewMode === "grid" ? "bg-white/[0.1] text-white" : "text-white/40 hover:text-white"
                  )}
                >
                  <Grid size={12} />
                </button>
              </div>
            )}

            {/* Fill / Fit thumbnail mode toggle */}
            {lockedType !== "text" && (
              <button
                onClick={toggleImageFit}
                title={`Thumbnail layout: ${imageFit === "cover" ? "Fill (Cover)" : "Fit (Contain)"}`}
                className={cn(
                  "flex items-center justify-center size-[26px] rounded-full border transition-all cursor-pointer",
                  imageFit === "contain"
                    ? "bg-white/[0.15] border-white/20 text-white"
                    : "bg-white/[0.06] border-white/[0.08] text-white/80 hover:text-white hover:bg-white/[0.12]"
                )}
              >
                {imageFit === "cover" ? (
                  /* Fill (Cover/Expand) icon matching mockup 1 */
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="10" width="12" height="4" rx="1.2" />
                    <path d="M8 6L12 3L16 6" />
                    <path d="M8 18L12 21L16 18" />
                  </svg>
                ) : (
                  /* Fit (Contain/Shrink) icon matching mockup 2 */
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="10" width="12" height="4" rx="1.2" />
                    <path d="M8 3L12 6L16 3" />
                    <path d="M8 21L12 18L16 21" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Hidden File Input for Direct Uploads */}
        <input
          type="file"
          ref={uploadInputRef}
          multiple
          accept="image/*,video/*"
          style={{ display: "none" }}
          onChange={handleFileUpload}
        />

        {/* Outer Resize Handle */}
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
      </div>

      {/* ==================================================================== */}
      {/* HANDLES PLACE AT THE VERY END (ReactFlow 12 DOM Order Rules)          */}
      {/* ==================================================================== */}

      {/* TARGET handles - left side */}
      {shouldRenderTextHandles && (
        <Handle
          type="target"
          position={Position.Left}
          id="target-text"
          style={{ bottom: 98, top: "auto" }}
          className={targetHandleClassName(hasTextTargetEdge)}
        >
          <HandleBadge icon={Type} active={hasTextTargetEdge} label="Text Input" side="left" />
        </Handle>
      )}

      {shouldRenderVideoHandles && (
        <Handle
          type="target"
          position={Position.Left}
          id="target-video"
          style={{ bottom: 58, top: "auto" }}
          className={targetHandleClassName(hasVideoTargetEdge)}
        >
          <HandleBadge icon={Video} active={hasVideoTargetEdge} label="Video Input" side="left" />
        </Handle>
      )}

      {shouldRenderImageHandles && (
        <Handle
          type="target"
          position={Position.Left}
          id="target-image"
          style={{ bottom: 18, top: "auto" }}
          className={targetHandleClassName(hasImageTargetEdge)}
        >
          <HandleBadge icon={ImageUp} active={hasImageTargetEdge} label="Media Input" side="left" />
        </Handle>
      )}

      {/* SOURCE handles - right side */}
      {shouldRenderTextHandles && (
        <Handle
          type="source"
          position={Position.Right}
          id="source-text"
          style={{ top: 48 }}
          className={sourceHandleClassName(hasTextSourceEdge)}
        >
          <HandleBadge icon={Type} active={hasTextSourceEdge} label="Text Items" side="right" />
        </Handle>
      )}

      {shouldRenderVideoHandles && (
        <Handle
          type="source"
          position={Position.Right}
          id="source-video"
          style={{ top: 88 }}
          className={sourceHandleClassName(hasVideoSourceEdge)}
        >
          <HandleBadge icon={Video} active={hasVideoSourceEdge} label="Video Items" side="right" />
        </Handle>
      )}

      {shouldRenderImageHandles && (
        <Handle
          type="source"
          position={Position.Right}
          id="source-image"
          style={{ top: 128 }}
          className={sourceHandleClassName(hasImageSourceEdge)}
        >
          <HandleBadge icon={ImageUp} active={hasImageSourceEdge} label="Media Items" side="right" />
        </Handle>
      )}
    </div>
  );
}





