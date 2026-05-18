/**
 * VariantNode - Magnific-style Variations card.
 *
 * Backend node type: `variant`. Takes a single upstream Concept (or
 * Part / another Variant) and renders 1-4 alternate versions varying
 * along ONE axis (color / material / damage / equipment / outfit).
 *
 * UI pattern (locked Concepta v1):
 *   - Hover/selected reveal bottom bar (Magnific). Mirrors Concept /
 *     Reference / Multi-view / Part.
 *   - Bar contents: axis chip + count stepper + instruction input +
 *     Run button.
 */
import { useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Copy, Layers, Palette, Sparkles } from "lucide-react";

import { getVariantAxes, patchNode, type VariantAxisDTO } from "../../api/client";
import { useBoardStore, type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { ChipPicker } from "./shared/ChipPicker";
import { EmptyState } from "./shared/EmptyState";
import { CountStepper } from "./shared/CountStepper";
import { IconChip } from "./shared/IconChip";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { RevealBar } from "./shared/RevealBar";
import { RunButton } from "./shared/RunButton";
import { normaliseStatus } from "./shared/status";
import { useNodeHover } from "./shared/useNodeHover";
import { useNodeWidth } from "./shared/useNodeWidth";
import { mediaUrl } from "./shared/useUploadFlow";

const MIN_WIDTH = 280;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 340;

export function VariantNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const axisKey = (data.axisKey as string | undefined) ?? null;
  const persistedInstruction = (data.variantInstruction as string | undefined) ?? "";
  const variantCount = Math.max(
    1,
    Math.min((data.variantCount as number | undefined) ?? 2, 4),
  );
  const mediaIds = (data.mediaIds as (string | null)[] | undefined) ?? [];
  const slotErrors = (data.slotErrors as (string | null)[] | undefined) ?? [];
  const isProcessing = data.status === "queued" || data.status === "running";
  const hasFilled = mediaIds.some(Boolean);

  const [axes, setAxes] = useState<VariantAxisDTO[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const axisAnchorRef = useRef<HTMLButtonElement>(null);

  // Local instruction state - debounce persistence so each keystroke
  // doesn''t trigger a backend roundtrip.
  const [instruction, setInstruction] = useState(persistedInstruction);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { width, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });
  const { showControls, bind } = useNodeHover(selected);

  useEffect(() => {
    let cancelled = false;
    fetchVariantAxesCached().then((a) => {
      if (!cancelled) setAxes(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (persistedInstruction !== instruction) setInstruction(persistedInstruction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedInstruction]);

  const axisLabel = axes.find((a) => a.key === axisKey)?.label ?? null;

  function persistAxis(key: string) {
    useBoardStore.getState().updateNodeData(rfId, { axisKey: key });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) patchNode(dbId, { data: { axisKey: key } }).catch(() => {});
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
    useBoardStore.getState().updateNodeData(rfId, { variantCount: n });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { variantCount: n } }).catch(() => {});
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
    <div {...bind}>
      <NodeShell
        Icon={Palette}
        title={data.title || "Variant"}
        shortId={data.shortId}
        selected={selected}
        width={width}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: Palette, label: "Variant output" }}
        targetHandle={{
          id: "target",
          icon: Layers,
          label: "Concept / Part input",
        }}
      >
        {hasFilled || isProcessing ? (
          <div
            className={cn(
              "grid gap-2",
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
          <EmptyState
            Icon={Palette}
            title="Explore new possibilities"
            hint="Generate variations from your concept"
          />
        )}

        <RevealBar show={showControls}>
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            <ChipPicker
              ref={axisAnchorRef}
              label="Axis"
              value={axisLabel}
              isOpen={pickerOpen}
              onToggle={() => setPickerOpen(!pickerOpen)}
            />
            <CountStepper
              value={variantCount}
              min={1}
              max={4}
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

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={instruction}
              onChange={(e) => onInstructionChange(e.target.value)}
              placeholder={
                axisKey ? instructionPlaceholder(axisKey) : "Pick an axis..."
              }
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
            <RunButton
              onClick={generate}
              disabled={!axisKey || isProcessing}
              label="Generate variants"
              busy={isProcessing}
            />
          </div>
        </RevealBar>

        <ResizeHandle
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          currentWidth={width}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      </NodeShell>
    </div>
  );
}

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
        <img
          src={mediaUrl(mediaId)}
          alt={alt}
          className="w-full h-auto block animate-fade-in"
        />
      ) : isProcessing ? (
        <div
          className="flex items-center justify-center"
          style={{ minHeight: 120 }}
        >
          <Sparkles size={14} className="animate-pulse-soft text-accent" />
        </div>
      ) : error ? (
        <div
          className="flex items-center justify-center px-1.5"
          style={{ minHeight: 120 }}
        >
          <span className="text-[9px] text-red-400 leading-tight text-center">
            failed
          </span>
        </div>
      ) : (
        <div
          className="flex items-center justify-center"
          style={{ minHeight: 120 }}
        >
          <span className="text-[9px] text-ink-placeholder">v{idx + 1}</span>
        </div>
      )}
    </button>
  );
}

function instructionPlaceholder(axisKey: string): string {
  switch (axisKey) {
    case "color":
      return "Deep crimson and gold trim";
    case "material":
      return "Obsidian + gold leaf inlay";
    case "damage":
      return "Battle-worn, scratched, chipped";
    case "equipment":
      return "Twin daggers + shield";
    case "outfit_alt":
      return "Linen tunic and leather sandals";
    default:
      return "Describe the change...";
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

