/**
 * MultiviewNode - Concepta-fork orthographic turnaround sheet.
 *
 * Backend node type: `multiview`. Takes a single upstream Concept node
 * and produces an N-angle consistency set (front, back, left, right,
 * 3/4 turns, ...). Backend dispatches as one `gen_image` (root angle)
 * + N-1 `edit_image` calls (rotations off the root) for tight
 * subject-identity preservation.
 *
 * Persisted node data:
 *   - multiviewPreset (key) -> "4view" / "6view" / "8view" / "arch_views"
 *   - mediaIds (string[]) -> one mediaId per angle, in preset order
 *   - angles (string[]) -> angle labels, in preset order
 *   - nodeWidth -> user-resized width
 *
 * UI pattern (locked Concepta v1):
 *   - Hover/selected reveal bottom bar (Magnific). Layout chip + Run
 *     button only appear on intent. Mirrors Concept / Reference /
 *     Part / Variant.
 */
import { useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Box, Copy, Grid3x3, Layers, Sparkles } from "lucide-react";

import { mediaUrl as apiMediaUrl } from "../../api/client";
import { useBoardStore, type FlowNode } from "../../store/board";
import { patchNode } from "../../api/client";
import { MULTIVIEW_PRESETS, type MultiviewKey } from "../../constants/concept";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { ChipPicker } from "./shared/ChipPicker";
import { EmptyState } from "./shared/EmptyState";
import { IconChip } from "./shared/IconChip";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { RevealBar } from "./shared/RevealBar";
import { RunButton } from "./shared/RunButton";
import { normaliseStatus } from "./shared/status";
import { useNodeHover } from "./shared/useNodeHover";
import { useNodeWidth } from "./shared/useNodeWidth";

const MIN_WIDTH = 280;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 360;

export function MultiviewNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;

  const presetKey = (data.multiviewPreset as MultiviewKey | undefined) ?? "4view";
  const preset =
    MULTIVIEW_PRESETS.find((p) => p.key === presetKey) ?? MULTIVIEW_PRESETS[0];
  const angles = (data.angles as string[] | undefined) ?? preset.angles.slice();
  const mediaIds = (data.mediaIds as (string | null)[] | undefined) ?? [];
  const angleErrors = (data.angleErrors as (string | null)[] | undefined) ?? [];

  const isProcessing = data.status === "queued" || data.status === "running";
  const hasFilled = mediaIds.some(Boolean);

  const [pickerOpen, setPickerOpen] = useState(false);
  const presetAnchorRef = useRef<HTMLButtonElement>(null);

  const { width, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });
  const { showControls, bind } = useNodeHover(selected);

  function persistPreset(key: MultiviewKey) {
    // Reset any prior generation when the preset changes - angle
    // counts differ between presets and old mediaIds wouldn''t line
    // up with the new angles[] array.
    useBoardStore.getState().updateNodeData(rfId, {
      multiviewPreset: key,
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

  function openGenerate() {
    useGenerationStore.getState().dispatchMultiview(rfId, { preset: presetKey });
  }

  function onCopySheet() {
    if (!mediaIds.length) return;
    const ids = mediaIds.filter((m): m is string => typeof m === "string" && !!m);
    if (ids.length) navigator.clipboard.writeText(ids.join(",")).catch(() => {});
  }

  // Grid columns: 4 -> 2x2, 6 -> 3x2, 8 -> 4x2.
  const cols = angles.length <= 4 ? 2 : angles.length <= 6 ? 3 : 4;

  return (
    <div {...bind}>
      <NodeShell
        Icon={Grid3x3}
        title={data.title || "Multi-view"}
        shortId={data.shortId}
        selected={selected}
        width={width}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: Box, label: "Multi-view output" }}
        targetHandle={{ id: "target", icon: Layers, label: "Concept input" }}
      >
        {/* Angle grid (always visible - it''s the primary content). */}
        {hasFilled || isProcessing ? (
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
        ) : (
          <EmptyState
            Icon={Grid3x3}
            title="Turnaround sheet"
            hint="Pick a layout, connect a Concept, then generate"
          />
        )}

        {/* Reveal bar - hover/selected reveals layout picker + Run. */}
        <RevealBar show={showControls}>
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            <ChipPicker
              ref={presetAnchorRef}
              label="Layout"
              value={preset.label}
              isOpen={pickerOpen}
              onToggle={() => setPickerOpen(!pickerOpen)}
            />
            <span className="text-2xs text-ink-muted">
              {angles.length} angles
            </span>
            {hasFilled && (
              <IconChip icon={Copy} label="Copy media ids" onClick={onCopySheet} />
            )}
          </div>

          <PickerDropdown
            anchorRef={presetAnchorRef}
            isOpen={pickerOpen}
            onClose={() => setPickerOpen(false)}
            items={MULTIVIEW_PRESETS.map((p) => ({
              key: p.key,
              label: p.label,
              hint: `${p.angles.length} angles: ${p.angles.slice(0, 3).join(" / ")}...`,
            }))}
            activeKey={presetKey}
            onPick={(key) => {
              persistPreset(key as MultiviewKey);
              setPickerOpen(false);
            }}
          />

          <div className="flex items-center gap-2">
            <div className="flex-1" />
            <RunButton
              onClick={openGenerate}
              disabled={isProcessing}
              label="Generate turnaround"
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
            failed
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-center px-1" style={{ minHeight: 100 }}>
          <span className="text-[9px] text-ink-placeholder leading-tight text-center break-words">
            {angle}
          </span>
        </div>
      )}

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
        {isRoot && <span className="ml-1 text-[8px]">*</span>}
      </div>
    </button>
  );
}

