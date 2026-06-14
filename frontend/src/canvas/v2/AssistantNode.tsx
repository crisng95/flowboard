import { useCallback, useMemo, useRef, useState } from "react";
import { Handle, Position, useConnection, useEdges, NodeToolbar, type NodeProps, useReactFlow } from "@xyflow/react";
import {
  Bot,
  ChevronDown,
  Copy,
  FileText,
  Image as ImageIcon,
  Play,
  RefreshCw,
  Sparkles,
  Type,
  Video,
  X,
  type LucideIcon,
  Trash2,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { type FlowNode, useBoardStore } from "../../store/board";
import {
  type AssistantExportMode,
  collectSelectedListMediaItems,
  collectSelectedTextPrompts,
  resolveAssistantExportMode,
  useGenerationStore,
} from "../../store/generation";
import { persistNodeData } from "./shared/persistNodeData";
import { HandleBadge } from "./shared/HandleBadge";
import { edgeHandleClass, EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET } from "./shared/edgeHandle";
import { PickerDropdown } from "./shared/PickerDropdown";

const MIN_WIDTH = 420;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 560;
const MIN_HEIGHT = 360;
const MAX_HEIGHT = 1000;
const DEFAULT_HEIGHT = 480;
const BORDER_RADIUS = 16;
const HOVER_LEAVE_DELAY = 200;
const INPUT_HANDLE_BOTTOM_TEXT = 94;
const INPUT_HANDLE_BOTTOM_IMAGE = 54;
const INPUT_HANDLE_BOTTOM_VIDEO = 14;
const PROMPT_PLACEHOLDER =
  "Ask the assistant to analyze, rewrite, or synthesize from your upstream text and media.";
const FOOTER_RUNNING_LABEL = "Generating...";
const EXPORT_DROPDOWN_MIN_WIDTH = 228;

type AssistantTab = "result" | "prompt";

type SummaryPill = {
  id: string;
  label: string;
  tone?: "default" | "muted";
  icon?: "image" | "video";
};

type AssistantAttachment = {
  id: string;
  kind: "image" | "video";
  title: string;
};

const ASSISTANT_TABS: Array<{ id: AssistantTab; label: string; icon: LucideIcon }> = [
  { id: "prompt", label: "Prompt", icon: Sparkles },
  { id: "result", label: "Result", icon: FileText },
];

const ASSISTANT_EMPTY_STATE: Record<AssistantTab, { title: string; body?: string }> = {
  prompt: { title: "" },
  result: {
    title: "No result yet",
    body: "Run the node to capture a reusable text output.",
  },
};

interface DualResizeHandleProps {
  forceVisible?: boolean;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  currentWidth: number;
  currentHeight: number;
  onResize: (width: number, height: number) => void;
  onResizeEnd: (width: number, height: number) => void;
}

function DualResizeHandle({
  minWidth,
  maxWidth,
  minHeight,
  maxHeight,
  currentWidth,
  currentHeight,
  onResize,
  onResizeEnd,
  forceVisible = false,
}: DualResizeHandleProps) {
  const { getZoom } = useReactFlow();
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: currentWidth,
      startHeight: currentHeight,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveSize({ w: Math.round(currentWidth), h: Math.round(currentHeight) });
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const deltaY = (e.clientY - s.startY) / s.zoom;
    const nextW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    const nextH = Math.max(minHeight, Math.min(maxHeight, s.startHeight + deltaY));
    onResize(nextW, nextH);
    setLiveSize({ w: Math.round(nextW), h: Math.round(nextH) });
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const deltaY = (e.clientY - s.startY) / s.zoom;
    const finalW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    const finalH = Math.max(minHeight, Math.min(maxHeight, s.startHeight + deltaY));
    dragStateRef.current = null;
    setIsDragging(false);
    setLiveSize(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    onResizeEnd(finalW, finalH);
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center group",
        isDragging ? "[&_path]:opacity-100" : forceVisible && isHovered ? "[&_path]:opacity-50" : "[&_path]:opacity-0",
        "[&_path]:transition-opacity [&_path]:duration-100",
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        bottom: 0,
        right: 0,
        width: 64,
        height: 64,
        transform: "translate(50%, 50%)",
        background: "transparent",
        touchAction: "none",
      }}
    >
      {liveSize !== null && (
        <div
          className="absolute pointer-events-none rounded-full border text-[10px] font-mono leading-none px-2 py-1 tabular-nums animate-fade-in"
          style={{
            bottom: "calc(100% + 6px)",
            right: "50%",
            transform: "translateX(50%)",
            backgroundColor: "#1c1f27",
            borderColor: "rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.9)",
            whiteSpace: "nowrap",
            zIndex: 100,
          }}
          aria-live="polite"
        >
          {liveSize.w} × {liveSize.h}px
        </div>
      )}
      <svg
        viewBox="0 0 48 48"
        style={{
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          overflow: "visible",
        }}
      >
        <path
          d="M 36 22 A 14 14 0 0 1 22 36"
          stroke="rgba(0,0,0,0)"
          strokeWidth="18"
          strokeLinecap="round"
          fill="none"
          pointerEvents="stroke"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <path
          d="M 36 22 A 14 14 0 0 1 22 36"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

function formatCountLabel(count: number, singular: string, plural: string) {
  return `${count} ${count > 1 ? plural : singular}`;
}

function getExportModeLabel(mode: AssistantExportMode) {
  return mode === "list" ? "Export as list" : "Export as text";
}

function buildContextBadges(
  attachmentSummary: AssistantAttachment[],
): SummaryPill[] {
  const pills: SummaryPill[] = [{ id: "model", label: "Flow Gemini" }];
  if (attachmentSummary.length === 0) return pills;

  const imageCount = attachmentSummary.filter((item) => item.kind === "image").length;
  const videoCount = attachmentSummary.filter((item) => item.kind === "video").length;

  if (imageCount > 0) {
    pills.push({
      id: "attachments-image",
      label: formatCountLabel(imageCount, "image", "images"),
      tone: "muted",
      icon: "image",
    });
  }

  if (videoCount > 0) {
    pills.push({
      id: "attachments-video",
      label: formatCountLabel(videoCount, "video", "videos"),
      tone: "muted",
      icon: "video",
    });
  }

  return pills;
}

function SummaryIcon({ icon }: { icon: SummaryPill["icon"] }) {
  if (icon === "image") return <ImageIcon size={11} strokeWidth={1.8} />;
  if (icon === "video") return <Video size={11} strokeWidth={1.8} />;
  return null;
}

function AssistantToolbarButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group/assistant-tab relative inline-flex h-8 w-8 items-center justify-center rounded-full transition",
        active
          ? "bg-white/[0.08] text-white"
          : "text-white/52 hover:bg-white/[0.04] hover:text-white/82",
      )}
    >
      <Icon size={14} strokeWidth={1.9} />
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 rounded-xl border border-white/[0.08] bg-[#1f1f1f] px-3 py-2 text-xs font-medium text-white shadow-xl whitespace-nowrap opacity-0 scale-95 transition-all duration-200 ease-out group-hover/assistant-tab:opacity-100 group-hover/assistant-tab:scale-100">
        {label}
      </span>
    </button>
  );
}

function AssistantTopBar({
  activeTab,
  hasOutput,
  onCopyOutput,
  onTabChange,
}: {
  activeTab: AssistantTab;
  hasOutput: boolean;
  onCopyOutput: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onTabChange: (tab: AssistantTab) => void;
}) {
  return (
    <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 pt-2.5">
      <div
        className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-black/30 p-1 backdrop-blur-sm"
        role="tablist"
        aria-label="Assistant view"
      >
        {ASSISTANT_TABS.map((tab) => (
          <AssistantToolbarButton
            key={tab.id}
            active={activeTab === tab.id}
            icon={tab.icon}
            label={tab.label}
            onClick={() => onTabChange(tab.id)}
          />
        ))}
      </div>

      {hasOutput ? (
        <button
          type="button"
          onClick={onCopyOutput}
          aria-label="Copy output"
          title="Copy output"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/[0.06] hover:text-white"
        >
          <Copy size={14} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}

function AssistantResultPanel({
  error,
  hasOutput,
  output,
}: {
  error?: string;
  hasOutput: boolean;
  output: string;
}) {
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm leading-relaxed text-rose-200">
        {error}
      </div>
    );
  }

  if (hasOutput) {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-white/88">
        {output}
      </pre>
    );
  }

  return (
    <div className="flex h-full min-h-[220px] max-w-[420px] flex-col justify-center">
      <div className="text-base font-medium text-white/72">{ASSISTANT_EMPTY_STATE.result.title}</div>
      <div className="mt-2 text-sm leading-7 text-white/38">{ASSISTANT_EMPTY_STATE.result.body}</div>
    </div>
  );
}

export function AssistantNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const status = ((data.assistantStatus as string | undefined) ?? (data.status as string | undefined) ?? "idle") as
    | "idle"
    | "queued"
    | "running"
    | "done"
    | "error";
  const isRunning = status === "queued" || status === "running";
  const shortId = data.shortId as string | undefined;
  const width = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;
  const height = (data.nodeHeight as number | undefined) ?? DEFAULT_HEIGHT;
  const prompt = (data.assistantPrompt as string | undefined) ?? "";
  const output = (data.assistantOutput as string | undefined) ?? "";
  const error = (data.assistantError as string | undefined) ?? (data.error as string | undefined);
  const hasOutput = output.trim().length > 0;
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const [showExportDropdown, setShowExportDropdown] = useState(false);

  const [activeTab, setActiveTab] = useState<AssistantTab>(() => (hasOutput ? "result" : "prompt"));
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

  const edges = useEdges();
  const connection = useConnection();
  const allNodes = useBoardStore((s) => s.nodes);

  const attachmentSummary = useMemo<AssistantAttachment[]>(() => {
    const attachmentEdges = edges.filter(
      (edge) =>
        edge.target === rfId &&
        (edge.targetHandle === "target-image" || edge.targetHandle === "target-video"),
    );
    return attachmentEdges.flatMap((edge) => {
      const node = allNodes.find((entry) => entry.id === edge.source);
      if (!node) return [];
      if (node.data.type === "list") {
        return collectSelectedListMediaItems(node as { id: string; data: Record<string, unknown> }).map((item, index) => ({
          id: `${edge.id}-${index}`,
          kind: item.kind === "video" ? "video" : "image",
          title: String(item.title ?? item.kind ?? "Attachment"),
        }));
      }
      const kind = node.data.type === "video" ? "video" : "image";
      const variants = Array.isArray(node.data.mediaIds)
        ? node.data.mediaIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [node.data.mediaId].filter((value): value is string => typeof value === "string" && value.length > 0);
      return (variants.length > 0 ? variants : [node.data.mediaId]).flatMap((_, index) => ({
        id: `${edge.id}-${index}`,
        kind,
        title: `${String(node.data.title ?? (kind === "video" ? "Video" : "Image"))} ${variants.length > 1 ? index + 1 : ""}`.trim(),
      }));
    });
  }, [allNodes, edges, rfId]);

  const contextBadges = useMemo(() => buildContextBadges(attachmentSummary), [attachmentSummary]);
  const resolvedExportMode = useMemo<AssistantExportMode>(
    () => resolveAssistantExportMode({ id: rfId, data }, { nodes: allNodes, edges }),
    [allNodes, data, edges, rfId],
  );

  const promptCount = useMemo(() => {
    const textEdges = edges.filter((edge) => edge.target === rfId && edge.targetHandle === "target-text");
    let count = 1;
    for (const edge of textEdges) {
      const node = allNodes.find((entry) => entry.id === edge.source);
      if (!node) continue;
      const prompts = collectSelectedTextPrompts(node as { id: string; data: Record<string, unknown> });
      const type = node.data.type || node.type;
      const isListLike =
        type === "list" ||
        (type === "assistant" && node.data.assistantExportMode === "list");
      if (isListLike && prompts.length > 1) {
        count = Math.max(count, prompts.length);
      }
    }
    return count;
  }, [allNodes, edges, rfId]);

  const hasSourceEdge = edges.some((edge) => edge.source === rfId);
  const hasTargetTextEdge = edges.some((edge) => edge.target === rfId && edge.targetHandle === "target-text");
  const hasTargetImageEdge = edges.some((edge) => edge.target === rfId && edge.targetHandle === "target-image");
  const hasTargetVideoEdge = edges.some((edge) => edge.target === rfId && edge.targetHandle === "target-video");
  const isConnectingFrom = connection.inProgress && connection.fromNode?.id === rfId;
  const showSourceHandle = showControls || hasSourceEdge || isConnectingFrom;
  const anyConnectionInProgress = connection.inProgress;
  const targetHandleClassName = (active: boolean) => cn(
    edgeHandleClass({ side: "left", visible: showControls || active || anyConnectionInProgress }),
    anyConnectionInProgress && "!pointer-events-auto !z-50",
  );

  const onResize = useCallback(
    (nextW: number, nextH: number) => {
      useBoardStore.getState().updateNodeData(rfId, { nodeWidth: nextW, nodeHeight: nextH });
    },
    [rfId],
  );

  const onResizeEnd = useCallback(
    (nextW: number, nextH: number) => {
      const clampedW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(nextW)));
      const clampedH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(nextH)));
      persistNodeData(rfId, { nodeWidth: clampedW, nodeHeight: clampedH });
    },
    [rfId],
  );

  function persistDelta(delta: Record<string, unknown>) {
    useBoardStore.getState().updateNodeData(rfId, delta);
    persistNodeData(rfId, delta);
  }

  function setPrompt(value: string) {
    persistDelta({ assistantPrompt: value });
  }

  function setExportMode(mode: AssistantExportMode) {
    persistDelta({ assistantExportMode: mode });
    setShowExportDropdown(false);
  }

  function handleRunOrCancel() {
    if (isRunning) {
      useGenerationStore.getState().cancelActiveRequest(rfId);
    } else {
      useGenerationStore.getState().runNodeGraph(rfId);
    }
  }

  function handleCopyOutput(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!hasOutput) return;
    void navigator.clipboard.writeText(output);
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans"
      style={{ width, padding: "0 20px 0 20px" }}
    >
      <div className="mb-2 flex items-center gap-1.5 pl-1">
        <Bot size={14} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs font-medium leading-none text-ink-primary">{data.title || "Assistant"}</span>
        {shortId && <span className="font-mono text-2xs leading-none text-ink-placeholder">#{shortId}</span>}
      </div>

      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-visible transition-all duration-300 ease-out",
          "border-[3px] border-white/[0.14] shadow-[0_8px_28px_-10px_rgba(0,0,0,0.6)]",
          selected && "ring-2 ring-accent/50",
          isRunning && "ring-2 ring-accent/30",
        )}
        style={{
          borderRadius: BORDER_RADIUS,
          backgroundColor: "#1a1a1a",
          height: height ? `${height}px` : undefined,
        }}
      >
        {/* Floating Quick Action Overlay */}
        <NodeToolbar position={Position.Top} offset={12} isVisible={showControls}>
          <div 
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
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
              onClick={handleRunOrCancel}
              title={isRunning ? "Cancel Generation" : "Run Assistant"}
              className="nodrag nowheel w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/[0.08] cursor-pointer text-white/70 hover:text-white"
            >
              {isRunning ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} fill="currentColor" />}
            </button>
            <span className="h-4 w-px bg-white/10 mx-0.5" />
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

        <AssistantTopBar
          activeTab={activeTab}
          hasOutput={hasOutput}
          onCopyOutput={handleCopyOutput}
          onTabChange={setActiveTab}
        />

        <div className="flex h-full flex-col px-5 pb-4 pt-14">
          <div className="flex flex-wrap gap-2 pb-2">
            {contextBadges.map((pill) => (
              <div
                key={pill.id}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-none select-none",
                  pill.tone === "muted"
                    ? "border-white/[0.08] bg-white/[0.03] text-white/60"
                    : "border-white/10 bg-white/[0.04] text-white/78",
                )}
              >
                {pill.icon ? <SummaryIcon icon={pill.icon} /> : null}
                <span>{pill.label}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-1 flex-col rounded-2xl border border-white/[0.08] bg-black/20 overflow-hidden">
            <div className="flex flex-1 flex-col px-4 py-4 overflow-hidden">
              {activeTab === "prompt" ? (
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  spellCheck={false}
                  className="nodrag nowheel img-gen-prompt flex-1 resize-none border-0 bg-transparent text-sm leading-relaxed text-white/88 outline-none placeholder:text-white/28 overflow-y-auto"
                  placeholder={PROMPT_PLACEHOLDER}
                />
              ) : (
                <div className="magnific-dropdown-scroll flex-1 overflow-y-auto pr-1 nodrag nowheel">
                  <AssistantResultPanel error={error} hasOutput={hasOutput} output={output} />
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="relative flex items-center gap-2">
              <button
                ref={exportButtonRef}
                type="button"
                disabled={isRunning}
                onClick={() => setShowExportDropdown((open) => !open)}
                className={cn(
                  "inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition",
                  isRunning
                    ? "cursor-default border-white/[0.06] bg-white/[0.04] text-white/42"
                    : "border-white/[0.08] bg-white/[0.06] text-white/72 hover:bg-white/[0.1] hover:text-white",
                )}
                title={getExportModeLabel(resolvedExportMode)}
              >
                <span>{isRunning ? FOOTER_RUNNING_LABEL : getExportModeLabel(resolvedExportMode)}</span>
                {!isRunning ? <ChevronDown size={12} className="text-white/40" /> : null}
              </button>
              <PickerDropdown
                anchorRef={exportButtonRef}
                isOpen={showExportDropdown && !isRunning}
                onClose={() => setShowExportDropdown(false)}
                items={[
                  {
                    key: "list",
                    label: "Export As List",
                    hint: "Export results as list items",
                  },
                  {
                    key: "text",
                    label: "Export As Text",
                    hint: "Export results as plain text",
                  },
                ]}
                activeKey={resolvedExportMode}
                onPick={(key) => setExportMode(key as AssistantExportMode)}
                minWidth={EXPORT_DROPDOWN_MIN_WIDTH}
                matchAnchorWidth={false}
              />
              {promptCount > 1 && (
                <div
                  title={`Batch Mode: Running ${promptCount} prompt tasks`}
                  className="flex h-7 items-center justify-center rounded-full border border-white/[0.08] px-2.5 py-1 text-2xs font-bold text-white/80 select-none"
                  style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
                >
                  x{promptCount}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleRunOrCancel}
              className={cn(
                "nodrag nowheel inline-flex h-10 w-10 items-center justify-center rounded-full transition cursor-pointer",
                isRunning
                  ? hovered
                    ? "bg-rose-600 text-white"
                    : "bg-white/[0.08] text-white/70"
                  : "bg-white text-black hover:bg-white/90",
              )}
              title={isRunning ? (hovered ? "Cancel generation" : "Running") : "Run assistant"}
            >
              {isRunning ? (
                hovered ? <X size={16} strokeWidth={1.8} /> : <RefreshCw size={16} strokeWidth={1.8} className="animate-spin" />
              ) : (
                <Play size={16} strokeWidth={1.8} fill="currentColor" />
              )}
            </button>
          </div>
        </div>

        <DualResizeHandle
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          minHeight={MIN_HEIGHT}
          maxHeight={MAX_HEIGHT}
          currentWidth={width}
          currentHeight={height}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          forceVisible={!!selected}
        />

      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="source"
        style={{ top: EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET }}
        className={edgeHandleClass({ side: "right", visible: showSourceHandle })}
      >
        <HandleBadge icon={Type} active={hasSourceEdge} label="Assistant output" side="right" />
      </Handle>
      <Handle
        type="target"
        position={Position.Left}
        id="target-text"
        style={{ bottom: INPUT_HANDLE_BOTTOM_TEXT, top: "auto" }}
        className={targetHandleClassName(hasTargetTextEdge)}
      >
        <HandleBadge icon={Type} active={hasTargetTextEdge} label="Prompt context" side="left" />
      </Handle>
      <Handle
        type="target"
        position={Position.Left}
        id="target-image"
        style={{ bottom: INPUT_HANDLE_BOTTOM_IMAGE, top: "auto" }}
        className={targetHandleClassName(hasTargetImageEdge)}
      >
        <HandleBadge icon={ImageIcon} active={hasTargetImageEdge} label="Image context" side="left" />
      </Handle>
      <Handle
        type="target"
        position={Position.Left}
        id="target-video"
        style={{ bottom: INPUT_HANDLE_BOTTOM_VIDEO, top: "auto" }}
        className={targetHandleClassName(hasTargetVideoEdge)}
      >
        <HandleBadge icon={Video} active={hasTargetVideoEdge} label="Video context" side="left" />
      </Handle>

    </div>
  );
}
