/**
 * VariantNode — Magnific-style Variations card.
 *
 * Pattern (from Magnific reference screenshots):
 *   - DEFAULT (idle, not hovered): clean card with ONLY the empty
 *     state placeholder (icon + "Explore new possibilities" text) or
 *     the generated grid. NO controls visible.
 *   - HOVER / SELECTED: bottom bar slides in with pill controls
 *     (Axis ▾ · Count ▾) + instruction input + Run ▶ button.
 *     Handle pills appear on left/right edges.
 *   - DROPDOWN: portaled checklist (axis picker) with checkmarks.
 *
 * Backend node type: `variant`. Takes a single upstream Concept (or
 * Part / another Variant) and renders 1-4 alternate versions varying
 * along ONE axis (color / material / damage / equipment / outfit).
 */
import { forwardRef, useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import {
  Copy,
  Layers,
  Minus,
  Palette,
  Play,
  Plus,
  Sparkles,
} from "lucide-react";

import { getVariantAxes, patchNode, type VariantAxisDTO } from "../../api/client";
import { useBoardStore, type FlowNode, type FlowboardNodeData } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { IconChip } from "./shared/IconChip";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { mediaUrl } from "./shared/useUploadFlow";

const MIN_WIDTH = 280;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 340;

export function VariantNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const userWidth = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;
  const axisKey = (data.axisKey as string | undefined) ?? null;
  const persistedInstruction =
    (data.variantInstruction as string | undefined) ?? "";
  const variantCount = Math.max(
    1,
    Math.min((data.variantCount as number | undefined) ?? 2, 4),
  );
  const mediaIds =
    (data.mediaIds as (string | null)[] | undefined) ?? [];
  const slotErrors =
    (data.slotErrors as (string | null)[] | undefined) ?? [];
  const isProcessing = data.status === "queued" || data.status === "running";
  const hasFilled = mediaIds.some(Boolean);

  // Hover state — controls reveal on hover OR when node is selected.
  const [hovered, setHovered] = useState(false);
  const showControls = hovered || selected || false;

  const [axes, setAxes] = useState<VariantAxisDTO[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const axisAnchorRef = useRef<HTMLButtonElement>(null);

  // Local instruction state — debounce persistence.
  const [instruction, setInstruction] = useState(persistedInstruction);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchVariantAxesCached().then((a) => {
      if (!cancelled) setAxes(a);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (persistedInstruction !== instruction) {
      setInstruction(persistedInstruction);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedInstruction]);

  const axisLabel = axes.find((a) => a.key === axisKey)?.label ?? null;

  function persistAxis(key: string) {
    useBoardStore.getState().updateNodeData(rfId, { axisKey: key });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { axisKey: key } }).catch(() => {});
    }
  }

  function persistInstruction(value: string) {
    useBoardStore.getState().updateNodeData(rfId, { variantInstruction: value });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { variantInstruction: value } }).catch(() => {});
    }
  }

  function onInstructionChange(value: string) {
    setInstruction(value);
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => persistInstruction(value), 400);
  }

  function persistVariantCount(n: number) {
    const clamped = Math.max(1, Math.min(n, 4));
    useBoardStore.getState().updateNodeData(rfId, { variantCount: clamped });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { variantCount: clamped } }).catch(() => {});
    }
  }

  function persistWidth(newWidth: number) {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(newWidth)));
    useBoardStore.getState().updateNodeData(rfId, { nodeWidth: clamped });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { nodeWidth: clamped } }).catch(() => {});
    }
  }

  function generate() {
    if (!axisKey) return;
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
      persistInstruction(instruction);
    }
    useGenerationStore.getState().dispatchVariant(rfId, {
      axisKey,
      instruction,
      variantCount,
    });
  }

  function onCopySheet() {
    const ids = mediaIds.filter((m): m is string => typeof m === "string" && !!m);
    if (ids.length) navigator.clipboard.writeText(ids.join(",")).catch(() => {});
  }

  return (
    <>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <NodeShell
          Icon={Palette}
          title={data.title || "Variant"}
          shortId={data.shortId}
          selected={selected}
          width={userWidth}
          status={normaliseStatus(data.status)}
          sourceHandle={{ id: "source", icon: Palette, label: "Variant output" }}
          targetHandle={{ id: "target", icon: Layers, label: "Concept / Part input" }}
        >
          {/* Main content area — grid when filled, placeholder when empty */}
          {hasFilled || isProcessing ? (
            <div
              className={cn(
                "grid gap-2",
                // Responsive columns: 1 tile = full width (1 col),
                // 2 tiles = 2 cols, 3-4 tiles = 2 cols (2×2 grid).
                // When count=1 the single tile spans the full node
                // width so the image reads at maximum size.
                variantCount === 1 ? "grid-cols-1" : "grid-cols-2",
              )}
            >
              {Array.from({ length: variantCount }).map((_, i) => {
                const mid = mediaIds[i];
                const err = slotErrors[i];
                return (
                  <VariantTile
                    key={i}
                    idx={i}
                    mediaId={typeof mid === "string" ? mid : null}
                    error={typeof err === "string" ? err : null}
                    isProcessing={isProcessing && !mid}
                    onClick={() => {
                      if (typeof mid === "string" && mid) {
                        useGenerationStore.getState().openResultViewer(rfId, i);
                      }
                    }}
                    alt={`${axisLabel ?? "variant"} ${i + 1}`}
                  />
                );
              })}
            </div>
          ) : (
            // Empty state — Magnific style: large icon + 2 lines centered
            <div
              className="flex flex-col items-center justify-center text-center py-12"
              style={{ minHeight: 200 }}
            >
              <Palette size={36} strokeWidth={1.2} className="text-ink-placeholder mb-4" />
              <p className="text-sm font-medium text-ink-primary mb-1">
                Explore new possibilities
              </p>
              <p className="text-2xs text-ink-placeholder">
                Generate variations from your concept
              </p>
            </div>
          )}

          {/* Bottom control bar — Magnific pattern: hidden by default,
              slides in on hover/selected. Contains axis picker, count
              stepper, instruction mini-input, and Run button. */}
          <div
            className={cn(
              "transition-all duration-200 overflow-hidden",
              showControls ? "max-h-40 opacity-100 mt-3" : "max-h-0 opacity-0 mt-0",
            )}
          >
            {/* Row 1: Axis pill + Count stepper + instruction */}
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              <AxisChip
                ref={axisAnchorRef}
                label="Axis"
                value={axisLabel}
                isOpen={pickerOpen}
                onToggle={() => setPickerOpen(!pickerOpen)}
              />
              <CountStepper
                value={variantCount}
                onChange={persistVariantCount}
                disabled={isProcessing}
              />
              {hasFilled && (
                <IconChip
                  icon={Copy}
                  label="Copy media ids"
                  onClick={onCopySheet}
                />
              )}
            </div>

            <PickerDropdown
              anchorRef={axisAnchorRef}
              isOpen={pickerOpen}
              onClose={() => setPickerOpen(false)}
              items={axes.map((a) => ({ key: a.key, label: a.label }))}
              activeKey={axisKey ?? undefined}
              onPick={(key) => {
                persistAxis(key);
                setPickerOpen(false);
              }}
            />

            {/* Row 2: Instruction input + Run button */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={instruction}
                onChange={(e) => onInstructionChange(e.target.value)}
                placeholder={axisKey ? instructionPlaceholder(axisKey) : "Pick an axis…"}
                disabled={!axisKey || isProcessing}
                className={cn(
                  "flex-1 h-8 px-3 rounded-full text-2xs",
                  "border transition-colors",
                  "placeholder:text-ink-placeholder text-ink-primary",
                  "focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
                style={{
                  backgroundColor: "#15171d",
                  borderColor: "rgba(255,255,255,0.08)",
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && axisKey && !isProcessing) generate();
                }}
              />

              {/* Run button — Magnific ▶ circle, accent gradient */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  generate();
                }}
                disabled={!axisKey || isProcessing}
                title="Generate variants"
                className={cn(
                  "shrink-0 size-8 rounded-full inline-flex items-center justify-center",
                  "transition-all duration-150",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                  "hover:scale-105 active:scale-95",
                )}
                style={{
                  background: "linear-gradient(135deg, #9d80ff 0%, #7c5cff 50%, #5e3ee5 100%)",
                  boxShadow: "0 4px 14px rgba(124,92,255,0.4)",
                }}
              >
                <Play size={14} fill="white" stroke="white" strokeWidth={0} />
              </button>
            </div>
          </div>
        </NodeShell>
      </div>

      <ResizeHandle
        minWidth={MIN_WIDTH}
        maxWidth={MAX_WIDTH}
        currentWidth={userWidth}
        onResize={(width) => {
          useBoardStore.getState().updateNodeData(rfId, { nodeWidth: width });
        }}
        onResizeEnd={(width) => persistWidth(width)}
      />
    </>
  );
}

/* ── Sub-components ───────────────────────────────────────────────── */

interface VariantTileProps {
  idx: number;
  mediaId: string | null;
  error: string | null;
  isProcessing: boolean;
  alt: string;
  onClick: () => void;
}

function VariantTile({
  idx,
  mediaId,
  error,
  isProcessing,
  alt,
  onClick,
}: VariantTileProps) {
  // No forced aspect-ratio on the tile. When an image is loaded, the
  // <img> with `w-full h-auto` defines the tile's natural height from
  // the image's intrinsic aspect. This means:
  //   - Portrait images → tall tiles
  //   - Landscape images → short tiles
  //   - Square images → square tiles
  // All without letterbox or crop — matches Magnific's "Format specs
  // list" grid where each tile wraps tightly around its content.
  //
  // Empty / processing / error states use a fixed min-height so the
  // tile doesn't collapse to 0px before media loads.

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!mediaId}
      className={cn(
        "relative rounded-lg overflow-hidden border transition-all duration-150",
        "border-line-subtle w-full",
        mediaId
          ? "cursor-pointer hover:border-line-strong hover:scale-[1.02]"
          : "cursor-default",
        error && "border-red-500/40",
      )}
      style={{ backgroundColor: "#15171d" }}
    >
      {mediaId ? (
        // w-full h-auto: image defines tile height from its intrinsic
        // aspect. No object-fit needed — the image IS the tile size.
        // rounded-lg on parent clips corners.
        <img
          src={mediaUrl(mediaId)}
          alt={alt}
          className="w-full h-auto block animate-fade-in"
        />
      ) : isProcessing ? (
        <div className="flex items-center justify-center" style={{ minHeight: 120 }}>
          <Sparkles size={14} className="animate-pulse-soft text-accent" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center px-1.5" style={{ minHeight: 120 }}>
          <span className="text-[9px] text-red-400 leading-tight text-center">
            ⚠ failed
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-center" style={{ minHeight: 120 }}>
          <span className="text-[9px] text-ink-placeholder">v{idx + 1}</span>
        </div>
      )}
    </button>
  );
}

/* ── Axis chip ────────────────────────────────────────────────────── */

interface AxisChipProps {
  label: string;
  value: string | null;
  isOpen: boolean;
  onToggle: () => void;
}

const AxisChip = forwardRef<HTMLButtonElement, AxisChipProps>(
  function AxisChip({ label, value, isOpen, onToggle }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={cn(
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full",
          "text-2xs font-medium transition-all duration-150",
          "border",
          value
            ? "bg-accent/10 border-accent/40 text-white hover:bg-accent/20"
            : "bg-white/[0.03] border-white/[0.08] text-ink-muted hover:bg-white/[0.07] hover:text-ink-primary",
          isOpen && "ring-2 ring-accent/30",
        )}
      >
        <span className="text-ink-muted font-normal">{label}</span>
        <span className={cn(value ? "text-white" : "text-ink-placeholder")}>
          {value ?? "Pick"}
        </span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className={cn("text-ink-muted transition-transform", isOpen && "rotate-180")}
        >
          <path d="M1 2.5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
    );
  },
);

/* ── Count stepper ────────────────────────────────────────────────── */

interface CountStepperProps {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}

function CountStepper({ value, onChange, disabled }: CountStepperProps) {
  return (
    <div
      className="inline-flex items-center gap-0.5 h-7 px-1 rounded-full border border-white/[0.08]"
      style={{ backgroundColor: "rgba(255,255,255,0.02)" }}
    >
      <button
        type="button"
        disabled={disabled || value <= 1}
        onClick={(e) => { e.stopPropagation(); onChange(value - 1); }}
        className="size-5 inline-flex items-center justify-center rounded-md hover:bg-white/[0.08] disabled:opacity-30 text-ink-muted"
      >
        <Minus size={10} />
      </button>
      <span className="text-2xs font-medium text-ink-primary tabular-nums w-4 text-center">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || value >= 4}
        onClick={(e) => { e.stopPropagation(); onChange(value + 1); }}
        className="size-5 inline-flex items-center justify-center rounded-md hover:bg-white/[0.08] disabled:opacity-30 text-ink-muted"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function instructionPlaceholder(axisKey: string): string {
  switch (axisKey) {
    case "color": return "Deep crimson and gold trim";
    case "material": return "Obsidian + gold leaf inlay";
    case "damage": return "Battle-worn, scratched, chipped";
    case "equipment": return "Twin daggers + shield";
    case "outfit_alt": return "Linen tunic and leather sandals";
    default: return "Describe the change…";
  }
}

let variantAxesCache: Promise<VariantAxisDTO[]> | null = null;
function fetchVariantAxesCached(): Promise<VariantAxisDTO[]> {
  if (variantAxesCache === null) {
    variantAxesCache = getVariantAxes().catch((err) => {
      variantAxesCache = null;
      throw err;
    });
  }
  return variantAxesCache;
}

function normaliseStatus(s: FlowboardNodeData["status"]) {
  switch (s) {
    case "queued":
    case "running":
    case "done":
    case "error":
      return s;
    default:
      return "idle";
  }
}
