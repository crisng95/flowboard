import { useCallback, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import { ImageUp, Minus, Play, Plus, RefreshCw, Settings, Type } from "lucide-react";

import { type FlowNode } from "../../store/board";
import { useBoardStore } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { mediaUrl } from "./shared/useUploadFlow";
import { persistNodeData } from "./shared/persistNodeData";
import { ResizeHandle } from "./shared/ResizeHandle";
import { useNodeWidth } from "./shared/useNodeWidth";

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
const ASPECT_TO_FLOW: Record<AspectOption, string> = {
  "1:1": "IMAGE_ASPECT_RATIO_SQUARE",
  "3:4": "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR",
  "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE",
  "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
  "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT",
};

type ModelOption = { key: string; label: string };
const MODEL_OPTIONS: ModelOption[] = [
  { key: "NANO_BANANA_PRO", label: "Nano Banana Pro" },
  { key: "NANO_BANANA_2", label: "Nano Banana 2" },
];

export function ImageGeneratorNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const mediaId = data.mediaId as string | undefined;
  const prompt = (data.prompt as string | undefined) ?? "";
  const imageCount = (data.imageCount as number | undefined) ?? 1;
  const aspectKey = (data.aspectKey as AspectOption | undefined) ?? "1:1";
  const modelKey = (data.modelKey as string | undefined) ?? "NANO_BANANA_PRO";
  const shortId = data.shortId as string | undefined;
  const status = data.status as string | undefined;

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
  const hasTargetEdge = edges.some((e) => e.target === rfId);
  const connection = useConnection();
  const isConnecting = connection.inProgress && connection.fromNode?.id === rfId;
  const showSourceHandle = showControls || hasSourceEdge || isConnecting;
  const anyConnectionInProgress = connection.inProgress;
  const showTargetHandles = showControls || hasTargetEdge || anyConnectionInProgress;

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAspectPicker, setShowAspectPicker] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

    const upstreamTextEdge = edges.find(
    (e) => e.target === rfId && e.targetHandle === "target-text"
  );
  const hasTextConnection = !!upstreamTextEdge;
  const upstreamTextNode = hasTextConnection
    ? useBoardStore.getState().nodes.find((n) => n.id === upstreamTextEdge!.source)
    : null;
  const upstreamText = ((upstreamTextNode?.data.prompt as string) ?? "").trim();

  const currentModel = MODEL_OPTIONS.find((m) => m.key === modelKey) ?? MODEL_OPTIONS[0];

  function setPrompt(value: string) {
    useBoardStore.getState().updateNodeData(rfId, { prompt: value });
    persistNodeData(rfId, { prompt: value });
  }
  function setImageCount(delta: number) {
    const next = Math.max(1, Math.min(8, imageCount + delta));
    useBoardStore.getState().updateNodeData(rfId, { imageCount: next });
    persistNodeData(rfId, { imageCount: next });
  }
  function setAspect(value: AspectOption) {
    useBoardStore.getState().updateNodeData(rfId, { aspectKey: value });
    persistNodeData(rfId, { aspectKey: value });
    setShowAspectPicker(false);
  }
  function setModel(key: string) {
    useBoardStore.getState().updateNodeData(rfId, { modelKey: key });
    persistNodeData(rfId, { modelKey: key });
    setShowModelPicker(false);
  }
  function handleGenerate() {
    // Use local prompt, or fall back to upstream text node prompt
    const finalPrompt = hasTextConnection ? upstreamText : prompt.trim();
    if (!finalPrompt) return;
    useGenerationStore.getState().dispatchGeneration(rfId, {
      prompt: finalPrompt,
      aspectRatio: ASPECT_TO_FLOW[aspectKey],
      kind: "image",
      variantCount: imageCount,
    });
  }
  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  const isRunning = status === "running" || status === "queued";

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
          "border-[3px] border-white/[0.14] shadow-lg",
          selected && "ring-2 ring-accent/50",
          isRunning && "ring-2 ring-accent/30 animate-pulse",
        )}
        style={{ borderRadius: BORDER_RADIUS, backgroundColor: "#1a1a1a" }}
      >
        {/* Image area */}
        <div className="relative overflow-hidden" style={{ aspectRatio: ASPECT_CSS[aspectKey], minHeight: 200, borderRadius: BORDER_RADIUS - 3 }}>
          {mediaId && (
            <img
              src={mediaUrl(mediaId)}
              alt="generated"
              className={cn("absolute inset-0 size-full object-cover transition-all duration-300", promptFocused && "blur-sm scale-[1.02]")}
              onLoad={onImageLoad}
              onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId)}
            />
          )}

          {/* Dark overlay when editing prompt */}
          {promptFocused && (
            <div className="absolute inset-0 bg-black/50 transition-opacity duration-300 z-[5]" />
          )}

          {/* Size badge */}
          {imgSize && showControls && mediaId && (
            <div
              className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-2xs font-medium text-ink-primary z-10"
              style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
            >
              {imgSize.w} × {imgSize.h}
            </div>
          )}

          {/* Bottom overlay: prompt + toolbar ON the image */}
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 z-10",
              "transition-all duration-300 ease-out",
            )}
          >
            {/* Prompt - always visible */}
            <div className={cn("px-4 pb-1 transition-all duration-300 ease-out", promptFocused ? "pt-4" : "pt-6")}>
              <textarea
                value={hasTextConnection ? upstreamText : prompt}
                onChange={(e) => setPrompt(e.target.value)}
                spellCheck={false}
                placeholder="Describe the image you want to generate..."
                disabled={hasTextConnection}
                rows={promptFocused ? 6 : 2}
                onFocus={() => setPromptFocused(true)}
                onBlur={() => setPromptFocused(false)}
                className="img-gen-prompt w-full bg-transparent text-sm text-white placeholder:text-white/70 resize-none outline-none border-0 leading-relaxed"
              />
            </div>

            {/* Toolbar - slides in on hover */}
            <div
              className={cn(
                "flex items-center gap-1.5 px-3 pb-3 pt-0",
                "transition-all duration-300 ease-out",
                showControls
                  ? "max-h-[48px] opacity-100 translate-y-0"
                  : "max-h-0 opacity-0 translate-y-1 overflow-hidden",
              )}
            >
              {/* Image count */}
              <div className="flex items-center gap-0.5 rounded-full px-1.5 py-1" style={{ backgroundColor: "rgba(255,255,255,0.1)" }}>
                <button onClick={() => setImageCount(-1)} className="p-0.5 text-white/70 hover:text-white transition-colors"><Minus size={12} strokeWidth={2} /></button>
                <span className="text-2xs font-medium text-white min-w-[20px] text-center">x{imageCount}</span>
                <button onClick={() => setImageCount(1)} className="p-0.5 text-white/70 hover:text-white transition-colors"><Plus size={12} strokeWidth={2} /></button>
              </div>

              {/* Model picker */}
              <div className="relative">
                <button
                  onClick={() => { setShowModelPicker(!showModelPicker); setShowAspectPicker(false); }}
                  className="flex items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium text-white/80 hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {currentModel.label} <span className="text-[8px] opacity-50">▾</span>
                </button>
                {showModelPicker && (
                  <div className="absolute bottom-full left-0 mb-1 rounded-lg p-1 shadow-xl border border-white/[0.08] z-50" style={{ backgroundColor: "#2a2a2a" }}>
                    {MODEL_OPTIONS.map((m) => (
                      <button key={m.key} onClick={() => setModel(m.key)} className={cn("block w-full text-left px-3 py-1.5 rounded-md text-2xs whitespace-nowrap transition-colors", m.key === modelKey ? "text-accent bg-accent/10" : "text-white/80 hover:text-white hover:bg-white/[0.06]")}>{m.label}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Aspect picker */}
              <div className="relative">
                <button
                  onClick={() => { setShowAspectPicker(!showAspectPicker); setShowModelPicker(false); }}
                  className="flex items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium text-white/80 hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
                >
                  {aspectKey} <span className="text-[8px] opacity-50">▾</span>
                </button>
                {showAspectPicker && (
                  <div className="absolute bottom-full left-0 mb-1 rounded-lg p-1 shadow-xl border border-white/[0.08] z-50" style={{ backgroundColor: "#2a2a2a" }}>
                    {ASPECT_OPTIONS.map((a) => (
                      <button key={a} onClick={() => setAspect(a)} className={cn("block w-full text-left px-3 py-1.5 rounded-md text-2xs whitespace-nowrap transition-colors", a === aspectKey ? "text-accent bg-accent/10" : "text-white/80 hover:text-white hover:bg-white/[0.06]")}>{a}</button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1" />

              {/* Settings */}
              <button className="p-1.5 rounded-full text-white/70 hover:text-white transition-colors" style={{ backgroundColor: "rgba(255,255,255,0.1)" }}>
                <Settings size={13} strokeWidth={2} />
              </button>

              {/* Generate */}
              <button
                onClick={handleGenerate}
                disabled={isRunning}
                className={cn("p-2 rounded-full transition-all duration-150", isRunning ? "bg-accent/30 text-accent/50 cursor-not-allowed" : "bg-accent/30 text-accent hover:bg-accent/40 cursor-pointer")}
              >
                {mediaId ? <RefreshCw size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} fill="currentColor" />}
              </button>
            </div>
          </div>
        </div>

        {/* Resize handle - relative to card, visible when selected */}
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
      <Handle type="source" position={Position.Right} id="source"
        className={cn("!absolute !-right-0 !top-[48px] !h-7 !w-7 !border-0 !bg-transparent", "transition-opacity duration-300 ease-out", showSourceHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none")}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150" style={{ backgroundColor: "#2b2b2b", borderColor: hasSourceEdge ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)", color: "rgba(255,255,255,0.7)" }}>
          <ImageUp size={11} strokeWidth={2} />
        </div>
      </Handle>

      {/* Target handle (image input) - left side */}
      <Handle type="target" position={Position.Left} id="target-image" style={{ bottom: 14, top: "auto" }}
        className={cn("!absolute !-left-0 !h-7 !w-7 !border-0 !bg-transparent", "transition-opacity duration-300 ease-out", showTargetHandles ? "!opacity-100" : "!opacity-0 !pointer-events-none")}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150" style={{ backgroundColor: "#2b2b2b", borderColor: hasTargetEdge ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)", color: "rgba(255,255,255,0.7)" }}>
          <ImageUp size={11} strokeWidth={2} />
        </div>
      </Handle>

      {/* Target handle (text input) - left side */}
      <Handle type="target" position={Position.Left} id="target-text" style={{ bottom: 54, top: "auto" }}
        className={cn("!absolute !-left-0 !h-7 !w-7 !border-0 !bg-transparent", "transition-opacity duration-300 ease-out", showTargetHandles ? "!opacity-100" : "!opacity-0 !pointer-events-none")}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150" style={{ backgroundColor: "#2b2b2b", borderColor: hasTargetEdge ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)", color: "rgba(255,255,255,0.7)" }}>
          <Type size={11} strokeWidth={2} />
        </div>
      </Handle>
    </div>
  );
}