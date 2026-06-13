import { useCallback, useRef, useState, useEffect } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import { ImageUp, Play, RefreshCw, Settings, Type, X } from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useBoardStore } from "../../store/board";
import { collectSelectedTextPrompts, useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { mediaUrl } from "./shared/useUploadFlow";
import { persistNodeData } from "./shared/persistNodeData";
import { ResizeHandle } from "./shared/ResizeHandle";
import { CountStepper } from "./shared/CountStepper";
import { useNodeWidth } from "./shared/useNodeWidth";
import { HandleBadge } from "./shared/HandleBadge";
import { DropdownCaret } from "./shared/DropdownCaret";
import { PickerDropdown } from "./shared/PickerDropdown";
import { edgeHandleClass, EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET } from "./shared/edgeHandle";
import { normalizeImageModelKey, type ActiveImageModelKey } from "../../store/settings";
import { FluidGradientStyles } from "./GoogleFlowStudio";

const MIN_WIDTH = 300;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 400;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;

type AspectOption = "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
const ASPECT_OPTIONS: AspectOption[] = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const ASPECT_CSS: Record<AspectOption, string> = {
  "1:1": "1 / 1",
  "3:4": "3 / 4",
  "4:3": "4 / 3",
  "16:9": "16 / 9",
  "9:16": "9 / 16",
};
type ModelOption = { key: string; label: string };
const MODEL_OPTIONS: ModelOption[] = [
  { key: "NANO_BANANA_PRO", label: "Nano Banana Pro" },
  { key: "NANO_BANANA_2", label: "Nano Banana 2" },
];

export function ImageGeneratorNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const status = data.status as string | undefined;
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
      }, 800);
      return () => clearInterval(interval);
    } else {
      setSimulatedProgress(2);
    }
  }, [isRunning]);

  // Track previous isRunning to detect generation completion (true → false)
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      // Generation just finished — apply any pending aspect
      const pending = useBoardStore.getState().nodes.find((n) => n.id === rfId)?.data.pendingAspectKey as AspectOption | undefined;
      if (pending) {
        useBoardStore.getState().updateNodeData(rfId, { aspectKey: pending, pendingAspectKey: null });
        persistNodeData(rfId, { aspectKey: pending, pendingAspectKey: null });
      }
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, rfId]);

  const mediaIds = Array.isArray(data.mediaIds)
    ? data.mediaIds.filter((m): m is string => typeof m === "string" && !!m)
    : [];
  const mediaId = mediaIds[0] ?? (data.mediaId as string | undefined);
  const prompt = (data.prompt as string | undefined) ?? "";
  const imageCount = Math.max(
    1,
    Math.min(
      (data.imageCount as number | undefined)
        ?? (data.variantCount as number | undefined)
        ?? 1,
      4,
    ),
  );
  const aspectKey = (data.aspectKey as AspectOption | undefined) ?? "1:1";
  // pendingAspectKey: chosen by user but not yet applied to the node layout.
  // It will be committed to aspectKey only after generation completes.
  const pendingAspectKey = (data.pendingAspectKey as AspectOption | undefined) ?? null;
  // The aspect shown in the picker button (pending overrides display, but not layout)
  const displayAspectKey = pendingAspectKey ?? aspectKey;
  const modelKey = normalizeImageModelKey(data.modelKey as string | undefined);
  const shortId = data.shortId as string | undefined;

  const { width: nodeWidth, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId, data, min: MIN_WIDTH, max: MAX_WIDTH, fallback: DEFAULT_WIDTH,
  });

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

  const edges = useEdges();
  const hasSourceEdge = edges.some((e) => e.source === rfId);
  const hasTextConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-text");
  const hasImageConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-image");
  const connection = useConnection();
  const isConnecting = connection.inProgress && connection.fromNode?.id === rfId;
  const showSourceHandle = showControls || hasSourceEdge || isConnecting;
  const anyConnectionInProgress = connection.inProgress;
  const targetHandleClassName = (active: boolean) => cn(
    edgeHandleClass({ side: "left", visible: showControls || active || anyConnectionInProgress }),
    anyConnectionInProgress && "!pointer-events-auto !z-50",
  );

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAspectPicker, setShowAspectPicker] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const aspectButtonRef = useRef<HTMLButtonElement>(null);

  const allNodes = useBoardStore.getState().nodes;
  const upstreamTextEdge = edges.find((e) => {
    if (e.target !== rfId) return false;
    if (e.targetHandle === "target-text") return true;
    const src = allNodes.find((n) => n.id === e.source);
    return src?.data.type === "text";
  });
  const hasPromptSource = !!upstreamTextEdge;
  const upstreamTextNode = hasPromptSource
    ? allNodes.find((n) => n.id === upstreamTextEdge!.source)
    : null;
  // A Prompt list keeps its text in listItems[] (data.prompt stays empty),
  // so read selected text items from list sources and only fall back to
  // data.prompt for plain text nodes. This is what lets the prompt preview
  // render and the Generate gate pass when a list is connected.
  const upstreamTextPrompts = upstreamTextNode
    ? collectSelectedTextPrompts(upstreamTextNode as { id: string; data: Record<string, unknown> })
    : [];
  const upstreamText = upstreamTextPrompts.join("\n");

  const currentModel = MODEL_OPTIONS.find((m) => m.key === modelKey) ?? MODEL_OPTIONS[0];

  const upstreamImageEdge = edges.find((e) => e.target === rfId && e.targetHandle === "target-image");
  const upstreamImageNode = upstreamImageEdge
    ? allNodes.find((n) => n.id === upstreamImageEdge.source)
    : null;

  const batchMode = (data.batchMode as "zip" | "cross") || "cross";

  const promptCount = (() => {
    if (!upstreamTextNode) return 1;
    const type = upstreamTextNode.data.type || upstreamTextNode.type;
    const isListLike =
      type === "list" ||
      (type === "assistant" && upstreamTextNode.data.assistantExportMode === "list");
    if (isListLike) {
      // Count the actual text prompts the dispatch engine will use so the
      // batch badge matches execution exactly.
      return Math.max(1, upstreamTextPrompts.length);
    }
    return 1;
  })();

  const imageCountUpstream = (() => {
    if (!upstreamImageNode) return 1;
    const items = upstreamImageNode.data.listItems;
    if (Array.isArray(items)) {
      if (Array.isArray(upstreamImageNode.data.listSelectedIndexes) && upstreamImageNode.data.listSelectedIndexes.length > 0) {
        return upstreamImageNode.data.listSelectedIndexes.length;
      }
      return items.length;
    }
    return 1;
  })();

  const combineRefs = data.combineRefs === true;

  const batchTaskCount = promptCount > 1 && imageCountUpstream === 1
    ? promptCount
    : (promptCount === 1 && imageCountUpstream > 1 && combineRefs)
      ? 1
      : batchMode === "cross"
        ? promptCount * imageCountUpstream
        : Math.min(promptCount, imageCountUpstream);

  const toggleBatchModeOrCombineRefs = useCallback(() => {
    if (promptCount > 1 && imageCountUpstream > 1) {
      const nextMode = batchMode === "cross" ? "zip" : "cross";
      useBoardStore.getState().updateNodeData(rfId, { batchMode: nextMode });
      persistNodeData(rfId, { batchMode: nextMode });
    } else if (promptCount === 1 && imageCountUpstream > 1) {
      const nextCombine = !combineRefs;
      useBoardStore.getState().updateNodeData(rfId, { combineRefs: nextCombine });
      persistNodeData(rfId, { combineRefs: nextCombine });
    }
  }, [rfId, promptCount, imageCountUpstream, batchMode, combineRefs]);

  function setPrompt(value: string) {
    useBoardStore.getState().updateNodeData(rfId, { prompt: value });
    persistNodeData(rfId, { prompt: value });
  }
  function setImageCount(delta: number) {
    const next = Math.max(1, Math.min(4, imageCount + delta));
    useBoardStore.getState().updateNodeData(rfId, { imageCount: next });
    persistNodeData(rfId, { imageCount: next });
  }
  function stopNodeAction(event: React.MouseEvent) {
    event.stopPropagation();
  }
  function setAspect(value: AspectOption) {
    const hasMedia = !!(mediaId || mediaIds.length > 0);
    if (isRunning || hasMedia) {
      // Generation in progress or has existing media — queue the change, don't resize yet
      useBoardStore.getState().updateNodeData(rfId, { pendingAspectKey: value });
      persistNodeData(rfId, { pendingAspectKey: value });
    } else {
      // No active generation and no media — apply immediately
      useBoardStore.getState().updateNodeData(rfId, { aspectKey: value, pendingAspectKey: null });
      persistNodeData(rfId, { aspectKey: value, pendingAspectKey: null });
    }
    setShowAspectPicker(false);
  }
  function setModel(key: ActiveImageModelKey) {
    useBoardStore.getState().updateNodeData(rfId, { modelKey: key });
    persistNodeData(rfId, { modelKey: key });
    setShowModelPicker(false);
  }
  function handleGenerateOrCancel() {
    if (isRunning) {
      useGenerationStore.getState().cancelActiveRequest(rfId);
      return;
    }
    const finalPrompt = hasPromptSource ? upstreamText : prompt.trim();
    const hasImageRefs = edges.some((e) => {
      if (e.target !== rfId) return false;
      const src = allNodes.find((n) => n.id === e.source);
      return src && src.data.type !== "text";
    });
    if (!finalPrompt && !hasImageRefs) return;
    useGenerationStore.getState().runNodeGraph(rfId);
  }
  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  const showVariantGrid = false;
  const visibleSlots = 1;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width: nodeWidth, padding: "0 20px 0 20px" }}
    >
      {/* External header */}
      <div className="flex items-center gap-1.5 mb-2 pl-1">
        <ImageUp size={14} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-primary font-medium leading-none">Image Generator</span>
        {shortId && <span className="font-mono text-2xs text-ink-placeholder leading-none">#{shortId}</span>}
      </div>

      {/* Card */}
      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-visible transition-all duration-300 ease-out",
          "border-[3px] border-white/[0.14] shadow-[0_8px_28px_-10px_rgba(0,0,0,0.6)]",
          selected && "ring-2 ring-accent/50",
          isRunning && "ring-2 ring-accent/30",
        )}
        style={{ borderRadius: BORDER_RADIUS, backgroundColor: "#1a1a1a" }}
      >
        {/* Image area */}
        <div
          className="relative overflow-hidden"
          style={{ aspectRatio: ASPECT_CSS[aspectKey], minHeight: 200, borderRadius: BORDER_RADIUS - 3 }}
        >
           {/* Variant grid (multiple results) */}
          {showVariantGrid ? (
            <div
              className={cn(
                "absolute inset-0 grid gap-px bg-black/20",
                visibleSlots === 1 ? "grid-cols-1" : "grid-cols-2",
              )}
            >
              {Array.from({ length: visibleSlots }).map((_, idx) => {
                const slotMediaId = mediaIds[idx] ?? null;
                return (
                  <div
                    key={idx}
                    onDoubleClick={() => {
                      if (slotMediaId) useGenerationStore.getState().openResultViewer(rfId, idx);
                    }}
                    className={cn(
                      "relative min-h-0 min-w-0 overflow-hidden bg-white/[0.04] outline-none",
                      slotMediaId ? "cursor-default" : "cursor-default"
                    )}
                  >
                    {slotMediaId ? (
                      <img
                        src={mediaUrl(slotMediaId)}
                        alt={`generated ${idx + 1}`}
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                        className={cn(
                          "absolute inset-0 size-full object-cover transition-all duration-300",
                          promptFocused && "blur-sm scale-[1.02]",
                        )}
                        onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId, idx)}
                      />
                    ) : (
                      /* Loading slot placeholder */
                      <div className="absolute inset-0 bg-white/[0.05]">
                        {isRunning && (
                          <div className="absolute inset-0 flow-generating-sheen">
                            <ImageUp size={14} className="absolute top-2.5 left-2.5 text-white/30" />
                            <span className="absolute top-2.5 right-2.5 text-[10px] font-semibold font-mono text-white/40">
                              {simulatedProgress}%
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : mediaId ? (
            /* Single image */
            <img
              src={mediaUrl(mediaId)}
              alt="generated"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className={cn(
                "absolute inset-0 size-full object-cover transition-all duration-300",
                promptFocused && "blur-sm scale-[1.02]",
              )}
              onLoad={onImageLoad}
              onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId)}
            />
          ) : (
            /* ── Empty state ───────────────────────────────────────────────
               Visible when node has no image yet and is not running. */
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 select-none">
              <div
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 48, height: 48,
                  backgroundColor: "rgba(124,92,255,0.12)",
                  border: "1px solid rgba(124,92,255,0.25)",
                }}
              >
                <ImageUp size={22} strokeWidth={1.5} style={{ color: "rgba(124,92,255,0.7)" }} />
              </div>
              <p
                className="text-xs text-center leading-relaxed"
                style={{ color: "rgba(255,255,255,0.35)", maxWidth: 160 }}
              >
                Describe your image below and hit generate
              </p>
            </div>
          )}

          {/* ── Google Flow Shifting Fluid Organic Loading Overlay ───────────────────────────────────────
               Organic metallic liquid blobs moving dynamically, mix-blended with blur and dither. */}
          {isRunning && !showVariantGrid && (
            <div
              className="absolute inset-0 z-[4] overflow-hidden"
              style={{ borderRadius: BORDER_RADIUS - 3 }}
            >
              <FluidGradientStyles speedModifier={1} />
              <div className="absolute inset-0 bg-[#16171a]" />
              
              {/* Màng lỏng chuyển động dập dềnh */}
              <div className="absolute inset-0 filter blur-[60px] mix-blend-screen opacity-[0.95]">
                <div className="absolute -bottom-[20%] -left-[15%] w-[75%] h-[75%] rounded-full bg-gradient-to-tr from-[#8a8c94] to-[#3a3c40] animate-fluid-1 opacity-80" />
                <div className="absolute -top-[15%] -right-[10%] w-[65%] h-[65%] rounded-full bg-[#404248] animate-fluid-2 opacity-60" />
                <div className="absolute top-[25%] left-[20%] w-[55%] h-[55%] rounded-full bg-[#242528] animate-fluid-3 opacity-50" />
              </div>

              <div className="absolute inset-0 bg-[radial-gradient(#27272a_0.6px,transparent_1px)] bg-[length:2.5px_2.5px] opacity-[0.22] pointer-events-none mix-blend-overlay" />
              <div className="absolute inset-0 bg-gradient-to-tr from-black/20 via-transparent to-black/10 pointer-events-none" />

              {/* Overlays tối giản góc trên */}
              <div className="absolute inset-0 flex flex-col justify-between p-4 pointer-events-none">
                <div className="flex items-start justify-between">
                  <div className="text-white/60 p-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-[18px] w-[18px] opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>

                  <div className="text-white/60 font-sans text-xs font-semibold tracking-tight opacity-95">
                    {Math.floor(simulatedProgress)}%
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Dark overlay when editing prompt */}
          {promptFocused && (
            <div className="absolute inset-0 bg-black/50 transition-opacity duration-300 z-[5]" />
          )}

          {/* ── Expand / quick-view button ───────────────────────────────────
              Top-left on hover when an image exists. Opens ResultViewer. */}
          {mediaId && showControls && !showVariantGrid && !promptFocused && (
            <button
              type="button"
              onMouseDown={stopNodeAction}
              onDoubleClick={stopNodeAction}
              onClick={() => useGenerationStore.getState().openResultViewer(rfId)}
              className="nodrag nowheel absolute top-2.5 left-2.5 z-[6] flex items-center justify-center rounded-full transition-all duration-150 hover:scale-110"
              style={{
                width: 28, height: 28,
                backgroundColor: "rgba(0,0,0,0.55)",
                backdropFilter: "blur(6px)",
                border: "1px solid rgba(255,255,255,0.15)",
                color: "rgba(255,255,255,0.85)",
              }}
              title="View fullscreen"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}

          {/* Size badge — top-right */}
          {imgSize && showControls && mediaId && !showVariantGrid && (
            <div
              className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-2xs font-medium text-ink-primary z-10"
              style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
            >
              {imgSize.w} × {imgSize.h}
            </div>
          )}

          {/* Bottom overlay: prompt textarea + toolbar */}
          <div className={cn("absolute bottom-0 left-0 right-0 z-30", "transition-all duration-300 ease-out")}>
            {/* Prompt */}
            <div 
              className={cn("px-4 pb-1 transition-all duration-300 ease-out", promptFocused ? "pt-4" : "pt-2")}
              style={{ 
                paddingBottom: (promptCount > 1 && imageCountUpstream > 1) ? 40 : 4
              }}
            >
              <textarea
                value={hasPromptSource ? upstreamText : prompt}
                onChange={(e) => setPrompt(e.target.value)}
                spellCheck={false}
                placeholder="Describe the image you want to generate..."
                disabled={hasPromptSource}
                rows={promptFocused ? 6 : 1}
                onFocus={() => setPromptFocused(true)}
                onBlur={() => setPromptFocused(false)}
                onMouseDown={stopNodeAction}
                onClick={stopNodeAction}
                onDoubleClick={stopNodeAction}
                className="nodrag nowheel img-gen-prompt w-full bg-transparent text-sm text-white placeholder:text-white/70 resize-none outline-none border-0 leading-relaxed"
              />
            </div>

            {/* Persistent Batch Mode Toggle Badge when List is connected - absolute & static to prevent animation stutter */}
            {(promptCount > 1 || imageCountUpstream > 1) && (
              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={toggleBatchModeOrCombineRefs}
                title={
                  promptCount > 1 && imageCountUpstream > 1
                    ? `Batch Mode: ${batchMode === "cross" ? "Cross Product (Generate every prompt for every image)" : "Zip Paired (Generate prompts matched with images by index)"}`
                    : combineRefs
                      ? "Combined Mode: Send all images in list as references for 1 image"
                      : `Batch Mode: Generate ${batchTaskCount} images (one per image in list)`
                }
                className="nodrag nowheel absolute left-4 bottom-3 z-40 flex h-7 items-center justify-center rounded-full border border-white/[0.08] px-2.5 py-1 text-2xs font-bold text-white/80 transition-all whitespace-nowrap hover:bg-white/[0.08] hover:text-white cursor-pointer"
                style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
              >
                {combineRefs && promptCount === 1 && imageCountUpstream > 1 ? "combined" : `x${batchTaskCount}`}
              </button>
            )}

            {/* Toolbar - slides in on hover */}
            <div
              className={cn(
                "nodrag nowheel flex items-center gap-1.5 pb-3 pt-0 pr-3",
                "transition-all duration-300 ease-out",
                showControls
                  ? "max-h-[48px] opacity-100 translate-y-0"
                  : "max-h-0 opacity-0 translate-y-1 overflow-hidden",
              )}
              style={{ paddingLeft: (promptCount > 1 || imageCountUpstream > 1) ? 64 : 12 }}
            >
              {/* Standard Image count stepper (Only shown when not in batch list mode) */}
              {!(promptCount > 1 || imageCountUpstream > 1) && (
                <CountStepper
                  value={imageCount}
                  min={1}
                  max={4}
                  onChange={(next) => setImageCount(next - imageCount)}
                />
              )}

              {/* Model picker */}
              <div className="relative">
                <button
                  ref={modelButtonRef}
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => { setShowModelPicker(!showModelPicker); setShowAspectPicker(false); }}
                  className="nodrag nowheel flex h-7 items-center gap-1 rounded-full border border-white/[0.06] px-2.5 py-1 text-2xs font-medium text-white/78 hover:bg-white/[0.07] hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
                >
                  {currentModel.label} <DropdownCaret className="text-white/50" />
                </button>
                <PickerDropdown
                  anchorRef={modelButtonRef}
                  isOpen={showModelPicker}
                  onClose={() => setShowModelPicker(false)}
                  items={MODEL_OPTIONS.map((option) => ({ key: option.key, label: option.label }))}
                  activeKey={modelKey}
                  onPick={(key) => setModel(key as ActiveImageModelKey)}
                  minWidth={156}
                  matchAnchorWidth={false}
                />
              </div>

              {/* Aspect picker */}
              <div className="relative">
                <button
                  ref={aspectButtonRef}
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => { setShowAspectPicker(!showAspectPicker); setShowModelPicker(false); }}
                  className="nodrag nowheel flex h-7 items-center gap-1 rounded-full border border-white/[0.06] px-2.5 py-1 text-2xs font-medium text-white/78 hover:bg-white/[0.07] hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
                >
                  {pendingAspectKey && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Will apply after generation" />
                  )}
                  {displayAspectKey} <DropdownCaret className="text-white/50" />
                </button>
                <PickerDropdown
                  anchorRef={aspectButtonRef}
                  isOpen={showAspectPicker}
                  onClose={() => setShowAspectPicker(false)}
                  items={ASPECT_OPTIONS.map((option) => ({ key: option, label: option }))}
                  activeKey={displayAspectKey}
                  onPick={(key) => setAspect(key as AspectOption)}
                  minWidth={86}
                  matchAnchorWidth={false}
                />
              </div>

              <div className="flex-1" />

              {/* Settings */}
              <button type="button" onMouseDown={stopNodeAction} onDoubleClick={stopNodeAction} className="nodrag nowheel p-1.5 rounded-full text-white/70 hover:text-white transition-colors" style={{ backgroundColor: "rgba(255,255,255,0.1)" }}>
                <Settings size={13} strokeWidth={2} />
              </button>

              {/* Generate */}
              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={handleGenerateOrCancel}
                className={cn(
                  "nodrag nowheel p-2 rounded-full border transition-all duration-150 shadow-sm cursor-pointer",
                  isRunning
                    ? hovered
                      ? "bg-rose-600 border-rose-600 text-white hover:bg-rose-700 hover:border-rose-700"
                      : "bg-[#8f939b]/20 border-[#8f939b]/25 text-white/70"
                    : "bg-[#f3f4f6] border-[#f3f4f6] text-[#1c2027] hover:bg-white hover:border-white hover:scale-[1.06]"
                )}
                title={isRunning ? (hovered ? "Cancel generation" : "Running") : (mediaId || mediaIds.length > 0 ? "Regenerate" : "Generate")}
              >
                {isRunning ? (
                  hovered ? <X size={14} strokeWidth={2} /> : <RefreshCw size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  mediaId || mediaIds.length > 0 ? <RefreshCw size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} fill="currentColor" />
                )}
              </button>
            </div>
          </div>
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

      {/* Source handle — right side */}
      <Handle type="source" position={Position.Right} id="source"
        className={edgeHandleClass({ side: "right", visible: showSourceHandle })}
        style={{ top: EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET }}
      >
        <HandleBadge icon={ImageUp} active={hasSourceEdge} label="Generated Image" side="right" />
      </Handle>

      {/* Target handle (text input) — left side */}
      <Handle type="target" position={Position.Left} id="target-text" style={{ bottom: 54, top: "auto" }}
        className={targetHandleClassName(hasTextConnection)}
      >
        <HandleBadge icon={Type} active={hasTextConnection} label="Prompt" side="left" />
      </Handle>

      {/* Target handle (image input) — left side */}
      <Handle type="target" position={Position.Left} id="target-image" style={{ bottom: 14, top: "auto" }}
        className={targetHandleClassName(hasImageConnection)}
      >
        <HandleBadge icon={ImageUp} active={hasImageConnection} label="Reference Image" side="left" />
      </Handle>
    </div>
  );
}
