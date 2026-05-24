/**
 * ConceptNode - Concepta-fork canonical asset sheet.
 *
 * Backend node type: `concept`. Replaces the legacy `character` node
 * in this fork. Anchors a 3D / game / illustration asset pipeline:
 *   - T-pose for humanoids/creatures/robots
 *   - Orthographic 3/4 for vehicles/buildings
 *   - Centered 3/4 for props/weapons/outfits
 *   - Neutral grey background, 3-point studio lighting
 *
 * Persisted node data (extends FlowboardNodeData):
 *   - styleKey (StyleKey)  -> which STYLE_PRESETS entry
 *   - typeKey  (TypeKey)   -> which TYPE_PRESETS entry
 *   - mediaId / aspectRatio - same as Reference once generated
 *   - nodeWidth (number)   -> user-resized width (px)
 *
 * Auto-prompt synth picks up styleKey + typeKey server-side
 * (`services/concept/subject.py`) and composes the system prompt.
 */
import { useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Box, Copy, Layers, Sparkles, Upload } from "lucide-react";

import { patchNode } from "../../api/client";
import {
  STYLE_PRESETS,
  TYPE_PRESETS,
  type StyleKey,
  type TypeKey,
} from "../../constants/concept";
import { useBoardStore, type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { CaptionRow } from "./shared/CaptionRow";
import { ChipPicker } from "./shared/ChipPicker";
import { SettingsButton } from "./shared/SettingsButton";
import { SettingsDrawer } from "./shared/SettingsDrawer";
import { SelectField, TextAreaField } from "./shared/SettingsFields";
import { persistNodeData } from "./shared/persistNodeData";
import { EmptyState } from "./shared/EmptyState";
import { ErrorOverlay } from "./shared/ErrorOverlay";
import { IconChip } from "./shared/IconChip";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { RevealBar } from "./shared/RevealBar";
import { RunButton } from "./shared/RunButton";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { normaliseStatus } from "./shared/status";
import { useNodeHover } from "./shared/useNodeHover";
import { useNodeWidth } from "./shared/useNodeWidth";
import { mediaUrl, useUploadFlow } from "./shared/useUploadFlow";

const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 320;

export function ConceptNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data);
  const mediaId = data.mediaId;

  const styleKey = (data.styleKey as StyleKey | undefined) ?? undefined;
  const typeKey = (data.typeKey as TypeKey | undefined) ?? undefined;
  const styleLabelText = styleKey
    ? STYLE_PRESETS.find((s) => s.key === styleKey)?.label
    : null;
  const typeLabelText = typeKey
    ? TYPE_PRESETS.find((t) => t.key === typeKey)?.label
    : null;

  const [pickerOpen, setPickerOpen] = useState<"style" | "type" | null>(null);
  const styleAnchorRef = useRef<HTMLButtonElement>(null);
  const typeAnchorRef = useRef<HTMLButtonElement>(null);

  const { width, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });
  const { showControls, bind } = useNodeHover(selected);

  function persistChoice(patch: { styleKey?: StyleKey; typeKey?: TypeKey }) {
    useBoardStore.getState().updateNodeData(rfId, patch);
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) patchNode(dbId, { data: patch }).catch(() => {});
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }
  function onCopyId() {
    if (mediaId) navigator.clipboard.writeText(mediaId).catch(() => {});
  }

  return (
    <>
      <div {...bind}>
        <NodeShell
          id={rfId}
          Icon={Box}
          title={data.title || "Concept"}
          shortId={data.shortId}
          selected={selected}
          width={width}
          status={normaliseStatus(data.status)}
          sourceHandle={{ id: "source", icon: Box, label: "Concept output" }}
          targetHandle={{ id: "target", icon: Layers, label: "Reference inputs" }}
        >
          {/* Media slot */}
          <div
            onDrop={flow.onDrop}
            onDragOver={flow.onDragOver}
            onDragLeave={flow.onDragLeave}
            style={{ backgroundColor: "#1a1d25" }}
            data-state={flow.bodyState}
            className={cn(
              "rounded-xl overflow-hidden",
              "flex items-center justify-center relative cursor-pointer",
              "transition-all duration-150",
              flow.dragOver && "ring-2 ring-accent/40",
              flow.bodyState === "uploading" && "ring-2 ring-accent/30",
              flow.bodyState === "error" && "ring-2 ring-red-500/40",
            )}
          >
            {flow.bodyState === "filled" && mediaId && (
              <img
                src={mediaUrl(mediaId)}
                alt={data.title}
                className="w-full h-auto block animate-fade-in"
                onClick={() => useGenerationStore.getState().openResultViewer(rfId)}
              />
            )}

            {flow.bodyState === "uploading" && <UploadingOverlay />}

            {flow.bodyState === "processing" && (
              <div
                className="flex flex-col items-center gap-2 text-ink-muted py-12"
                style={{ minHeight: 200 }}
              >
                <Sparkles size={20} className="animate-pulse-soft text-accent" />
                <span className="text-2xs">Generating concept...</span>
              </div>
            )}

            {flow.bodyState === "error" && flow.error && (
              <ErrorOverlay
                message={flow.error}
                onRetry={flow.pickFile}
                onDismiss={flow.dismissError}
              />
            )}

            {flow.bodyState === "empty" && !flow.dragOver && (
              <EmptyState
                Icon={Box}
                title="Design your concept"
                hint="Pick a style + type, then generate"
              />
            )}
            {flow.bodyState === "empty" && flow.dragOver && (
              <div className="flex flex-col items-center gap-1.5 text-accent py-12">
                <Upload size={18} strokeWidth={1.75} />
                <span className="text-2xs font-medium">Drop to upload</span>
              </div>
            )}

            {flow.uploadJustFinished && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-fade-in">
                <span className="rounded-full bg-status-done/20 backdrop-blur-sm border border-status-done/50 text-status-done text-2xs font-medium px-3 py-1">
                  Uploaded
                </span>
              </div>
            )}
          </div>

          {/* Reveal bar - hover/selected */}
          <RevealBar show={showControls}>
            <div className="flex items-center gap-1.5 mb-2">
              <ChipPicker
                ref={styleAnchorRef}
                label="Style"
                value={styleLabelText}
                isOpen={pickerOpen === "style"}
                onToggle={() => setPickerOpen(pickerOpen === "style" ? null : "style")}
              />
              <ChipPicker
                ref={typeAnchorRef}
                label="Type"
                value={typeLabelText}
                isOpen={pickerOpen === "type"}
                onToggle={() => setPickerOpen(pickerOpen === "type" ? null : "type")}
              />
              {mediaId && (
                <IconChip icon={Copy} label="Copy media id" onClick={onCopyId} />
              )}
            </div>

            <PickerDropdown
              anchorRef={styleAnchorRef}
              isOpen={pickerOpen === "style"}
              onClose={() => setPickerOpen(null)}
              items={STYLE_PRESETS.map((s) => ({ key: s.key, label: s.label, hint: s.hint }))}
              activeKey={styleKey}
              onPick={(key) => {
                persistChoice({ styleKey: key as StyleKey });
                setPickerOpen(null);
              }}
            />
            <PickerDropdown
              anchorRef={typeAnchorRef}
              isOpen={pickerOpen === "type"}
              onClose={() => setPickerOpen(null)}
              items={TYPE_PRESETS.map((t) => ({ key: t.key, label: t.label, hint: t.hint }))}
              activeKey={typeKey}
              onPick={(key) => {
                persistChoice({ typeKey: key as TypeKey });
                setPickerOpen(null);
              }}
            />

            <div className="flex items-center gap-2">
              <IconChip
                icon={Upload}
                label={flow.uploading ? "Uploading..." : "Upload"}
                onClick={flow.pickFile}
                busy={flow.uploading}
                disabled={flow.uploading}
              />
              <div className="flex-1" />
              <SettingsButton nodeId={rfId} label="Concept settings" />
              <RunButton
                onClick={openGenerate}
                disabled={flow.uploading}
                label="Generate concept"
                busy={data.status === "running"}
              />
            </div>
          </RevealBar>

          <CaptionRow data={data} bodyState={flow.bodyState} />

          <input
            type="file"
            className="hidden"
            ref={flow.fileInputProps.ref}
            accept={flow.fileInputProps.accept}
            onChange={flow.fileInputProps.onChange}
          />

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
          title="Concept settings"
          hint="Override aspect ratio + add a custom system prompt note for power users."
        >
          <SelectField<string>
            label="Aspect ratio"
            value={(data.aspectRatioOverride as string | undefined) ?? "auto"}
            options={[
              { value: "auto", label: "Auto (use canvas default)" },
              { value: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "Portrait 3:4" },
              { value: "IMAGE_ASPECT_RATIO_SQUARE", label: "Square 1:1" },
              { value: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "Landscape 4:3" },
            ]}
            onChange={(next) => persistNodeData(rfId, { aspectRatioOverride: next === "auto" ? null : next })}
            hint="Auto picks portrait for characters, square for props."
          />
          <TextAreaField
            label="Custom system prompt"
            value={(data.customSystemPrompt as string | undefined) ?? ""}
            onChange={(next) => persistNodeData(rfId, { customSystemPrompt: next || null })}
            placeholder="Optional. Appended to the auto-prompt - e.g. extra style notes, anatomy hints."
            rows={4}
            hint="Backend wiring lands in a follow-up; the value persists today."
          />
        </SettingsDrawer>
      </div>
    </>
  );
}


