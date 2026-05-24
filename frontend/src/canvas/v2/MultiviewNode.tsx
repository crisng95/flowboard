/**
 * MultiviewNode - Concepta-fork orthographic turnaround sheet (v1.5).
 *
 * Backend node type: `multiview`. Takes a single upstream Concept node
 * and produces ONE multi-panel character sheet image - the panels are
 * baked into a single Flow gen_image output, side by side. Tile
 * extraction (cropping the sheet into N standalone view images) is a
 * separate downstream node fed by this sheet output.
 *
 * Persisted node data:
 *   - multiviewPreset (key) -> "4view" / "prop_4view" / future presets
 *   - sheetMediaId   (str)  -> the Phase-1 sheet image id (also stored
 *                              as mediaId for board-level previews)
 *   - mediaId        (str)  -> mirror of sheetMediaId so the rest of
 *                              the canvas (downstream nodes, viewers)
 *                              treats this node like any other media-
 *                              bearing node.
 *   - angles         (str[]) -> labels in preset order, surfaced for
 *                               the future tile-extract node.
 *   - nodeWidth      (num)   -> user-resized width.
 *
 * UI: hover/selected reveal bar with Layout chip + SettingsButton +
 * Run; settings drawer carries the custom system prompt override.
 */
import { useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Copy, Grid3x3, Layers, Sparkles } from "lucide-react";

import { mediaUrl as apiMediaUrl, patchNode } from "../../api/client";
import { useBoardStore, type FlowNode } from "../../store/board";
import { MULTIVIEW_PRESETS, type MultiviewKey } from "../../constants/concept";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { ChipPicker } from "./shared/ChipPicker";
import { EmptyState } from "./shared/EmptyState";
import { SettingsButton } from "./shared/SettingsButton";
import { SettingsDrawer } from "./shared/SettingsDrawer";
import { TextAreaField } from "./shared/SettingsFields";
import { persistNodeData } from "./shared/persistNodeData";
import { IconChip } from "./shared/IconChip";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { RevealBar } from "./shared/RevealBar";
import { RunButton } from "./shared/RunButton";
import { normaliseStatus } from "./shared/status";
import { useNodeHover } from "./shared/useNodeHover";
import { useNodeWidth } from "./shared/useNodeWidth";

const MIN_WIDTH = 280;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 480;

export function MultiviewNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;

  const presetKey = (data.multiviewPreset as MultiviewKey | undefined) ?? "4view";
  const preset =
    MULTIVIEW_PRESETS.find((p) => p.key === presetKey) ?? MULTIVIEW_PRESETS[0];
  const angles = (data.angles as string[] | undefined) ?? preset.angles.slice();

  // Sheet output. Falls back to legacy `mediaId` so existing v1 boards
  // (where the sheet was stored under mediaId only) keep rendering.
  const sheetMediaId =
    (data.sheetMediaId as string | undefined) ??
    (data.mediaId as string | undefined) ??
    null;

  const isProcessing = data.status === "queued" || data.status === "running";

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
    // Changing the preset invalidates any cached sheet because the
    // panel set differs. Clearing here so the previous render does
    // not get confused with the new layout.
    useBoardStore.getState().updateNodeData(rfId, {
      multiviewPreset: key,
      sheetMediaId: undefined,
      mediaId: undefined,
      angles: undefined,
    });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, {
        data: {
          multiviewPreset: key,
          sheetMediaId: null,
          mediaId: null,
          angles: null,
        },
      }).catch(() => {});
    }
  }

  function openGenerate() {
    useGenerationStore.getState().dispatchMultiview(rfId, { preset: presetKey });
  }

  function onCopySheetId() {
    if (sheetMediaId) {
      navigator.clipboard.writeText(sheetMediaId).catch(() => {});
    }
  }

  return (
    <div {...bind}>
      <NodeShell
        id={rfId}
        Icon={Grid3x3}
        title={data.title || "Multi-view"}
        shortId={data.shortId}
        selected={selected}
        width={width}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: Grid3x3, label: "Sheet output" }}
        targetHandle={{ id: "target", icon: Layers, label: "Concept input" }}
      >
        {sheetMediaId ? (
          <div
            className={cn(
              "rounded-xl overflow-hidden cursor-pointer",
              "border border-line-subtle hover:border-line-strong transition-all",
            )}
            style={{ backgroundColor: "#15171d" }}
            onClick={() => useGenerationStore.getState().openResultViewer(rfId)}
          >
            <img
              src={apiMediaUrl(sheetMediaId)}
              alt={`${preset.label} sheet`}
              className="w-full h-auto block animate-fade-in"
            />
          </div>
        ) : isProcessing ? (
          <div
            className="flex flex-col items-center justify-center text-center py-12 gap-2"
            style={{ minHeight: 200 }}
          >
            <Sparkles size={20} className="animate-pulse-soft text-accent" />
            <span className="text-2xs text-ink-muted">Generating sheet...</span>
          </div>
        ) : (
          <EmptyState
            Icon={Grid3x3}
            title="Turnaround sheet"
            hint="Pick a layout, connect a Concept, then generate"
          />
        )}

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
            {sheetMediaId && (
              <IconChip
                icon={Copy}
                label="Copy sheet media id"
                onClick={onCopySheetId}
              />
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
            <SettingsButton nodeId={rfId} label="Multi-view settings" />
            <RunButton
              onClick={openGenerate}
              disabled={isProcessing}
              label="Generate sheet"
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
            forceVisible={!!selected}
          />
      </NodeShell>

      <SettingsDrawer
        nodeId={rfId}
        title="Multi-view settings"
        hint="This node generates the multi-panel character sheet only. Tile extraction is a separate downstream node."
      >
        <TextAreaField
          label="Custom system prompt"
          value={(data.customSystemPrompt as string | undefined) ?? ""}
          onChange={(next) =>
            persistNodeData(rfId, { customSystemPrompt: next || null })
          }
          placeholder="Optional. Appended to the sheet prompt - e.g. extra style notes, lighting overrides, anatomy hints."
          rows={4}
          hint="Backend pickup ships in a follow-up; the value persists today."
        />
      </SettingsDrawer>
    </div>
  );
}