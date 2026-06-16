import { useCallback, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import { ImageUp, Upload } from "lucide-react";

import { useBoardStore, type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { useUploadFlow, mediaUrl } from "./shared/useUploadFlow";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { ResizeHandle } from "./shared/ResizeHandle";
import { useNodeWidth } from "./shared/useNodeWidth";
import { persistNodeData } from "./shared/persistNodeData";
import { HandleBadge } from "./shared/HandleBadge";
import { edgeHandleClass, EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET } from "./shared/edgeHandle";
import { createNode } from "../../api/client";
import { ReferenceLibraryModal, referenceCategoryLabel, type ReferenceCategoryKey, type ReferencePreset, type CharacterConfig } from "./shared/ReferenceLibraryModal";
import { buildCharacterPrompt } from "./shared/buildCharacterPrompt";

const MIN_WIDTH = 200;
const MAX_WIDTH = 2000;
const DEFAULT_WIDTH = 240;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;

// Map Flow's IMAGE_ASPECT_RATIO_* enum to a CSS `aspect-ratio` value.
// The upload route stamps `data.aspectRatio` with the enum string
// (e.g. "IMAGE_ASPECT_RATIO_PORTRAIT"), but CSS only understands
// numeric ratios like "9 / 16" - feeding the enum directly leaves the
// box at its fallback "1 / 1" so the node never resizes to match the
// uploaded image. Returns null for unrecognised input so the caller
// can fall back without producing an invalid CSS value.
function flowAspectToCss(value: string | undefined): string | null {
  if (!value) return null;
  if (value.includes("/")) return value; // already CSS form
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

export function AddReferenceNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data);
  const { width: nodeWidth, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId, data, min: MIN_WIDTH, max: MAX_WIDTH, fallback: DEFAULT_WIDTH,
  });

  const mediaId = data.mediaId as string | undefined;
  const referenceCategory = (data.referenceCategory as ReferenceCategoryKey | undefined) ?? "style";
  const shortId = data.shortId as string | undefined;
  const aspectRatio = data.aspectRatio as string | undefined;
  const userNote = (data.prompt as string | undefined) ?? "";
  const aiBrief = (data.aiBrief as string | undefined) ?? "";
  const aiBriefPending = (data.aiBriefStatus as string | undefined) === "pending";
  const nodeStatus = (data.status as string | undefined) ?? "idle";
  const isGenerating = nodeStatus === "queued" || nodeStatus === "running";

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

  // Seed imgSize from persisted node data so the aspect-ratio is
  // correct immediately on mount / reload without waiting for the
  // <img> onLoad event. onImageLoad will overwrite with the same
  // values once the image element fires.
  const persistedW = data.imageWidth as number | undefined;
  const persistedH = data.imageHeight as number | undefined;
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(
    persistedW && persistedH ? { w: persistedW, h: persistedH } : null,
  );
  const [promptFocused, setPromptFocused] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryCategory, setLibraryCategory] = useState<ReferenceCategoryKey>(referenceCategory);
  const showOverlay = mediaId !== undefined && mediaId !== "" && (showControls || promptFocused);

  const applyPresetToCurrentNode = useCallback(async (preset: ReferencePreset) => {
    persistNodeData(rfId, {
      prompt: preset.prompt,
      refType: preset.refType as any,
      referenceCategory: preset.category,
      presetKey: preset.key,
      mediaId: preset.thumbnail,
      aiBrief: null,
      aiBriefStatus: undefined,
      renderedAt: new Date().toISOString(),
    });
  }, [rfId]);

  const spawnPresetNode = useCallback(async (preset: ReferencePreset, index: number) => {
    const { boardId, nodes, setNodes } = useBoardStore.getState();
    if (boardId === null) return;
    const current = nodes.find((node) => node.id === rfId);
    const x = current?.position.x ?? 0;
    const y = (current?.position.y ?? 0) + index * 300;
    try {
      const dto = await createNode({
        board_id: boardId,
        type: "add_reference",
        x: Math.round(x),
        y: Math.round(y),
        data: {
          title: "Reference",
          prompt: preset.prompt,
          refType: preset.refType,
          referenceCategory: preset.category,
          presetKey: preset.key,
          mediaId: preset.thumbnail,
          aiBrief: null,
          aiBriefStatus: undefined,
          renderedAt: new Date().toISOString(),
        },
      });
      setNodes([
        ...useBoardStore.getState().nodes,
        {
          id: String(dto.id),
          type: dto.type,
          position: { x: dto.x, y: dto.y },
          zIndex: 1,
          data: {
            ...dto.data,
            type: dto.type,
            shortId: dto.short_id,
            title: (dto.data["title"] as string | undefined) ?? "Reference",
            status: dto.status,
            prompt: preset.prompt,
            refType: preset.refType,
            referenceCategory: preset.category,
            presetKey: preset.key,
            mediaId: preset.thumbnail,
            aiBrief: null,
          },
        },
      ]);
    } catch (err) {
      console.error("Failed to spawn reference preset node:", err);
    }
  }, [rfId]);

  const handleSelectPresets = useCallback(async (presets: ReferencePreset[]) => {
    if (presets.length === 0) return;
    await applyPresetToCurrentNode(presets[0]);
    await Promise.all(presets.slice(1).map((preset, index) => spawnPresetNode(preset, index + 1)));
  }, [applyPresetToCurrentNode, spawnPresetNode]);

  // Character builder → dispatch generation directly from this node
  const handleGenerateCharacter = useCallback(async (config: CharacterConfig) => {
    const prompt = buildCharacterPrompt(config);
    // Persist character metadata and prompt on the node
    persistNodeData(rfId, {
      prompt,
      refType: "character",
      referenceCategory: "character",
      charGender: config.gender ?? undefined,
      charCountry: config.country ?? undefined,
      charVibe: config.vibe,
      aiBrief: null,
      aiBriefStatus: undefined,
    });
    // Dispatch image generation — the generation store handles
    // queued → running → done state transitions and polls for results.
    // Aspect ratio is hardcoded to SQUARE for character headshots.
    useGenerationStore.getState().dispatchGeneration(rfId, {
      prompt,
      aspectRatio: "IMAGE_ASPECT_RATIO_SQUARE",
      variantCount: 1,
    });
  }, [rfId]);

  const displayUrl = mediaId && (mediaId.startsWith("http://") || mediaId.startsWith("https://"))
    ? mediaId
    : mediaId
      ? mediaUrl(mediaId)
      : "";
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

  function setUserNote(value: string) {
    persistNodeData(rfId, { prompt: value });
  }

  function stopNodeAction(event: React.MouseEvent) {
    event.stopPropagation();
  }

  const currentCategoryLabel = referenceCategoryLabel(referenceCategory);

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width: nodeWidth, padding: "0 20px 0 20px" }}
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
          "border-[3px] border-white/[0.14] shadow-[0_8px_28px_-10px_rgba(0,0,0,0.6)]",
          selected && "ring-2 ring-accent/50",
          isGenerating && "ring-2 ring-accent/30 animate-pulse",
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
            !mediaId && !isGenerating && "min-h-[180px]",
          )}
          style={{
            aspectRatio: mediaId
              ? imgSize
                ? `${imgSize.w} / ${imgSize.h}`
                : flowAspectToCss(aspectRatio) ?? "1 / 1"
              : "1 / 1",
            borderRadius: BORDER_RADIUS - 3,
          }}
        >
          {/* Filled state */}
          {flow.bodyState === "filled" && mediaId && (
            <>
              <img
                src={displayUrl}
                alt="reference"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                className={cn(
                  "absolute inset-0 size-full object-cover transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  promptFocused && "blur-sm scale-[1.02]",
                )}
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
              {promptFocused && (
                <div className="absolute inset-0 bg-black/50 transition-opacity duration-300 z-[5]" />
              )}

              {/* Floating Fullscreen button */}
              {showControls && !promptFocused && (
                <button
                  type="button"
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => useGenerationStore.getState().openResultViewer(rfId)}
                  className="nodrag nowheel absolute top-2.5 left-2.5 z-20 flex items-center justify-center rounded-full transition-all duration-150 hover:scale-110"
                  style={{
                    width: 28, height: 28,
                    backgroundColor: "rgba(0,0,0,0.55)",
                    backdropFilter: "blur(6px)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "rgba(255,255,255,0.85)",
                  }}
                  title="View fullscreen"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </button>
              )}

              {imgSize && showControls && (
                <div
                  className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-2xs font-medium text-ink-primary z-10"
                  style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
                >
                  {imgSize.w} × {imgSize.h}
                </div>
              )}
            </>
          )}

          {/* Uploading */}
          {flow.bodyState === "uploading" && <UploadingOverlay />}

          {/* Generating character overlay */}
          {isGenerating && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 backdrop-blur-sm z-10">
              <div className="size-8 rounded-full border-2 border-white/20 border-t-accent animate-spin" />
              <span className="text-2xs font-medium text-white/70">
                {nodeStatus === "queued" ? "Queued…" : "Generating…"}
              </span>
            </div>
          )}

          {/* Empty state */}
          {flow.bodyState === "empty" && !flow.dragOver && !isGenerating && (
            <div
              className="flex size-full flex-col items-center justify-center gap-5 p-4 bg-white/[0.01] cursor-pointer hover:bg-white/[0.03] transition-colors duration-300"
              onClick={() => setShowLibrary(true)}
            >
              <div className="flex flex-col items-center gap-4">
                <span className="max-w-[140px] text-center text-xs leading-snug text-white/40 select-none tracking-wide">
                  Add a reference to guide your generation
                </span>
                <button
                  type="button"
                  className="nodrag nowheel cursor-pointer rounded-lg border border-white/[0.08] px-3 py-1.5 text-2xs font-medium text-white/70 hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white transition-all active:scale-95 duration-150"
                >
                  Select Reference
                </button>
              </div>
            </div>
          )}

          {/* Drag over state */}
          {flow.bodyState === "empty" && flow.dragOver && (
            <div className="flex flex-col items-center gap-3 text-accent animate-pulse-soft">
              <div
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 44, height: 44,
                  backgroundColor: "rgba(124,92,255,0.15)",
                  border: "1px dashed rgba(124,92,255,0.3)",
                }}
              >
                <Upload size={18} strokeWidth={2} />
              </div>
              <span className="text-2xs font-medium text-accent">Drop to upload</span>
            </div>
          )}

          {/* Error */}
          {flow.bodyState === "error" && flow.error && (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <span className="text-2xs text-red-400">{flow.error}</span>
              <button type="button" onMouseDown={stopNodeAction} onDoubleClick={stopNodeAction} onClick={(event) => { stopNodeAction(event); flow.pickFile(); }} className="nodrag nowheel text-2xs text-accent hover:underline">Try again</button>
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

          {/* Bottom overlay: hidden while idle, slides in on hover/select/focus */}
          {mediaId && (
            <div
              className={cn(
                "absolute bottom-0 left-0 right-0 z-10",
                "transition-all duration-300 ease-in-out",
                showOverlay
                  ? "opacity-100 translate-y-0 pointer-events-auto"
                  : "opacity-0 translate-y-4 pointer-events-none",
              )}
            >
              <div
                className="absolute inset-x-0 bottom-0 h-24"
                style={{
                  background: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.32) 30%, rgba(0,0,0,0.72) 100%)",
                }}
              />
              <div className="relative px-3 pb-3 pt-8">
                <textarea
                  value={userNote}
                  onChange={(e) => setUserNote(e.target.value)}
                  spellCheck={false}
                  placeholder={
                    aiBriefPending
                      ? "Analyzing image..."
                      : aiBrief || "Add a note about this reference..."
                  }
                  rows={promptFocused ? 6 : 1}
                  onFocus={() => setPromptFocused(true)}
                  onBlur={() => setPromptFocused(false)}
                  onMouseDown={stopNodeAction}
                  onClick={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  className="img-gen-prompt nodrag nowheel w-full bg-transparent text-sm text-white placeholder:text-white/70 resize-none outline-none border-0 leading-relaxed"
                />
                <div className="mt-2 flex items-center">
                  <button
                  type="button"
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => {
                      setLibraryCategory(referenceCategory);
                      setShowLibrary(true);
                    }}
                    className={cn(
                      "nodrag nowheel rounded-full border px-2.5 py-1 text-[10px] font-medium",
                      "border-white/[0.08] bg-black/45 text-white/70 backdrop-blur-md transition-colors",
                      "hover:bg-black/60 hover:text-white",
                    )}
                  >
                    {currentCategoryLabel}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

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
      </div>

      {/* Source handle (output) - right side, 48px from top */}
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        style={{ top: EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET }}
        className={edgeHandleClass({ side: "right", visible: showHandle })}
      >
        <HandleBadge icon={ImageUp} active={hasConnectedEdge} label="Reference Image" side="right" />
      </Handle>

      {/* Hidden file input */}
      <input
        type="file"
        className="hidden"
        ref={flow.fileInputProps.ref}
        accept={flow.fileInputProps.accept}
        onChange={flow.fileInputProps.onChange}
      />

      {/* Reference Preset Library Modal */}
      <ReferenceLibraryModal
        isOpen={showLibrary}
        onClose={() => setShowLibrary(false)}
        onSelect={handleSelectPresets}
        onUploadCustom={flow.pickFile}
        onGenerateCharacter={handleGenerateCharacter}
        initialCategory={libraryCategory}
      />
    </div>
  );
}
