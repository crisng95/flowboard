import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const refType = (data.refType as ReferenceTypeKey | undefined) ?? "texture";
  const shortId = data.shortId as string | undefined;
  const aspectRatio = data.aspectRatio as string | undefined;
  const userNote = (data.prompt as string | undefined) ?? "";
  const aiBrief = (data.aiBrief as string | undefined) ?? "";
  const aiBriefPending = (data.aiBriefStatus as string | undefined) === "pending";

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
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  // Anchor + viewport coords for the type-picker dropdown. We render
  // the menu through a portal so `overflow-hidden` on the image slot
  // doesn't clip the 10-tag list (the previous in-tree absolute
  // positioning got cut off when the node was small).
  const tagButtonRef = useRef<HTMLButtonElement | null>(null);
  const [tagMenuPos, setTagMenuPos] = useState<{ left: number; top: number } | null>(null);

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

  // Track the trigger button's viewport rect every animation frame
  // while the menu is open. Using a portal escapes the image slot's
  // `overflow-hidden`, but a portal also detaches the menu from the
  // canvas's pan/zoom transform - so without this loop the menu
  // would stay frozen in place when the user drags the board.
  // rAF is cheap (~60fps reads of one bounding rect) and only runs
  // while the menu is visible.
  useEffect(() => {
    if (!showTypePicker) {
      setTagMenuPos(null);
      return;
    }
    let raf = 0;
    function tick() {
      const btn = tagButtonRef.current;
      if (btn) {
        const r = btn.getBoundingClientRect();
        setTagMenuPos({
          left: r.left,
          top: r.bottom + 4, // 4px gap below the trigger
        });
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    function onDocumentMouseDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      const btn = tagButtonRef.current;
      if (btn && btn.contains(target)) return;
      const menu = document.getElementById(`add-ref-tag-menu-${rfId}`);
      if (menu && menu.contains(target)) return;
      setShowTypePicker(false);
    }
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", onDocumentMouseDown);
    };
  }, [showTypePicker, rfId]);

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
            // Drive the box ratio from the actual image dimensions
            // when available - that way 4:3, 3:4, 5:7, 21:9 (anything
            // outside Flow's 3-bucket SQUARE/PORTRAIT/LANDSCAPE enum)
            // all render at their true ratio. Backend keeps using
            // the enum for downstream gen because Flow's API only
            // accepts those three values.
            // Fall back to the enum-derived CSS ratio while the image
            // is still loading, then to 1:1, then to 4:3 for the
            // empty drop-zone state.
            aspectRatio: mediaId
              ? imgSize
                ? `${imgSize.w} / ${imgSize.h}`
                : flowAspectToCss(aspectRatio) ?? "1 / 1"
              : "4 / 3",
            borderRadius: BORDER_RADIUS - 3,
          }}
        >
          {/* Filled state */}
          {flow.bodyState === "filled" && mediaId && (
            <>
              <img
                src={mediaUrl(mediaId)}
                alt="reference"
                className={cn(
                  "absolute inset-0 size-full object-cover transition-all duration-300",
                  promptFocused && "blur-sm scale-[1.02]",
                )}
                onLoad={onImageLoad}
                onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId)}
              />
              {promptFocused && (
                <div className="absolute inset-0 bg-black/50 transition-opacity duration-300 z-[5]" />
              )}
              {imgSize && showControls && (
                <div
                  className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-2xs font-medium text-ink-primary z-10"
                  style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
                >
                  {imgSize.w} {"\u00d7"} {imgSize.h}
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

          {/* Bottom overlay: prompt textarea + toolbar (type picker +
              Replace) layered ON the image. Mirrors the ImageGenerator
              pattern so both nodes feel consistent. The textarea uses
              `aiBrief` as its placeholder so the user sees the auto
              description while still being able to type a manual note.
              When there's no media yet, the toolbar still shows so
              users can pick the right tag BEFORE uploading - that
              tag drives which vision profile runs after upload, so
              picking it first is the correct mental model. The
              textarea is hidden in the empty state because there's
              no image to caption yet. */}
          <div className="absolute bottom-0 left-0 right-0 z-10 transition-all duration-300 ease-out">
            {mediaId && (
              <div className={cn(
                "px-4 pb-1 transition-all duration-300 ease-out",
                promptFocused ? "pt-4" : "pt-2",
              )}>
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
                  className="img-gen-prompt w-full bg-transparent text-sm text-white placeholder:text-white/70 resize-none outline-none border-0 leading-relaxed"
                />
              </div>
            )}

              <div className={cn(
                "flex items-center gap-1.5 px-3 pb-3 pt-0",
                "transition-all duration-300 ease-out",
                showControls
                  ? "max-h-[48px] opacity-100 translate-y-0"
                  : "max-h-0 opacity-0 translate-y-1 overflow-hidden",
              )}>
                <div className="relative">
                  <button
                    ref={tagButtonRef}
                    onClick={() => setShowTypePicker(!showTypePicker)}
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium text-white/80 hover:text-white transition-colors whitespace-nowrap"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                  >
                    <Tag size={11} strokeWidth={2} />
                    {currentTypeLabel}
                    <span className="text-[8px] opacity-50">{"\u25be"}</span>
                  </button>
                </div>

                <div className="flex-1" />

                {mediaId && (
                  <button
                    onClick={flow.pickFile}
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium text-white/80 hover:text-white transition-colors whitespace-nowrap"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                  >
                    <Replace size={11} strokeWidth={2} />
                    Replace
                  </button>
                )}
              </div>
          </div>
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

      {/* Portal-rendered tag picker - escapes the image slot's
          `overflow-hidden` so the full 10-tag list is always visible
          regardless of node size. Positioned via the trigger rect. */}
      {showTypePicker && tagMenuPos && createPortal(
        <div
          id={`add-ref-tag-menu-${rfId}`}
          className="fixed rounded-lg p-1 shadow-xl border border-white/[0.08] z-[1000]"
          style={{
            left: tagMenuPos.left,
            top: tagMenuPos.top,
            backgroundColor: "#2a2a2a",
          }}
        >
          {REFERENCE_TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => setRefType(t.key as ReferenceTypeKey)}
              className={cn(
                "block w-full text-left px-3 py-1.5 rounded-md text-2xs whitespace-nowrap transition-colors",
                t.key === refType
                  ? "text-accent bg-accent/10"
                  : "text-white/80 hover:text-white hover:bg-white/[0.06]",
              )}
            >
              {t.label}
              <span className="ml-2 text-ink-placeholder">{t.hint}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
