/**
 * VariantNode — Magnific AI Variations #2
 *
 * Backend node type: `variant`. Generates image variations along configurable
 * axes: Age, Custom prompt, Demographics, Expressions, Storyboard, Reframe.
 *
 * Architecture invariants preserved from V2 bug-fix cycle:
 *   • targetHandleClassName with anyConnectionInProgress → pointer-events-auto
 *   • Handles placed outside the Card body as siblings of the 20px-padded wrapper
 *   • Shared floating dropdown behavior aligned with other V2 nodes
 *   • DOM order: target-text before target-image
 */
import { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { type NodeProps, Handle, Position, useEdges, useConnection } from "@xyflow/react";
import { Copy, Layers, Palette, Play, RefreshCw, Type, X } from "lucide-react";

import { useBoardStore, type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { SettingsDrawer } from "./shared/SettingsDrawer";
import { SettingsButton } from "./shared/SettingsButton";
import { TextAreaField } from "./shared/SettingsFields";
import { HandleBadge } from "./shared/HandleBadge";
import { DropdownCaret } from "./shared/DropdownCaret";
import { PickerDropdown } from "./shared/PickerDropdown";
import { edgeHandleClass, EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET } from "./shared/edgeHandle";
import { persistNodeData } from "./shared/persistNodeData";
import { mediaUrl } from "./shared/useUploadFlow";
import { ResizeHandle } from "./shared/ResizeHandle";

/* ═══════════════════════════════════════════════════════════════════════════
   LAYOUT CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */
const MIN_WIDTH = 420;
const MAX_WIDTH = 750;
const DEFAULT_WIDTH = 460;

/* ═══════════════════════════════════════════════════════════════════════════
   DICTIONARIES — Magnific AI Variations #2 spec
   ═══════════════════════════════════════════════════════════════════════════ */

// A. Modes
type VariantMode = "Age" | "Custom" | "Demographics" | "Expressions" | "Storyboard" | "Reframe";
const MODE_OPTIONS: VariantMode[] = ["Age", "Custom", "Demographics", "Expressions", "Storyboard", "Reframe"];

// B. Aspect Ratio (8 options)
const ASPECT_OPTIONS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] as const;
// C. Resolution (2 options)
const RESOLUTION_OPTIONS = ["2K", "4K"] as const;

// D. Grid (12 options)
const GRID_OPTIONS = ["1x2", "2x1", "1x3", "3x1", "1x4", "4x1", "2x2", "2x3", "3x2", "2x4", "4x2", "3x3"] as const;

// E. Ethnicities (26 options for Demographics)
const ETHNICITY_OPTIONS = [
  "African", "Arab", "Caribbean", "Central Asian", "Chinese", "East African",
  "East Asian", "European", "Hispanic/Latino", "Indian", "Indigenous/Native American",
  "Japanese", "Korean", "Mediterranean", "Mestizo", "Middle Eastern", "Multiracial",
  "North African", "Pacific Islander", "Persian", "Scandinavian", "Slavic",
  "South Asian", "Southeast Asian", "Sub-Saharan African", "West African",
] as const;

// F. Genders (2 options for Demographics)
const GENDER_OPTIONS = ["Female", "Male"] as const;

// G. Camera Angles (16 options for Reframe)
const CAMERA_ANGLE_OPTIONS = [
  "Aerial", "High Angle", "Low Angle", "Eye Level", "3/4 View", "Profile",
  "Closeup", "Med. Closeup", "Extreme Closeup",
  "Long Shot", "Ext. Long Shot", "Medium Long", "Wide",
  "Back View", "OTS", "POV",
] as const;

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG INTERFACE
   ═══════════════════════════════════════════════════════════════════════════ */
export interface VariantConfig {
  mode: VariantMode;
  aspect_ratio: string;
  resolution: string;
  grid: string;
  split_images: boolean;
  custom_prompt: string;
  ethnicities: string[];
  genders: ("Female" | "Male")[];
  reframe_angles: string[];
}

const DEFAULT_CONFIG: VariantConfig = {
  mode: "Custom",
  aspect_ratio: "16:9",
  resolution: "4K",
  grid: "3x3",
  split_images: true,
  custom_prompt: "",
  ethnicities: [...ETHNICITY_OPTIONS],
  genders: ["Female", "Male"],
  reframe_angles: [],
};

/* Grid string → variant count */
function gridToCount(grid: string): number {
  const parts = grid.split("x");
  if (parts.length === 2) {
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (!isNaN(a) && !isNaN(b)) return a * b;
  }
  return 9; // fallback 3x3
}

function gridToLayout(grid: string): { rows: number; cols: number } {
  const parts = grid.split("x");
  if (parts.length === 2) {
    const rows = parseInt(parts[0], 10);
    const cols = parseInt(parts[1], 10);
    if (!isNaN(rows) && !isNaN(cols) && rows > 0 && cols > 0) return { rows, cols };
  }
  return { rows: 3, cols: 3 };
}

function aspectStringToRatio(value: string | undefined): number {
  const [w, h] = String(value ?? "16:9").split(":").map((part) => Number(part));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 16 / 9;
  return w / h;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL DROPDOWN — supports both single-select and multi-select
   ═══════════════════════════════════════════════════════════════════════════ */
interface PortalDropdownProps {
  buttonRef: React.RefObject<HTMLButtonElement>;
  open: boolean;
  setOpen: (val: boolean) => void;
  options: readonly string[];
  value: string | string[];
  onChange: (val: any) => void;
  disabledOptions?: string[];
  disabled?: boolean;
  multiSelect?: boolean;
  label?: string; // optional label prefix for the button
}

function PortalDropdown({
  buttonRef,
  open,
  setOpen,
  options,
  value,
  onChange,
  disabledOptions = [],
  disabled = false,
  multiSelect = false,
  label,
}: PortalDropdownProps) {
  let displayLabel: string;
  if (multiSelect) {
    const arr = Array.isArray(value) ? value : [];
    displayLabel = arr.length > 0 ? `${arr.length} Selected` : "None";
  } else {
    displayLabel = typeof value === "string" ? value : String(value);
  }
  if (label) displayLabel = `${label} ${displayLabel}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(!open)}
        className={cn(
          "nodrag nowheel h-7 px-2.5 rounded-full flex items-center justify-between gap-1.5 text-2xs font-medium border border-white/[0.06] transition-all duration-150 cursor-pointer select-none backdrop-blur-md",
          disabled
            ? "text-white/30 cursor-not-allowed opacity-40"
            : "text-white/78 hover:text-white hover:border-white/14 hover:bg-white/[0.07]",
        )}
        style={{ backgroundColor: "rgba(28, 32, 39, 0.78)", backdropFilter: "blur(12px) saturate(1.15)" }}
      >
        <span className="truncate max-w-[100px]">{displayLabel}</span>
        <DropdownCaret open={open} className="text-white/55" />
      </button>

      <PickerDropdown
        anchorRef={buttonRef}
        isOpen={open && !disabled}
        onClose={() => setOpen(false)}
        items={options.map((opt) => ({
          key: opt,
          label: opt,
          disabled: disabledOptions.includes(opt),
          badge: disabledOptions.includes(opt) ? "Soon" : undefined,
        }))}
        activeKey={typeof value === "string" ? value : undefined}
        activeKeys={Array.isArray(value) ? value : undefined}
        multiSelect={multiSelect}
        onPick={(opt) => {
          if (multiSelect) {
            const arr = Array.isArray(value) ? value : [];
            const next = arr.includes(opt) ? arr.filter((v) => v !== opt) : [...arr, opt];
            onChange(next);
            return;
          }
          onChange(opt);
          setOpen(false);
        }}
        minWidth={multiSelect ? 148 : label === undefined && options.every((opt) => opt.length <= 4) ? 86 : 120}
        matchAnchorWidth={false}
        estimatedHeight={280}
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   CUSTOM RESIZE HANDLE
   ═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   VARIANT NODE COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */
export function VariantNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const isProcessing = data.status === "queued" || data.status === "running";

  const [simulatedProgress, setSimulatedProgress] = useState(2);
  useEffect(() => {
    if (isProcessing) {
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
  }, [isProcessing]);

  const mediaIds = (data.mediaIds as (string | null)[] | undefined) ?? [];
  const slotErrors = (data.slotErrors as (string | null)[] | undefined) ?? [];
  const hasFilled = mediaIds.some(Boolean);

  function stopNodeAction(event: React.MouseEvent) {
    event.stopPropagation();
  }

  const config: VariantConfig = {
    ...DEFAULT_CONFIG,
    ...((data.variant_config as Partial<VariantConfig>) ?? {}),
  };

  const [hovered, setHovered] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runInFlight = useRef(false);
  const [imageRatios, setImageRatios] = useState<Record<number, number>>({});

  const onMouseEnter = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
  }, []);

  const onMouseLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHovered(false), 200);
  }, []);

  const showControls = hovered || !!selected;

  const [width, setWidth] = useState((data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH);

  const recordImageRatio = useCallback((idx: number, event: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (!naturalWidth || !naturalHeight) return;
    const ratio = naturalWidth / naturalHeight;
    setImageRatios((prev) => {
      if (Math.abs((prev[idx] ?? 0) - ratio) < 0.001) return prev;
      return { ...prev, [idx]: ratio };
    });
  }, []);

  const openVariantViewer = (event: React.MouseEvent, idx: number, mediaId?: string | null) => {
    event.stopPropagation();
    if (!mediaId) return;
    useGenerationStore.getState().openResultViewer(rfId, idx);
  };

  /* ── Portal dropdown state: 7 dropdowns total ─────────────────────────── */
  // Row 1: Mode, Aspect, Resolution, Grid
  const [showMode, setShowMode] = useState(false);
  const [showAspect, setShowAspect] = useState(false);
  const [showRes, setShowRes] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  // Row 2 dynamic: Ethnicity, Gender, Camera Angles
  const [showEthnicity, setShowEthnicity] = useState(false);
  const [showGender, setShowGender] = useState(false);
  const [showAngles, setShowAngles] = useState(false);

  // Trigger button refs
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const aspectBtnRef = useRef<HTMLButtonElement>(null);
  const resBtnRef = useRef<HTMLButtonElement>(null);
  const gridBtnRef = useRef<HTMLButtonElement>(null);
  const ethnicityBtnRef = useRef<HTMLButtonElement>(null);
  const genderBtnRef = useRef<HTMLButtonElement>(null);
  const anglesBtnRef = useRef<HTMLButtonElement>(null);

  /* ── Resize handlers ──────────────────────────────────────────────────── */
  const onResize = useCallback(
    (nextW: number) => {
      setWidth(nextW);
      useBoardStore.getState().updateNodeData(rfId, { nodeWidth: nextW });
    },
    [rfId],
  );

  const onResizeEnd = useCallback(
    (nextW: number) => {
      const clampedW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(nextW)));
      setWidth(clampedW);
      persistNodeData(rfId, { nodeWidth: clampedW });
    },
    [rfId],
  );

  /* ── Config persistence ───────────────────────────────────────────────── */
  const updateConfig = (patch: Partial<VariantConfig>) => {
    const nextConfig = { ...config, ...patch };
    persistNodeData(rfId, { variant_config: nextConfig });
  };

  const variantCount = gridToCount(config.grid);
  const gridLayout = useMemo(() => gridToLayout(config.grid), [config.grid]);
  const displayAspectRatio = useMemo(() => {
    const fallback = aspectStringToRatio(config.aspect_ratio);
    const filledRatios = mediaIds
      .map((mid, idx) => (mid ? imageRatios[idx] : undefined))
      .filter((ratio): ratio is number => typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0);
    if (filledRatios.length === 0) return fallback;
    if (variantCount === 1) return filledRatios[0];
    const averageTileRatio = filledRatios.reduce((sum, ratio) => sum + ratio, 0) / filledRatios.length;
    return Math.max(0.2, Math.min(5, (gridLayout.cols * averageTileRatio) / gridLayout.rows));
  }, [config.aspect_ratio, gridLayout.cols, gridLayout.rows, imageRatios, mediaIds, variantCount]);

  /* ── Real-time edge state via ReactFlow native hooks (0ms delay) ─────── */
  const edges = useEdges();
  const connection = useConnection();

  const hasTextConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-text");
  const hasImageConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-image");
  const hasSourceEdge = edges.some((e) => e.source === rfId);

  const anyConnectionInProgress = connection.inProgress;
  const targetHandleClassName = (active: boolean) => cn(
    edgeHandleClass({ side: "left", visible: showControls || active || anyConnectionInProgress }),
    anyConnectionInProgress && "!pointer-events-auto !z-50",
  );

  const allNodes = useBoardStore.getState().nodes;
  const upstreamTextEdge = edges.find((e) => {
    if (e.target !== rfId) return false;
    if (e.targetHandle === "target-text") return true;
    const src = allNodes.find((n) => n.id === e.source);
    return src?.type === "text" || src?.data?.type === "text";
  });

  const upstreamTextNode = upstreamTextEdge
    ? allNodes.find((n) => n.id === upstreamTextEdge.source)
    : null;
  const upstreamText = ((upstreamTextNode?.data?.prompt as string) ?? "").trim();

  /* ── Run handler ──────────────────────────────────────────────────────── */
  const handleRunOrCancel = async () => {
    if (isProcessing) {
      useGenerationStore.getState().cancelActiveRequest(rfId);
      return;
    }
    if (runInFlight.current) return;
    runInFlight.current = true;
    try {
      console.log("Running variant graph:", config);
      await useGenerationStore.getState().runNodeGraph(rfId);
    } catch (err) {
      console.error("Failed to run variant generation:", err);
    } finally {
      runInFlight.current = false;
    }
  };

  const isConnectingFrom = connection.inProgress && connection.fromNode?.id === rfId;
  const showSourceHandle = showControls || hasSourceEdge || isConnectingFrom;

  /* ── Dynamic UI: textarea visibility ──────────────────────────────────── */
  const showTextarea = config.mode === "Custom" || config.mode === "Storyboard";
  const textareaPlaceholder = config.mode === "Storyboard"
    ? "Describe the storyboard..."
    : "e.g., hair color, lighting, tell a story, show different seasons...";

  /* ── Dynamic UI: toolbar height — generous ceiling for flex-wrap rows ── */
  const toolbarMaxH = showControls ? "max-h-[120px]" : "max-h-0";

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans animate-fade-in"
      style={{ width, padding: "0 20px 0 20px" }}
    >
      {/* External header */}
      <div className="flex items-center gap-1.5 mb-2 pl-1 select-none">
        <Copy size={12} strokeWidth={1.5} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-primary font-medium leading-none">{data.title || `Variant`}</span>
        {data.shortId && <span className="font-mono text-2xs text-ink-placeholder leading-none">#{data.shortId}</span>}
      </div>

      {/* Main Card Body */}
      <div
        data-selected={selected || undefined}
        className={cn(
          "relative overflow-visible transition-all duration-300 ease-out",
          "border-[3px] border-white/[0.14] shadow-[0_8px_28px_-10px_rgba(0,0,0,0.6)]",
          selected && "ring-2 ring-accent/50",
          isProcessing && "ring-2 ring-accent/30 animate-pulse",
        )}
        style={{ borderRadius: 16, backgroundColor: "#1a1a1a" }}
      >
        {/* Viewport content layout container */}
        <div
          className="relative overflow-hidden w-full"
          style={{
            aspectRatio: String(displayAspectRatio),
            minHeight: hasFilled ? undefined : 240,
            borderRadius: "13px",
          }}
        >
          {/* Main Content Area */}
          {hasFilled || isProcessing ? (
            /* Variant grid or single image */
            <div className="absolute inset-0 size-full">
              {variantCount === 1 ? (
                /* Single image */
                mediaIds[0] ? (
                  <div
                    onDoubleClick={(event) => openVariantViewer(event, 0, mediaIds[0])}
                    className="absolute inset-0 size-full overflow-hidden bg-white/[0.04] outline-none"
                  >
                    <img
                      src={mediaUrl(mediaIds[0])}
                      alt="variant 1"
                      className={cn(
                        "absolute inset-0 w-full h-full object-contain transition-all duration-300 rounded-[13px]",
                        promptFocused && "blur-sm scale-[1.02]",
                      )}
                      onLoad={(event) => recordImageRatio(0, event)}
                      draggable={false}
                      onDragStart={(e) => e.preventDefault()}
                    />
                  </div>
                ) : (
                  /* Loading/Shimmer slot placeholder */
                  <div className="absolute inset-0 bg-white/[0.05] flow-generating-sheen animate-fade-in" onDoubleClick={(event) => event.stopPropagation()}>
                    {isProcessing && (
                      <>
                        <Copy size={16} className="absolute top-3 left-3 text-white/35" />
                        <span className="absolute top-3 right-3 text-2xs font-semibold font-mono text-white/45">
                          {simulatedProgress}%
                        </span>
                      </>
                    )}
                  </div>
                )
              ) : (
                /* Grid of multiple variants */
                <div
                  className={cn(
                    "absolute inset-0 grid gap-px bg-black/20",
                  )}
                  style={{
                    gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${gridLayout.rows}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: variantCount }).map((_, i) => {
                    const mid = mediaIds[i];
                    const err = slotErrors[i];
                    return (
                      <div
                        key={i}
                        onDoubleClick={(event) => openVariantViewer(event, i, mid)}
                        className={cn(
                          "relative min-h-0 min-w-0 overflow-hidden bg-white/[0.04] outline-none"
                        )}
                      >
                        {mid ? (
                          <img
                            src={mediaUrl(mid)}
                            alt={`variant ${i + 1}`}
                            className={cn(
                              "absolute inset-0 w-full h-full object-contain transition-all duration-300",
                              promptFocused && "blur-sm scale-[1.02]",
                            )}
                            onLoad={(event) => recordImageRatio(i, event)}
                            draggable={false}
                            onDragStart={(e) => e.preventDefault()}
                          />
                        ) : err ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                            <span className="text-[9px] text-red-400">failed</span>
                          </div>
                        ) : (
                          /* Loading or Empty slot placeholder */
                          <div className="absolute inset-0 bg-white/[0.05] flow-generating-sheen" onDoubleClick={(event) => event.stopPropagation()}>
                            {isProcessing && (
                              <>
                                <Copy size={13} className="absolute top-2 left-2 text-white/30" />
                                <span className="absolute top-2 right-2 text-[9px] font-semibold font-mono text-white/40">
                                  {simulatedProgress}%
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Empty state placeholder */
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 select-none"
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <div
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 48,
                  height: 48,
                  backgroundColor: "rgba(124,92,255,0.12)",
                  border: "1px solid rgba(124,92,255,0.25)",
                }}
              >
                <Copy size={22} strokeWidth={1.5} style={{ color: "rgba(124,92,255,0.7)" }} />
              </div>
              <p
                className="text-xs text-center leading-relaxed font-normal"
                style={{ color: "rgba(255,255,255,0.35)", maxWidth: 160 }}
              >
                Describe the variations below and hit generate
              </p>
            </div>
          )}

          {/* Dark overlay when editing prompt */}
          {promptFocused && (
            <div className="absolute inset-0 bg-black/50 transition-opacity duration-300 z-[5]" />
          )}

          {/* Bottom overlay: prompt textarea + toolbar */}
          <div className="absolute bottom-0 left-0 right-0 z-10">
            {/* Prompt Textarea — only visible for Custom / Storyboard modes */}
            {showTextarea && (
              <div className={cn("px-4 pb-1 transition-all duration-300 ease-out", promptFocused ? "pt-4" : "pt-2")}>
                <textarea
                  value={hasTextConnection ? upstreamText : config.custom_prompt}
                  onChange={(e) => updateConfig({ custom_prompt: e.target.value })}
                  spellCheck={false}
                  placeholder={textareaPlaceholder}
                  disabled={hasTextConnection}
                  rows={promptFocused ? 6 : 1}
                  onFocus={() => setPromptFocused(true)}
                  onBlur={() => setPromptFocused(false)}
                  className="nodrag nowheel img-gen-prompt w-full bg-transparent text-sm text-white placeholder:text-white/70 resize-none outline-none border-0 leading-relaxed disabled:opacity-75"
                  onMouseDown={(e) => e.stopPropagation()}
                />
              </div>
            )}

            {/* Sliding Toolbar Panel (Revealed on Hover/Selected) */}
            <div
              className={cn(
                "relative flex flex-col gap-1.5 px-3 pb-2 pt-0",
                "transition-all duration-300 ease-out",
                showControls
                  ? `${toolbarMaxH} opacity-100 translate-y-0`
                  : "max-h-0 opacity-0 translate-y-1 overflow-hidden pointer-events-none"
              )}
            >
              {/* Row 1: Mode · Aspect · Resolution · Grid (always visible) */}
              <div className="flex flex-wrap gap-1.5 items-center pr-24">
                <PortalDropdown
                  buttonRef={modeBtnRef}
                  open={showMode}
                  setOpen={setShowMode}
                  options={MODE_OPTIONS}
                  value={config.mode}
                  onChange={(val: string) => updateConfig({ mode: val as VariantMode })}
                  disabledOptions={["Age", "Demographics", "Expressions", "Reframe"]}
                />
                <PortalDropdown
                  buttonRef={aspectBtnRef}
                  open={showAspect}
                  setOpen={setShowAspect}
                  options={ASPECT_OPTIONS}
                  value={config.aspect_ratio}
                  onChange={(val: string) => updateConfig({ aspect_ratio: val })}
                />
                <PortalDropdown
                  buttonRef={resBtnRef}
                  open={showRes}
                  setOpen={setShowRes}
                  options={RESOLUTION_OPTIONS}
                  value={config.resolution}
                  onChange={(val: string) => updateConfig({ resolution: val })}
                  disabled={true}
                />
                <PortalDropdown
                  buttonRef={gridBtnRef}
                  open={showGrid}
                  setOpen={setShowGrid}
                  options={GRID_OPTIONS}
                  value={config.grid}
                  onChange={(val: string) => updateConfig({ grid: val })}
                />
              </div>

              {/* Row 2: Dynamic controls per mode + Split toggle */}
              <div className="flex flex-wrap gap-1.5 items-center pr-24">
                {/* Demographics: Ethnicity + Gender multi-select */}
                {config.mode === "Demographics" && (
                  <>
                    <PortalDropdown
                      buttonRef={ethnicityBtnRef}
                      open={showEthnicity}
                      setOpen={setShowEthnicity}
                      options={ETHNICITY_OPTIONS}
                      value={config.ethnicities}
                      onChange={(val: string[]) => updateConfig({ ethnicities: val })}
                      multiSelect
                    />
                    <PortalDropdown
                      buttonRef={genderBtnRef}
                      open={showGender}
                      setOpen={setShowGender}
                      options={GENDER_OPTIONS}
                      value={config.genders}
                      onChange={(val: string[]) => updateConfig({ genders: val as ("Female" | "Male")[] })}
                      multiSelect
                    />
                  </>
                )}

                {/* Reframe: Camera Angles multi-select */}
                {config.mode === "Reframe" && (
                  <PortalDropdown
                    buttonRef={anglesBtnRef}
                    open={showAngles}
                    setOpen={setShowAngles}
                    options={CAMERA_ANGLE_OPTIONS}
                    value={config.reframe_angles}
                    onChange={(val: string[]) => updateConfig({ reframe_angles: val })}
                    multiSelect
                  />
                )}

                {/* Split Images Toggle — always visible in Row 2 */}
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => updateConfig({ split_images: !config.split_images })}
                  className="nodrag nowheel flex items-center gap-2 cursor-pointer select-none h-7 px-3 rounded-full bg-white/[0.04] border border-white/5 shrink-0"
                >
                  <div
                    className={cn(
                      "w-7 h-4 rounded-full p-0.5 transition-colors duration-200 ease-in-out",
                      config.split_images ? "bg-accent" : "bg-white/10",
                    )}
                  >
                    <div
                      className={cn(
                        "w-3 h-3 rounded-full bg-white transition-transform duration-200 ease-in-out",
                        config.split_images && "transform translate-x-3",
                      )}
                    />
                  </div>
                  <span className="text-2xs font-medium text-white/70 whitespace-nowrap">Split</span>
                </div>
              </div>

              {/* Gear Settings Button — absolute anchored left of Play */}
              <SettingsButton nodeId={rfId} className="absolute right-12 bottom-3 h-7 w-7 border-0 text-white/70 hover:text-white hover:bg-white/[0.07] bg-white/[0.04] z-30 animate-fade-in" />

              {/* Play Button — absolute anchored bottom-right */}
              <button
                type="button"
                onMouseDown={stopNodeAction}
                onDoubleClick={stopNodeAction}
                onClick={handleRunOrCancel}
                className={cn(
                  "nodrag nowheel absolute right-3 bottom-3 p-2 rounded-full border transition-all duration-150 z-30 shadow-sm cursor-pointer",
                  isProcessing
                    ? hovered
                      ? "bg-rose-600 border-rose-600 text-white hover:bg-rose-700 hover:border-rose-700"
                      : "bg-[#8f939b]/20 border-[#8f939b]/25 text-white/70"
                    : "bg-[#f3f4f6] border-[#f3f4f6] text-[#1c2027] hover:bg-white hover:border-white hover:scale-[1.06]"
                )}
                title={isProcessing ? (hovered ? "Cancel generation" : "Running") : "Run Variant Generation"}
              >
                {isProcessing ? (
                  hovered ? <X size={14} strokeWidth={2} /> : <RefreshCw size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Play size={14} strokeWidth={2} fill="currentColor" />
                )}
              </button>
            </div>
          </div>
        </div>

        <ResizeHandle
          nodeId={rfId}
          corners={["br", "bl", "tr"]}
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          currentWidth={width}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          forceVisible={!!selected}
        />
      </div>

      {/* Resize handle — placed OUTSIDE card body, sibling of 20px-padded wrapper */}

      {/* ═══════════════════════════════════════════════════════════════════
         HANDLES — placed OUTSIDE card body as siblings of 20px-padded wrapper
         DOM order: source → target-text → target-image (mandatory)
         ═══════════════════════════════════════════════════════════════════ */}

      {/* Source handle (palette output) — right side top: 48px */}
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        style={{ top: EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET }}
        className={edgeHandleClass({ side: "right", visible: showSourceHandle })}
      >
        <HandleBadge icon={Palette} active={hasSourceEdge} label="Variant Output" side="right" />
      </Handle>

      {/* Target handle (text input) — left side bottom: 54px */}
      <Handle
        type="target"
        position={Position.Left}
        id="target-text"
        className={targetHandleClassName(hasTextConnection)}
        style={{ top: "auto", bottom: 54 }}
      >
        <HandleBadge icon={Type} active={hasTextConnection} label="Prompt" side="left" />
      </Handle>

      {/* Target handle (image/layer input) — left side bottom: 14px */}
      <Handle
        type="target"
        position={Position.Left}
        id="target-image"
        className={targetHandleClassName(hasImageConnection)}
        style={{ top: "auto", bottom: 14 }}
      >
        <HandleBadge icon={Layers} active={hasImageConnection} label="Start Image" side="left" />
      </Handle>



      <SettingsDrawer
        nodeId={rfId}
        title="Variant settings"
        hint="Override the axis prompt with extra notes specific to this Variant batch."
      >
        <TextAreaField
          label="Custom system prompt"
          value={(data.customSystemPrompt as string | undefined) ?? ""}
          onChange={(next) => persistNodeData(rfId, { customSystemPrompt: next || null })}
          placeholder="Optional. Appended to the axis template - e.g. tone, era, palette, finish."
          rows={3}
          hint="Backend pickup ships in a follow-up; the value persists today."
        />
      </SettingsDrawer>
    </div>
  );
}
