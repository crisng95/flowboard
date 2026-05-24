/**
 * VariantNode — Magnific AI Variations #2
 *
 * Backend node type: `variant`. Generates image variations along configurable
 * axes: Age, Custom prompt, Demographics, Expressions, Storyboard, Reframe.
 *
 * Architecture invariants preserved from V2 bug-fix cycle:
 *   • targetHandleClassName with anyConnectionInProgress → pointer-events-auto
 *   • Handles placed outside the Card body as siblings of the 20px-padded wrapper
 *   • Portal dropdowns with rAF coordinate tracking + capturing pointerdown dismiss
 *   • DOM order: target-text before target-image
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { type NodeProps, useReactFlow, Handle, Position, useEdges, useConnection } from "@xyflow/react";
import { Check, Copy, Layers, Palette, Sparkles, Play, Type } from "lucide-react";

import { useBoardStore, type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { SettingsDrawer } from "./shared/SettingsDrawer";
import { SettingsButton } from "./shared/SettingsButton";
import { TextAreaField } from "./shared/SettingsFields";
import { persistNodeData } from "./shared/persistNodeData";
import { mediaUrl } from "./shared/useUploadFlow";

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
const ASPECT_CSS: Record<string, string> = {
  "1:1": "1 / 1",
  "16:9": "16 / 9",
  "9:16": "9 / 16",
  "4:3": "4 / 3",
  "3:4": "3 / 4",
  "3:2": "3 / 2",
  "2:3": "2 / 3",
  "21:9": "21 / 9",
};

const ASPECT_TO_FLOW: Record<string, string> = {
  "1:1": "IMAGE_ASPECT_RATIO_SQUARE",
  "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
  "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT",
  "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE",
  "3:4": "IMAGE_ASPECT_RATIO_PORTRAIT",
  "3:2": "IMAGE_ASPECT_RATIO_LANDSCAPE",
  "2:3": "IMAGE_ASPECT_RATIO_PORTRAIT",
  "21:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
};

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
  menuPos: { left: number; top: number } | null;
  menuId: string;
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
  menuPos,
  menuId,
  disabledOptions = [],
  disabled = false,
  multiSelect = false,
  label,
}: PortalDropdownProps) {
  // Compute button label
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
        onClick={() => setOpen(!open)}
        className={cn(
          "h-7 px-3.5 rounded-full flex items-center justify-between gap-1.5 text-2xs font-medium bg-[#27272a] border border-white/5 transition-all duration-150 cursor-pointer select-none",
          disabled
            ? "text-white/30 cursor-not-allowed opacity-40"
            : "text-zinc-200 hover:text-white hover:border-white/20 active:bg-black/60",
        )}
      >
        <span className="truncate max-w-[100px]">{displayLabel}</span>
        <span className="text-[7px] opacity-70">▼</span>
      </button>

      {open && !disabled && menuPos && createPortal(
        <div
          id={menuId}
          className="fixed rounded-lg p-1 border border-white/[0.08] shadow-xl z-[9999] nowheel magnific-dropdown-scroll flex flex-col gap-1"
          style={{
            left: menuPos.left,
            top: menuPos.top,
            backgroundColor: "#1a1a1a",
            width: "180px",
            maxHeight: "280px",
            overflowY: "auto",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {options.map((opt) => {
            const isDisabled = disabledOptions.includes(opt);
            const isActive = multiSelect
              ? Array.isArray(value) && value.includes(opt)
              : opt === value;

            return (
              <button
                key={opt}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (multiSelect) {
                    const arr = Array.isArray(value) ? value : [];
                    const next = arr.includes(opt)
                      ? arr.filter((v) => v !== opt)
                      : [...arr, opt];
                    onChange(next);
                    // Keep menu open for multi-select
                  } else {
                    onChange(opt);
                    setOpen(false);
                  }
                }}
                className={cn(
                  "w-full px-2.5 py-1.5 rounded-md text-2xs transition-colors flex items-center gap-2.5",
                  isDisabled
                    ? "text-white/25 cursor-not-allowed hover:bg-transparent"
                    : isActive
                    ? "text-white bg-white/[0.06]"
                    : "text-white/70 hover:text-white hover:bg-white/[0.06] cursor-pointer",
                )}
              >
                {multiSelect && (
                  <div
                    className={cn(
                      "w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 border transition-all duration-150",
                      isActive
                        ? "bg-accent border-accent"
                        : "border-white/25 bg-transparent",
                    )}
                  >
                    {isActive && (
                      <Check size={9} strokeWidth={3} className="text-white" />
                    )}
                  </div>
                )}
                <span className="truncate flex-1 text-left">{opt}</span>
                {!multiSelect && isActive && (
                  <Check size={12} strokeWidth={2.5} className="text-accent shrink-0" />
                )}
                {isDisabled && (
                  <span className="text-[8px] px-1 rounded bg-white/10 text-white/60 font-semibold uppercase tracking-wider">
                    Soon
                  </span>
                )}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   CUSTOM RESIZE HANDLE
   ═══════════════════════════════════════════════════════════════════════════ */
interface DualResizeHandleProps {
  forceVisible?: boolean;
  minWidth: number;
  maxWidth: number;
  currentWidth: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
}

function CustomResizeHandle({
  minWidth,
  maxWidth,
  currentWidth,
  onResize,
  onResizeEnd,
  forceVisible = false,
}: DualResizeHandleProps) {
  const { getZoom } = useReactFlow();
  const [isDragging, setIsDragging] = useState(false);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startX: e.clientX,
      startWidth: currentWidth,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveWidth(Math.round(currentWidth));
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const nextW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    onResize(nextW);
    setLiveWidth(Math.round(nextW));
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const finalW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    dragStateRef.current = null;
    setIsDragging(false);
    setLiveWidth(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    onResizeEnd(finalW);
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center group",
        isDragging ? "[&_path]:opacity-100" : forceVisible ? "[&_path]:opacity-30 group-hover:[&_path]:opacity-100" : "[&_path]:opacity-0",
        "[&_path]:transition-opacity [&_path]:duration-100",
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        bottom: 0,
        right: 20,
        width: 48,
        height: 48,
        transform: "translate(50%, 50%)",
        background: "transparent",
        touchAction: "none",
      }}
    >
      {liveWidth !== null && (
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
          {liveWidth}px
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
          strokeWidth="14"
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
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   VARIANT NODE COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */
export function VariantNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const isProcessing = data.status === "queued" || data.status === "running";
  const mediaIds = (data.mediaIds as (string | null)[] | undefined) ?? [];
  const slotErrors = (data.slotErrors as (string | null)[] | undefined) ?? [];
  const hasFilled = mediaIds.some(Boolean);

  const config: VariantConfig = {
    ...DEFAULT_CONFIG,
    ...((data.variant_config as Partial<VariantConfig>) ?? {}),
  };

  const [hovered, setHovered] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Menu positions
  const [modeMenuPos, setModeMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [aspectMenuPos, setAspectMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [resMenuPos, setResMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [gridMenuPos, setGridMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [ethnicityMenuPos, setEthnicityMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [genderMenuPos, setGenderMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [anglesMenuPos, setAnglesMenuPos] = useState<{ left: number; top: number } | null>(null);

  // Trigger button refs
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const aspectBtnRef = useRef<HTMLButtonElement>(null);
  const resBtnRef = useRef<HTMLButtonElement>(null);
  const gridBtnRef = useRef<HTMLButtonElement>(null);
  const ethnicityBtnRef = useRef<HTMLButtonElement>(null);
  const genderBtnRef = useRef<HTMLButtonElement>(null);
  const anglesBtnRef = useRef<HTMLButtonElement>(null);

  /* ── rAF coordinate tracking + capturing pointerdown dismiss ──────────── */
  useEffect(() => {
    const activePickers = {
      mode: { open: showMode, btn: modeBtnRef, setPos: setModeMenuPos, menuId: `variant-mode-menu-${rfId}`, close: () => setShowMode(false) },
      aspect: { open: showAspect, btn: aspectBtnRef, setPos: setAspectMenuPos, menuId: `variant-aspect-menu-${rfId}`, close: () => setShowAspect(false) },
      res: { open: showRes, btn: resBtnRef, setPos: setResMenuPos, menuId: `variant-res-menu-${rfId}`, close: () => setShowRes(false) },
      grid: { open: showGrid, btn: gridBtnRef, setPos: setGridMenuPos, menuId: `variant-grid-menu-${rfId}`, close: () => setShowGrid(false) },
      ethnicity: { open: showEthnicity, btn: ethnicityBtnRef, setPos: setEthnicityMenuPos, menuId: `variant-ethnicity-menu-${rfId}`, close: () => setShowEthnicity(false) },
      gender: { open: showGender, btn: genderBtnRef, setPos: setGenderMenuPos, menuId: `variant-gender-menu-${rfId}`, close: () => setShowGender(false) },
      angles: { open: showAngles, btn: anglesBtnRef, setPos: setAnglesMenuPos, menuId: `variant-angles-menu-${rfId}`, close: () => setShowAngles(false) },
    };

    const hasAnyOpen = showMode || showAspect || showRes || showGrid || showEthnicity || showGender || showAngles;
    if (!hasAnyOpen) {
      setModeMenuPos(null);
      setAspectMenuPos(null);
      setResMenuPos(null);
      setGridMenuPos(null);
      setEthnicityMenuPos(null);
      setGenderMenuPos(null);
      setAnglesMenuPos(null);
      return;
    }

    let raf = 0;
    function tick() {
      Object.values(activePickers).forEach(({ open, btn, setPos }) => {
        if (open && btn.current) {
          const rect = btn.current.getBoundingClientRect();
          setPos({
            left: rect.left,
            top: rect.bottom + 4,
          });
        } else {
          setPos(null);
        }
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    function onDocumentPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;

      Object.values(activePickers).forEach(({ open, btn, menuId, close }) => {
        if (!open) return;
        if (btn.current && btn.current.contains(target)) return;
        const menuEl = document.getElementById(menuId);
        if (menuEl && menuEl.contains(target)) return;
        close();
      });
    }

    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    };
  }, [showMode, showAspect, showRes, showGrid, showEthnicity, showGender, showAngles, rfId]);

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

  const modeToAxisKey: Record<string, string> = {
    "Age": "age",
    "Custom": "custom",
    "Demographics": "demographics",
    "Expressions": "expressions",
    "Storyboard": "storyboard",
    "Reframe": "reframe",
  };

  /* ── Real-time edge state via ReactFlow native hooks (0ms delay) ─────── */
  const edges = useEdges();
  const connection = useConnection();

  const hasTextConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-text");
  const hasImageConnection = edges.some((e) => e.target === rfId && e.targetHandle === "target-image");
  const hasSourceEdge = edges.some((e) => e.source === rfId);

  const hasTargetEdge = edges.some((e) => e.target === rfId);
  const showTargetHandles = showControls || hasTargetEdge || connection.inProgress;
  const anyConnectionInProgress = connection.inProgress;
  const targetHandleClassName = cn(
    "!absolute !-left-0 !h-7 !w-7 !border-0 !bg-transparent",
    "transition-opacity duration-300 ease-out",
    anyConnectionInProgress
      ? "!opacity-100 !pointer-events-auto !z-50"
      : showTargetHandles
      ? "!opacity-100"
      : "!opacity-0 !pointer-events-none",
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
  const handleRun = async () => {
    if (isProcessing) return;
    try {
      console.log("Dispatching variant generation with config:", config);
      await useGenerationStore.getState().dispatchVariant(rfId, {
        axisKey: modeToAxisKey[config.mode] || "custom",
        instruction: hasTextConnection ? upstreamText : config.custom_prompt,
        variantCount,
        aspectRatio: ASPECT_TO_FLOW[config.aspect_ratio],
      });
    } catch (err) {
      console.error("Failed to run variant generation:", err);
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
          "border-[3px] border-white/[0.14] shadow-lg",
          selected && "ring-2 ring-accent/50",
          isProcessing && "ring-2 ring-accent/30 animate-pulse",
        )}
        style={{ borderRadius: 16, backgroundColor: "#1a1a1a" }}
      >
        {/* Viewport content layout container */}
        <div
          className="relative overflow-hidden w-full"
          style={{
            aspectRatio: ASPECT_CSS[config.aspect_ratio] || "16 / 9",
            minHeight: 240,
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
                  <button
                    type="button"
                    onClick={() => useGenerationStore.getState().openResultViewer(rfId, 0)}
                    className="absolute inset-0 size-full overflow-hidden bg-white/[0.04] p-0 border-0 cursor-pointer"
                  >
                    <img
                      src={mediaUrl(mediaIds[0])}
                      alt="variant 1"
                      className={cn(
                        "absolute inset-0 w-full h-full object-cover transition-all duration-300 rounded-[13px]",
                        promptFocused && "blur-sm scale-[1.02]",
                      )}
                      onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId, 0)}
                    />
                  </button>
                ) : (
                  /* Loading/Shimmer slot placeholder */
                  <div className="absolute inset-0 bg-white/[0.05]">
                    {isProcessing && (
                      <div
                        className="absolute inset-0"
                        style={{
                          background: "linear-gradient(105deg, transparent 40%, rgba(124,92,255,0.2) 50%, transparent 60%)",
                          backgroundSize: "200% 100%",
                          animation: "shimmer 1.6s ease-in-out infinite",
                        }}
                      />
                    )}
                  </div>
                )
              ) : (
                /* Grid of multiple variants */
                <div
                  className={cn(
                    "absolute inset-0 grid gap-px bg-black/20",
                    variantCount <= 4 ? "grid-cols-2" : "grid-cols-3",
                  )}
                >
                  {Array.from({ length: variantCount }).map((_, i) => {
                    const mid = mediaIds[i];
                    const err = slotErrors[i];
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          if (mid) useGenerationStore.getState().openResultViewer(rfId, i);
                        }}
                        className="relative min-h-0 min-w-0 overflow-hidden bg-white/[0.04] p-0 border-0 disabled:cursor-default"
                        disabled={!mid}
                      >
                        {mid ? (
                          <img
                            src={mediaUrl(mid)}
                            alt={`variant ${i + 1}`}
                            className={cn(
                              "absolute inset-0 w-full h-full object-cover transition-all duration-300",
                              promptFocused && "blur-sm scale-[1.02]",
                            )}
                            onDoubleClick={() => useGenerationStore.getState().openResultViewer(rfId, i)}
                          />
                        ) : err ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                            <span className="text-[9px] text-red-400">failed</span>
                          </div>
                        ) : (
                          /* Loading or Empty slot placeholder */
                          <div className="absolute inset-0 bg-white/[0.05]">
                            {isProcessing && (
                              <div
                                className="absolute inset-0"
                                style={{
                                  background: "linear-gradient(105deg, transparent 40%, rgba(124,92,255,0.2) 50%, transparent 60%)",
                                  backgroundSize: "200% 100%",
                                  animation: "shimmer 1.6s ease-in-out infinite",
                                }}
                              />
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Empty state placeholder */
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
                  menuPos={modeMenuPos}
                  menuId={`variant-mode-menu-${rfId}`}
                  disabledOptions={["Age", "Demographics", "Expressions", "Reframe"]}
                />
                <PortalDropdown
                  buttonRef={aspectBtnRef}
                  open={showAspect}
                  setOpen={setShowAspect}
                  options={ASPECT_OPTIONS}
                  value={config.aspect_ratio}
                  onChange={(val: string) => updateConfig({ aspect_ratio: val })}
                  menuPos={aspectMenuPos}
                  menuId={`variant-aspect-menu-${rfId}`}
                />
                <PortalDropdown
                  buttonRef={resBtnRef}
                  open={showRes}
                  setOpen={setShowRes}
                  options={RESOLUTION_OPTIONS}
                  value={config.resolution}
                  onChange={(val: string) => updateConfig({ resolution: val })}
                  menuPos={resMenuPos}
                  menuId={`variant-res-menu-${rfId}`}
                  disabled={true}
                />
                <PortalDropdown
                  buttonRef={gridBtnRef}
                  open={showGrid}
                  setOpen={setShowGrid}
                  options={GRID_OPTIONS}
                  value={config.grid}
                  onChange={(val: string) => updateConfig({ grid: val })}
                  menuPos={gridMenuPos}
                  menuId={`variant-grid-menu-${rfId}`}
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
                      menuPos={ethnicityMenuPos}
                      menuId={`variant-ethnicity-menu-${rfId}`}
                      multiSelect
                    />
                    <PortalDropdown
                      buttonRef={genderBtnRef}
                      open={showGender}
                      setOpen={setShowGender}
                      options={GENDER_OPTIONS}
                      value={config.genders}
                      onChange={(val: string[]) => updateConfig({ genders: val as ("Female" | "Male")[] })}
                      menuPos={genderMenuPos}
                      menuId={`variant-gender-menu-${rfId}`}
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
                    menuPos={anglesMenuPos}
                    menuId={`variant-angles-menu-${rfId}`}
                    multiSelect
                  />
                )}

                {/* Split Images Toggle — always visible in Row 2 */}
                <div
                  onClick={() => updateConfig({ split_images: !config.split_images })}
                  className="flex items-center gap-2 cursor-pointer select-none h-7 px-3 rounded-full bg-white/[0.04] border border-white/5 shrink-0"
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
                disabled={isProcessing}
                onClick={handleRun}
                className={cn(
                  "absolute right-3 bottom-3 p-2 rounded-full transition-all duration-150 z-30",
                  isProcessing
                    ? "bg-accent/30 text-accent/50 cursor-not-allowed"
                    : "bg-accent/30 text-accent hover:bg-accent/40 cursor-pointer"
                )}
                title="Run Variant Generation"
              >
                {isProcessing ? (
                  <Sparkles size={14} className="animate-spin text-accent" />
                ) : (
                  <Play size={14} strokeWidth={2} fill="currentColor" />
                )}
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* Resize handle — placed OUTSIDE card body, sibling of 20px-padded wrapper */}
      <CustomResizeHandle
        minWidth={MIN_WIDTH}
        maxWidth={MAX_WIDTH}
        currentWidth={width}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        forceVisible={!!selected}
      />

      {/* ═══════════════════════════════════════════════════════════════════
         HANDLES — placed OUTSIDE card body as siblings of 20px-padded wrapper
         DOM order: source → target-text → target-image (mandatory)
         ═══════════════════════════════════════════════════════════════════ */}

      {/* Source handle (palette output) — right side top: 48px */}
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className={cn(
          "!absolute !-right-0 !top-[48px] !h-7 !w-7 !border-0 !bg-transparent",
          "transition-opacity duration-300 ease-out",
          showSourceHandle ? "!opacity-100" : "!opacity-0 !pointer-events-none",
        )}
      >
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150"
          style={{
            backgroundColor: "#2b2b2b",
            borderColor: hasSourceEdge ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Palette size={11} strokeWidth={2} />
        </div>
      </Handle>

      {/* Target handle (text input) — left side bottom: 54px */}
      <Handle
        type="target"
        position={Position.Left}
        id="target-text"
        className={targetHandleClassName}
        style={{ top: "auto", bottom: 54 }}
      >
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150"
          style={{
            backgroundColor: "#2b2b2b",
            borderColor: hasTextConnection ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Type size={11} strokeWidth={2} />
        </div>
      </Handle>

      {/* Target handle (image/layer input) — left side bottom: 14px */}
      <Handle
        type="target"
        position={Position.Left}
        id="target-image"
        className={targetHandleClassName}
        style={{ top: "auto", bottom: 14 }}
      >
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full border transition-all duration-150"
          style={{
            backgroundColor: "#2b2b2b",
            borderColor: hasImageConnection ? "rgba(124,92,255,0.7)" : "rgba(124,92,255,0.4)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Layers size={11} strokeWidth={2} />
        </div>
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
