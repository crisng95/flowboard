/**
 * MultiviewNode — Concepta-fork orthographic turnaround sheet.
 *
 * Backend node type: `multiview`. Takes a single upstream Concept node
 * and produces an N-angle consistency set (front, back, left, right,
 * 3/4 turns, …). Backend dispatches as one `gen_image` (root angle)
 * + N-1 `edit_image` calls (rotations off the root) for tight
 * subject-identity preservation.
 *
 * Persisted node data:
 *   - `multiviewPreset` (key) → "4view" / "6view" / "8view" / "arch_views"
 *   - `mediaIds` (string[]) → one mediaId per angle, in preset order
 *   - `angles` (string[]) → angle labels, in preset order
 *   - `nodeWidth` → user-resized width
 *
 * Layout: a labeled grid (N tiles) where each tile shows one angle's
 * thumbnail + label. Empty tiles render a placeholder with the angle
 * name so the user knows what slot is what before generation lands.
 */
import { useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Box, Copy, Grid3x3, Layers, Sparkles, Wand2 } from "lucide-react";

import { mediaUrl as apiMediaUrl, patchNode } from "../../api/client";
import { MULTIVIEW_PRESETS, type MultiviewKey } from "../../constants/concept";
import { useBoardStore, type FlowNode, type FlowboardNodeData } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { IconChip } from "./shared/IconChip";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";

const MIN_WIDTH = 280;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 360;

export function MultiviewNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const userWidth = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;

  const presetKey = (data.multiviewPreset as MultiviewKey | undefined) ?? "4view";
  const preset = MULTIVIEW_PRESETS.find((p) => p.key === presetKey) ?? MULTIVIEW_PRESETS[0];
  const angles =
    (data.angles as string[] | undefined) ?? preset.angles.slice();
  const mediaIds = (data.mediaIds as (string | null)[] | undefined) ?? [];
  const angleErrors = (data.angleErrors as (string | null)[] | undefined) ?? [];

  const isProcessing = data.status === "queued" || data.status === "running";

  const [pickerOpen, setPickerOpen] = useState(false);
  const presetAnchorRef = useRef<HTMLButtonElement>(null);

  function persistPreset(key: MultiviewKey) {
    useBoardStore.getState().updateNodeData(rfId, {
      multiviewPreset: key,
      // Reset any prior generation when the preset changes — angle
      // counts differ between presets, and old mediaIds wouldn't
      // line up with the new angles[] array.
      mediaIds: undefined,
      angles: undefined,
    });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, {
        data: { multiviewPreset: key, mediaIds: null, angles: null },
      }).catch(() => {});
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

  function openGenerate() {
    // Multi-view dispatches directly — no GenerationDialog needed.
    // The node already carries the preset choice and the upstream
    // Concept node provides the source media. Skipping the dialog
    // keeps the flow tight: pick layout → click wand → done.
    useGenerationStore.getState().dispatchMultiview(rfId, {
      preset: presetKey,
    });
  }

  function onCopySheet() {
    // Copy the comma-separated mediaIds — useful if the user wants
    // to feed all angles as refs to a downstream node manually.
    if (!mediaIds.length) return;
    const ids = mediaIds.filter((m): m is string => typeof m === "string" && !!m);
    if (ids.length) navigator.clipboard.writeText(ids.join(",")).catch(() => {});
  }

  // Grid columns chosen to feel balanced for each preset count.
  // 4 → 2×2, 6 → 3×2, 8 → 4×2, 6 (arch) → 3×2.
  const cols = angles.length <= 4 ? 2 : angles.length <= 6 ? 3 : 4;

  return (
    <>
      <NodeShell
        Icon={Grid3x3}
        title={data.title || "Multi-view"}
        shortId={data.shortId}
        selected={selected}
        width={userWidth}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: Box, label: "Multi-view output" }}
        targetHandle={{ id: "target", icon: Layers, label: "Concept input" }}
        toolbarLeft={
          <IconChip
            icon={Wand2}
            label="Generate turnaround"
            onClick={openGenerate}
            disabled={isProcessing}
          />
        }
        toolbarRight={
          mediaIds.some(Boolean) ? (
            <IconChip
              icon={Copy}
              label="Copy all media ids"
              onClick={onCopySheet}
            />
          ) : null
        }
      >
        {/* Preset picker — Magnific-style chip + portaled dropdown. */}
        <div className="flex items-center gap-1.5 mb-2.5">
          <PresetChip
            ref={presetAnchorRef}
            label="Layout"
            value={preset.label}
            isOpen={pickerOpen}
            onToggle={() => setPickerOpen(!pickerOpen)}
          />
          <span className="text-2xs text-ink-muted">
            {angles.length} angles · root + {angles.length - 1} edits
          </span>
        </div>
        <PickerDropdown
          anchorRef={presetAnchorRef}
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          items={MULTIVIEW_PRESETS.map((p) => ({
            key: p.key,
            label: p.label,
            hint: `${p.angles.length} angles: ${p.angles.slice(0, 3).join(" · ")}…`,
          }))}
          activeKey={presetKey}
          onPick={(key) => {
            persistPreset(key as MultiviewKey);
            setPickerOpen(false);
          }}
        />

        {/* Angle grid */}
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        >
          {angles.map((angle, i) => (
            <AngleTile
              key={`${angle}-${i}`}
              angle={angle}
              mediaId={mediaIds[i] ?? null}
              error={angleErrors[i] ?? null}
              isProcessing={isProcessing && !mediaIds[i]}
              onClick={() => {
                const mid = mediaIds[i];
                if (typeof mid === "string" && mid) {
                  useGenerationStore.getState().openResultViewer(rfId, i);
                }
              }}
              isRoot={i === 0}
            />
          ))}
        </div>

        {/* Hint row — guides the user to the connected concept */}
        {!mediaIds.some(Boolean) && !isProcessing && (
          <p className="mt-3 text-2xs text-ink-placeholder leading-relaxed">
            Connect this node to a Concept above, pick a layout, then
            click the wand. The first angle generates from the concept;
            the rest are rotation edits off the first for identity
            consistency.
          </p>
        )}
      </NodeShell>

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

interface AngleTileProps {
  angle: string;
  mediaId: string | null;
  error: string | null;
  isProcessing: boolean;
  isRoot: boolean;
  onClick: () => void;
}

function AngleTile({
  angle,
  mediaId,
  error,
  isProcessing,
  isRoot,
  onClick,
}: AngleTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!mediaId}
      className={cn(
        "group relative rounded-lg overflow-hidden",
        "border transition-all duration-150",
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
          src={apiMediaUrl(mediaId)}
          alt={angle}
          className="w-full h-auto block animate-fade-in"
        />
      ) : isProcessing ? (
        <div className="flex items-center justify-center" style={{ minHeight: 100 }}>
          <Sparkles size={14} className="animate-pulse-soft text-accent" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center px-1.5" style={{ minHeight: 100 }}>
          <span className="text-[9px] text-red-400 leading-tight text-center">
            ⚠ failed
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-center px-1" style={{ minHeight: 100 }}>
          <span className="text-[9px] text-ink-placeholder leading-tight text-center break-words">
            {angle}
          </span>
        </div>
      )}

      {/* Angle label overlay */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 px-1.5 py-0.5",
          "text-[9px] font-medium leading-tight text-center truncate",
          "transition-opacity",
          mediaId ? "opacity-0 group-hover:opacity-100" : "opacity-100",
          isRoot ? "bg-accent/40 text-white" : "bg-black/60 text-white/85",
        )}
      >
        {angle}
        {isRoot && <span className="ml-1 text-[8px]">★</span>}
      </div>
    </button>
  );
}

/* ── Preset chip — same pattern as ConceptNode's PickerChipButton ── */

interface PresetChipProps {
  label: string;
  value: string;
  isOpen: boolean;
  onToggle: () => void;
}

import { forwardRef } from "react";

const PresetChip = forwardRef<HTMLButtonElement, PresetChipProps>(
  function PresetChip({ label, value, isOpen, onToggle }, ref) {
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
          "border bg-accent/10 border-accent/40 text-white hover:bg-accent/20",
          isOpen && "ring-2 ring-accent/30",
        )}
      >
        <span className="text-ink-muted font-normal">{label}</span>
        <span>{value}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className={cn(
            "text-ink-muted transition-transform",
            isOpen && "rotate-180",
          )}
        >
          <path d="M1 2.5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
    );
  },
);

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
