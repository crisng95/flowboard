import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import {
  AudioLines,
  ImageUp,
  Play,
  RefreshCw,
  Type,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { type FlowNode, useBoardStore } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import {
  OMNI_FLASH_CREDIT_COST,
  type OmniFlashDuration,
  type VideoModelFamily,
  type VideoQuality,
} from "../../store/settings";
import { persistNodeData } from "./shared/persistNodeData";
import { ResizeHandle } from "./shared/ResizeHandle";
import { HandleBadge } from "./shared/HandleBadge";
import { DropdownCaret } from "./shared/DropdownCaret";
import { PickerDropdown } from "./shared/PickerDropdown";
import { edgeHandleClass, EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET } from "./shared/edgeHandle";
import { mediaUrl } from "./shared/useUploadFlow";
import { useNodeWidth } from "./shared/useNodeWidth";

const MIN_WIDTH = 520;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 620;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;
const TOP_HANDLE_FIRST = EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET;
const TOP_HANDLE_SECOND = EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET + 40;
const TOP_HANDLE_THIRD = EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET + 80;
const TOP_HANDLE_FOURTH = EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET + 120;
const INPUT_HANDLE_BOTTOM_REFERENCES = 22;
const INPUT_HANDLE_BOTTOM_END = 64;
const INPUT_HANDLE_BOTTOM_START = 106;
const INPUT_HANDLE_BOTTOM_TEXT = 148;

type AspectOption = "16:9" | "9:16";
const ASPECT_OPTIONS: AspectOption[] = ["16:9", "9:16"];
const ASPECT_CSS: Record<AspectOption, string> = {
  "16:9": "16 / 9",
  "9:16": "9 / 16",
};
const ASPECT_TO_FLOW: Record<AspectOption, string> = {
  "16:9": "VIDEO_ASPECT_RATIO_LANDSCAPE",
  "9:16": "VIDEO_ASPECT_RATIO_PORTRAIT",
};
const MODEL_OPTIONS: { key: VideoModelFamily; label: string }[] = [
  { key: "veo", label: "Veo" },
  { key: "omni_flash", label: "Omni Flash" },
];
const VEO_OPTIONS: VideoQuality[] = ["lite", "fast", "quality", "lite_relaxed"];
const QUALITY_LABELS: Record<VideoQuality, string> = {
  fast: "Fast",
  lite: "Lite",
  quality: "Quality",
  lite_relaxed: "Lite Relaxed",
};
const DURATION_OPTIONS: OmniFlashDuration[] = [4, 6, 8, 10];
const CAMERA_OPTIONS = [
  {
    key: "static",
    label: "Static",
    instruction:
      "Camera: locked-off static frame, no zoom and no pan. Keep the full subject and any product clearly visible in the frame for the entire clip. Background and crop must not change.",
  },
  {
    key: "dynamic",
    label: "Dynamic",
    instruction:
      "Camera: subtle dolly or pan is allowed if it fits the scene, but subject motion is the main story.",
  },
] as const;
type CameraMode = (typeof CAMERA_OPTIONS)[number]["key"];

export function VideoGeneratorNode(props: NodeProps<FlowNode>) {
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
          const increment = Math.floor(Math.random() * 5) + 1;
          return Math.min(98, prev + increment);
        });
      }, 900);
      return () => clearInterval(interval);
    } else {
      setSimulatedProgress(2);
    }
  }, [isRunning]);

  const prompt = (data.prompt as string | undefined) ?? "";
  const mediaIds = Array.isArray(data.mediaIds)
    ? data.mediaIds.filter((m): m is string => typeof m === "string" && !!m)
    : [];
  const mediaId = mediaIds[0] ?? (data.mediaId as string | undefined);
  const shortId = data.shortId as string | undefined;
  const aspectRatio = ((data.aspectRatio as string | undefined) === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9") as AspectOption;
  const videoModel = ((data.videoModel as VideoModelFamily | undefined) ?? "veo");
  const videoQuality = ((data.videoQuality as VideoQuality | undefined) ?? "fast");
  const omniFlashDuration = ((data.omniFlashDuration as OmniFlashDuration | undefined) ?? 4);
  const soundEnabled = (data.soundEnabled as boolean | undefined) ?? false;
  const cameraMode = ((data.cameraMode as CameraMode | undefined) ?? "static");

  const { width: nodeWidth, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId, data, min: MIN_WIDTH, max: MAX_WIDTH, fallback: DEFAULT_WIDTH,
  });

  const [hovered, setHovered] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [showAspectPicker, setShowAspectPicker] = useState(false);
  const [showCameraPicker, setShowCameraPicker] = useState(false);
  const [videoMeta, setVideoMeta] = useState<{ width: number; height: number; duration: number } | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const aspectButtonRef = useRef<HTMLButtonElement>(null);
  const cameraButtonRef = useRef<HTMLButtonElement>(null);

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

  const edges = useEdges();
  const connection = useConnection();
  const allNodes = useBoardStore((s) => s.nodes);

  const startEdge = edges.find((e) => e.target === rfId && e.targetHandle === "target-start-image");
  const startNode = startEdge ? allNodes.find((n) => n.id === startEdge.source) : undefined;
  const startMediaIds = (Array.isArray(startNode?.data.mediaIds) ? startNode.data.mediaIds : [])
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const startMediaId = typeof startNode?.data.mediaId === "string"
    ? startNode.data.mediaId
    : (startMediaIds[0] ?? undefined);

  const endEdge = edges.find((e) => e.target === rfId && e.targetHandle === "target-end-image");
  const endNode = endEdge ? allNodes.find((n) => n.id === endEdge.source) : undefined;
  const endMediaIds = (Array.isArray(endNode?.data.mediaIds) ? endNode.data.mediaIds : [])
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const endMediaId = typeof endNode?.data.mediaId === "string"
    ? endNode.data.mediaId
    : (endMediaIds[0] ?? undefined);

  const hasTextConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-text");
  const upstreamTextEdge = edges.find((e) => e.target === rfId && e.targetHandle === "target-text");
  const upstreamTextNode = upstreamTextEdge ? allNodes.find((n) => n.id === upstreamTextEdge.source) : null;
  const upstreamText = ((upstreamTextNode?.data.prompt as string) ?? "").trim();

  const batchMode = (data.batchMode as "zip" | "cross") || "cross";

  const promptCount = (() => {
    if (!upstreamTextNode) return 1;
    const items = upstreamTextNode.data.listItems;
    if (Array.isArray(items)) {
      if (upstreamTextNode.data.listSelectionMode && Array.isArray(upstreamTextNode.data.listSelectedIndexes) && upstreamTextNode.data.listSelectedIndexes.length > 0) {
        return upstreamTextNode.data.listSelectedIndexes.length;
      }
      return items.length;
    }
    return 1;
  })();

  const imageCountUpstream = (() => {
    if (!startNode) return 1;
    const items = startNode.data.listItems;
    if (Array.isArray(items)) {
      if (startNode.data.listSelectionMode && Array.isArray(startNode.data.listSelectedIndexes) && startNode.data.listSelectedIndexes.length > 0) {
        return startNode.data.listSelectedIndexes.length;
      }
      return items.length;
    }
    return 1;
  })();

  const batchTaskCount = batchMode === "cross" ? promptCount * imageCountUpstream : Math.min(promptCount, imageCountUpstream);

  const toggleBatchMode = useCallback(() => {
    const nextMode = batchMode === "cross" ? "zip" : "cross";
    persistDelta({ batchMode: nextMode });
  }, [batchMode]);

  useEffect(() => {
    const next: Record<string, unknown> = {};
    if ((data.startImageMediaId as string | undefined) !== startMediaId) {
      next.startImageMediaId = startMediaId ?? null;
    }
    if ((data.endImageMediaId as string | undefined) !== endMediaId) {
      next.endImageMediaId = endMediaId ?? null;
    }
    if (Object.keys(next).length === 0) return;
    useBoardStore.getState().updateNodeData(rfId, next);
    persistNodeData(rfId, next);
  }, [rfId, data.startImageMediaId, data.endImageMediaId, startMediaId, endMediaId]);

  function persistDelta(delta: Record<string, unknown>) {
    useBoardStore.getState().updateNodeData(rfId, delta);
    persistNodeData(rfId, delta);
  }

  function closePickers() {
    setShowModelPicker(false);
    setShowModePicker(false);
    setShowAspectPicker(false);
    setShowCameraPicker(false);
  }

  function setPrompt(value: string) {
    persistDelta({ prompt: value });
  }

  function setModel(next: VideoModelFamily) {
    persistDelta({ videoModel: next });
    setShowModelPicker(false);
  }

  function setAspect(next: AspectOption) {
    persistDelta({ aspectRatio: ASPECT_TO_FLOW[next] });
    setShowAspectPicker(false);
  }

  function setMode(next: VideoQuality | OmniFlashDuration) {
    if (videoModel === "veo") {
      persistDelta({ videoQuality: next as VideoQuality });
    } else {
      persistDelta({ omniFlashDuration: next as OmniFlashDuration });
    }
    setShowModePicker(false);
  }

  function setSound(next: boolean) {
    persistDelta({ soundEnabled: next });
  }

  function setCameraMode(next: CameraMode) {
    persistDelta({ cameraMode: next });
    setShowCameraPicker(false);
  }

  function handleGenerate() {
    const finalPrompt = (hasTextConnection ? upstreamText : prompt).trim();
    if (!finalPrompt || isRunning) return;
    useGenerationStore.getState().runNodeGraph(rfId);
  }

  function stopNodeAction(event: React.MouseEvent) {
    event.stopPropagation();
  }

  function handleClass(role: "source" | "target", active: boolean) {
    return edgeHandleClass({ side: role === "source" ? "right" : "left", visible: active });
  }

  const handleVisible = (role: "source" | "target", handleId?: string) => {
    if (role === "source") {
      const hasEdge = edges.some((e) => e.source === rfId && e.sourceHandle === handleId);
      return showControls || hasEdge || (connection.inProgress && connection.fromNode?.id === rfId);
    }
    const hasEdge = edges.some((e) => e.target === rfId && e.targetHandle === handleId);
    return showControls || hasEdge || connection.inProgress;
  };

  const showVariantGrid = mediaIds.length > 1;
  const visibleSlots = showVariantGrid ? mediaIds.length : 1;
  const currentModel = MODEL_OPTIONS.find((option) => option.key === videoModel) ?? MODEL_OPTIONS[0];
  const modeLabel = videoModel === "veo" ? QUALITY_LABELS[videoQuality] : `${omniFlashDuration}s`;
  const modeMeta = videoModel === "veo" ? "Quality" : null;
  const shouldPreviewPlay = hovered || !!selected;
  const durationLabel = videoMeta
    ? `${Math.floor(videoMeta.duration / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(videoMeta.duration % 60)
        .toString()
        .padStart(2, "0")}`
    : null;

  useEffect(() => {
    const el = previewVideoRef.current;
    if (!el || !mediaId || showVariantGrid) return;
    el.muted = !soundEnabled;
    if (shouldPreviewPlay) {
      const playPromise = el.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
      return;
    }
    el.pause();
    el.currentTime = 0;
  }, [mediaId, showVariantGrid, shouldPreviewPlay, soundEnabled]);

  function handleVideoMetadata(event: React.SyntheticEvent<HTMLVideoElement>) {
    const element = event.currentTarget;
    if (!element.videoWidth || !element.videoHeight) return;
    setVideoMeta({
      width: element.videoWidth,
      height: element.videoHeight,
      duration: Number.isFinite(element.duration) ? element.duration : 0,
    });
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width: nodeWidth, padding: "0 20px 0 20px" }}
    >
      <div className="flex items-center gap-1.5 mb-2 pl-1">
        <Video size={14} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-primary font-medium leading-none">Video Generator</span>
        {shortId && <span className="font-mono text-2xs text-ink-placeholder leading-none">#{shortId}</span>}
      </div>

      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-visible transition-all duration-300 ease-out",
          "border-[3px] border-white/[0.14] shadow-[0_8px_28px_-10px_rgba(0,0,0,0.6)]",
          selected && "ring-2 ring-accent/50",
          isRunning && "ring-2 ring-accent/30 animate-pulse",
        )}
        style={{ borderRadius: BORDER_RADIUS, backgroundColor: "#1a1a1a" }}
      >
        <div
          className="relative overflow-hidden"
          style={{ aspectRatio: ASPECT_CSS[aspectRatio], minHeight: 320, borderRadius: BORDER_RADIUS - 3 }}
        >
          {showVariantGrid ? (
            <div
              className={cn(
                "absolute inset-0 grid gap-px bg-black/20",
                visibleSlots === 1 ? "grid-cols-1" : "grid-cols-2",
              )}
            >
              {mediaIds.map((mid, idx) => (
                <div
                  key={mid}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useGenerationStore.getState().openResultViewer(rfId, idx);
                    }
                  }}
                  onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId, idx)}
                  className="relative min-h-0 min-w-0 overflow-hidden bg-white/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <video
                    src={mediaUrl(mid)}
                    className={cn(
                      "absolute inset-0 size-full object-cover transition-all duration-300",
                      promptFocused && "blur-sm scale-[1.02]",
                    )}
                    muted={!soundEnabled}
                    loop
                    playsInline
                    autoPlay={shouldPreviewPlay}
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                  />
                </div>
              ))}
            </div>
          ) : mediaId ? (
            <video
              ref={previewVideoRef}
              src={mediaUrl(mediaId)}
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
              muted={!soundEnabled}
              loop
              playsInline
              onLoadedMetadata={handleVideoMetadata}
              onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId)}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 select-none">
              <div
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 48,
                  height: 48,
                  backgroundColor: "rgba(124,92,255,0.12)",
                  border: "1px solid rgba(124,92,255,0.25)",
                }}
              >
                <Video size={22} strokeWidth={1.5} style={{ color: "rgba(124,92,255,0.7)" }} />
              </div>
              <p
                className="text-xs text-center leading-relaxed"
                style={{ color: "rgba(255,255,255,0.35)", maxWidth: 220 }}
              >
                Describe your video below and hit generate
              </p>
            </div>
          )}

          {isRunning && !showVariantGrid && (
            <div
              className="absolute inset-0 z-[4] overflow-hidden flow-generating-sheen animate-fade-in"
              style={{ borderRadius: BORDER_RADIUS - 3 }}
            >
              <Video size={16} className="absolute top-3 left-3 text-white/35" />
              <span className="absolute top-3 right-3 text-2xs font-semibold font-mono text-white/45">
                {simulatedProgress}%
              </span>
            </div>
          )}

          {promptFocused && (
            <div className="absolute inset-0 bg-black/50 transition-opacity duration-300 z-[5]" />
          )}

          {mediaId && !showVariantGrid && videoMeta && (
            <div className="absolute top-3 right-3 z-[6] flex items-center gap-1.5">
              <div
                className="rounded-full px-2.5 py-1 text-2xs font-medium text-white/90"
                style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
              >
                {videoMeta.width} x {videoMeta.height}
              </div>
              {durationLabel && (
                <div
                  className="rounded-full px-2.5 py-1 text-2xs font-medium text-white/90"
                  style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
                >
                  {durationLabel}
                </div>
              )}
              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={() => setSound(!soundEnabled)}
                className="nodrag nowheel flex items-center justify-center rounded-full text-white/90 transition-colors hover:text-white"
                style={{
                  width: 26,
                  height: 26,
                  backgroundColor: "rgba(0,0,0,0.5)",
                  backdropFilter: "blur(4px)",
                }}
                title={soundEnabled ? "Mute preview" : "Unmute preview"}
              >
                {soundEnabled ? <Volume2 size={13} strokeWidth={2} /> : <VolumeX size={13} strokeWidth={2} />}
              </button>
            </div>
          )}

          <div className={cn("absolute bottom-0 left-0 right-0 z-10", "transition-all duration-300 ease-out")}>
            <div 
              className={cn("px-4 pb-1 transition-all duration-300 ease-out", promptFocused ? "pt-4" : "pt-2")}
              style={{ 
                paddingBottom: (promptCount > 1 && imageCountUpstream > 1) ? 40 : 4
              }}
            >
              <textarea
                value={hasTextConnection ? upstreamText : prompt}
                onChange={(e) => setPrompt(e.target.value)}
                spellCheck={false}
                placeholder="Describe the video you want to generate..."
                disabled={hasTextConnection}
                rows={promptFocused ? 6 : 1}
                onFocus={() => {
                  closePickers();
                  setPromptFocused(true);
                }}
                onBlur={() => setPromptFocused(false)}
                onMouseDown={stopNodeAction}
                onClick={stopNodeAction}
                onDoubleClick={stopNodeAction}
                className="nodrag nowheel img-gen-prompt w-full bg-transparent text-sm text-white placeholder:text-white/70 resize-none outline-none border-0 leading-relaxed"
              />
            </div>

            {/* Persistent Batch Mode Toggle Badge when List is connected - absolute & static to prevent animation stutter */}
            {promptCount > 1 && imageCountUpstream > 1 && (
              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={toggleBatchMode}
                title={`Batch Mode: ${batchMode === "cross" ? "Cross Product (Generate every prompt for every image)" : "Zip Paired (Generate prompts matched with images by index)"}`}
                className="nodrag nowheel absolute left-4 bottom-3 z-40 flex h-7 items-center justify-center rounded-full border border-white/[0.08] px-2.5 py-1 text-2xs font-bold text-white/80 hover:bg-white/[0.08] hover:text-white transition-all whitespace-nowrap cursor-pointer"
                style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
              >
                x{batchTaskCount}
              </button>
            )}

            <div
              onMouseDown={stopNodeAction}
              onClick={stopNodeAction}
              onDoubleClick={stopNodeAction}
              className={cn(
                "nodrag nowheel flex items-center gap-1.5 pb-3 pt-0 pr-3",
                "transition-all duration-300 ease-out",
                showControls
                  ? "max-h-[48px] opacity-100 translate-y-0"
                  : "max-h-0 opacity-0 translate-y-1 overflow-hidden",
              )}
              style={{ paddingLeft: promptCount > 1 && imageCountUpstream > 1 ? 64 : 12 }}
            >
              <div className="relative">
                <button
                  ref={modelButtonRef}
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => {
                    setShowModelPicker(!showModelPicker);
                    setShowModePicker(false);
                    setShowAspectPicker(false);
                    setShowCameraPicker(false);
                  }}
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
                  activeKey={videoModel}
                  onPick={(key) => setModel(key as VideoModelFamily)}
                  minWidth={132}
                  matchAnchorWidth={false}
                />
              </div>

              <div className="relative">
                <button
                  ref={modeButtonRef}
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => {
                    setShowModePicker(!showModePicker);
                    setShowModelPicker(false);
                    setShowAspectPicker(false);
                    setShowCameraPicker(false);
                  }}
                  className="nodrag nowheel flex h-7 items-center gap-1 rounded-full border border-white/[0.06] px-2.5 py-1 text-2xs font-medium text-white/78 hover:bg-white/[0.07] hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
                >
                  {modeLabel} {modeMeta ? <span className="text-white/45">{modeMeta}</span> : null} <DropdownCaret className="text-white/50" />
                </button>
                <PickerDropdown
                  anchorRef={modeButtonRef}
                  isOpen={showModePicker}
                  onClose={() => setShowModePicker(false)}
                  items={(videoModel === "veo" ? VEO_OPTIONS : DURATION_OPTIONS).map((option) => ({
                    key: String(option),
                    label: videoModel === "veo" ? QUALITY_LABELS[option as VideoQuality] : `${option}s`,
                    hint: videoModel === "veo" ? undefined : `${OMNI_FLASH_CREDIT_COST[option as OmniFlashDuration]} credits`,
                  }))}
                  activeKey={videoModel === "veo" ? videoQuality : String(omniFlashDuration)}
                  onPick={(key) => setMode(videoModel === "veo" ? key as VideoQuality : Number(key) as OmniFlashDuration)}
                  minWidth={120}
                  matchAnchorWidth={false}
                />
              </div>

              <div className="relative">
                <button
                  ref={aspectButtonRef}
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => {
                    setShowAspectPicker(!showAspectPicker);
                    setShowModelPicker(false);
                    setShowModePicker(false);
                    setShowCameraPicker(false);
                  }}
                  className="nodrag nowheel flex h-7 items-center gap-1 rounded-full border border-white/[0.06] px-2.5 py-1 text-2xs font-medium text-white/78 hover:bg-white/[0.07] hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
                >
                  {aspectRatio} <DropdownCaret className="text-white/50" />
                </button>
                <PickerDropdown
                  anchorRef={aspectButtonRef}
                  isOpen={showAspectPicker}
                  onClose={() => setShowAspectPicker(false)}
                  items={ASPECT_OPTIONS.map((option) => ({ key: option, label: option }))}
                  activeKey={aspectRatio}
                  onPick={(key) => setAspect(key as AspectOption)}
                  minWidth={86}
                  matchAnchorWidth={false}
                />
              </div>

              <div className="relative">
                <button
                  ref={cameraButtonRef}
                  onMouseDown={stopNodeAction}
                  onDoubleClick={stopNodeAction}
                  onClick={() => {
                    setShowCameraPicker(!showCameraPicker);
                    setShowModelPicker(false);
                    setShowModePicker(false);
                    setShowAspectPicker(false);
                  }}
                  className="nodrag nowheel flex h-7 items-center gap-1 rounded-full border border-white/[0.06] px-2.5 py-1 text-2xs font-medium text-white/78 hover:bg-white/[0.07] hover:text-white transition-colors whitespace-nowrap"
                  style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
                >
                  {CAMERA_OPTIONS.find((option) => option.key === cameraMode)?.label ?? "Static"} <DropdownCaret className="text-white/50" />
                </button>
                <PickerDropdown
                  anchorRef={cameraButtonRef}
                  isOpen={showCameraPicker}
                  onClose={() => setShowCameraPicker(false)}
                  items={CAMERA_OPTIONS.map((option) => ({
                    key: option.key,
                    label: option.label,
                    hint: option.key === "static" ? "Locks framing and suppresses camera motion." : "Leaves camera motion open in the prompt.",
                  }))}
                  activeKey={cameraMode}
                  onPick={(key) => setCameraMode(key as CameraMode)}
                  estimatedHeight={180}
                />
              </div>

              <div className="flex-1" />

              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={handleGenerate}
                disabled={isRunning}
                className={cn(
                  "p-2 rounded-full border transition-all duration-150 shadow-sm",
                  isRunning
                    ? "bg-[#8f939b] border-[#8f939b] text-white/45 cursor-not-allowed"
                    : "bg-[#f3f4f6] border-[#f3f4f6] text-[#1c2027] hover:bg-white hover:border-white hover:scale-[1.06] cursor-pointer",
                )}
              >
                {mediaId || mediaIds.length > 0 ? <RefreshCw size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} fill="currentColor" />}
              </button>
            </div>
          </div>
        </div>

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

      <Handle
        type="source"
        position={Position.Right}
        id="source-start-image"
        style={{ top: TOP_HANDLE_FIRST }}
        className={handleClass("source", handleVisible("source", "source-start-image"))}
      >
        <HandleBadge icon={ImageUp} active={edges.some((e) => e.source === rfId && e.sourceHandle === "source-start-image")} label="Start Image" side="right" />
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        id="source-end-image"
        style={{ top: TOP_HANDLE_SECOND }}
        className={handleClass("source", handleVisible("source", "source-end-image"))}
      >
        <HandleBadge icon={ImageUp} active={edges.some((e) => e.source === rfId && e.sourceHandle === "source-end-image")} label="End Image" side="right" />
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        id="source-video"
        style={{ top: TOP_HANDLE_THIRD }}
        className={handleClass("source", handleVisible("source", "source-video"))}
      >
        <HandleBadge icon={Video} active={edges.some((e) => e.source === rfId && e.sourceHandle === "source-video")} label="Generated Video" side="right" />
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        id="source-audio"
        style={{ top: TOP_HANDLE_FOURTH }}
        className={handleClass("source", handleVisible("source", "source-audio"))}
      >
        <HandleBadge icon={AudioLines} active={edges.some((e) => e.source === rfId && e.sourceHandle === "source-audio")} label="Audio" side="right" />
      </Handle>

      <Handle
        type="target"
        position={Position.Left}
        id="target-text"
        style={{ bottom: INPUT_HANDLE_BOTTOM_TEXT, top: "auto" }}
        className={handleClass("target", handleVisible("target", "target-text"))}
      >
        <HandleBadge icon={Type} active={edges.some((e) => e.target === rfId && e.targetHandle === "target-text")} label="Prompt" side="left" />
      </Handle>
      <Handle
        type="target"
        position={Position.Left}
        id="target-start-image"
        style={{ bottom: INPUT_HANDLE_BOTTOM_START, top: "auto" }}
        className={handleClass("target", handleVisible("target", "target-start-image"))}
      >
        <HandleBadge icon={ImageUp} active={edges.some((e) => e.target === rfId && e.targetHandle === "target-start-image")} label="Start Image" side="left" />
      </Handle>
      <Handle
        type="target"
        position={Position.Left}
        id="target-end-image"
        style={{ bottom: INPUT_HANDLE_BOTTOM_END, top: "auto" }}
        className={handleClass("target", handleVisible("target", "target-end-image"))}
      >
        <HandleBadge icon={ImageUp} active={edges.some((e) => e.target === rfId && e.targetHandle === "target-end-image")} label="End Image" side="left" />
      </Handle>
      <Handle
        type="target"
        position={Position.Left}
        id="target-references"
        style={{ bottom: INPUT_HANDLE_BOTTOM_REFERENCES, top: "auto" }}
        className={handleClass("target", handleVisible("target", "target-references"))}
      >
        <HandleBadge icon={ImageUp} active={edges.some((e) => e.target === rfId && e.targetHandle === "target-references")} label="References" side="left" />
      </Handle>
    </div>
  );
}
