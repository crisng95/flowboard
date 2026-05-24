/**
 * ReferenceNode - Concepta-fork rename of VisualAsset.
 *
 * Role in the Concepta pipeline: input layer. Holds a single image
 * (texture sample, sketch, photograph, mood reference) that downstream
 * Concept / Multi-view / Part / Variant nodes consume as a positional
 * `ref_image_N` input.
 *
 * Backend node type: `reference` (registered in `routes/nodes.py`).
 *
 * UI pattern (locked Concepta v1):
 *   - Hover/selected reveal bottom bar (Magnific). Card stays clean
 *     when idle; controls slide in on intent. Mirrors Concept / Part /
 *     Variant for a single mental model across all node types.
 *   - Toolbar contents: Upload + Generate-from-prompt (no picker).
 */
import { Copy, FileImage, Sparkles, Upload, Wand2 } from "lucide-react";
import { type NodeProps } from "@xyflow/react";

import { type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { CaptionRow } from "./shared/CaptionRow";
import { EmptyState } from "./shared/EmptyState";
import { ErrorOverlay } from "./shared/ErrorOverlay";
import { IconChip } from "./shared/IconChip";
import { ResizeHandle } from "./shared/ResizeHandle";
import { SettingsButton } from "./shared/SettingsButton";
import { SettingsDrawer } from "./shared/SettingsDrawer";
import { TextAreaField } from "./shared/SettingsFields";
import { persistNodeData } from "./shared/persistNodeData";
import { RevealBar } from "./shared/RevealBar";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { cssAspect, defaultEmptyAspect } from "./shared/aspect";
import { normaliseStatus } from "./shared/status";
import { useNodeHover } from "./shared/useNodeHover";
import { useNodeWidth } from "./shared/useNodeWidth";
import { mediaUrl, useUploadFlow } from "./shared/useUploadFlow";

const MIN_WIDTH = 220;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 260;

export function ReferenceNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data);
  const mediaId = data.mediaId;

  const { width, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });
  const { showControls, bind } = useNodeHover(selected);

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }
  function onCopyId() {
    if (mediaId) navigator.clipboard.writeText(mediaId).catch(() => {});
  }

  return (
    <div {...bind}>
      <NodeShell
        id={rfId}
        Icon={FileImage}
        title={data.title || "Reference"}
        shortId={data.shortId}
        selected={selected}
        width={width}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: FileImage, label: "Reference output" }}
      >
        <div
          onDrop={flow.onDrop}
          onDragOver={flow.onDragOver}
          onDragLeave={flow.onDragLeave}
          style={{
            backgroundColor: "#1a1d25",
            aspectRatio: mediaId
              ? cssAspect(data.aspectRatio, defaultEmptyAspect("reference"))
              : defaultEmptyAspect("reference"),
          }}
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
              className="size-full object-contain animate-fade-in"
              onClick={() => useGenerationStore.getState().openResultViewer(rfId)}
            />
          )}

          {flow.bodyState === "uploading" && <UploadingOverlay />}

          {flow.bodyState === "processing" && (
            <div className="flex flex-col items-center gap-2 text-ink-muted">
              <Sparkles size={18} className="animate-pulse-soft text-accent" />
              <span className="text-2xs">Generating...</span>
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
              Icon={FileImage}
              title="Drop a reference"
              hint="Or hover the card for actions"
              minHeight={140}
            />
          )}
          {flow.bodyState === "empty" && flow.dragOver && (
            <div className="flex flex-col items-center gap-1.5 text-accent">
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

        {/* Reveal bar - hover/selected reveals Upload + Generate. */}
        <RevealBar show={showControls}>
          <div className="flex items-center gap-2">
            <IconChip
              icon={Upload}
              label={flow.uploading ? "Uploading..." : "Upload reference"}
              onClick={flow.pickFile}
              busy={flow.uploading}
              disabled={flow.uploading}
            />
            <IconChip
              icon={Wand2}
              label="Generate from prompt"
              onClick={openGenerate}
              disabled={flow.uploading}
            />
            {mediaId && (
              <IconChip icon={Copy} label="Copy media id" onClick={onCopyId} />
            )}
            <div className="flex-1" />
            <SettingsButton nodeId={rfId} label="Reference settings" />
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
        />
      </NodeShell>

      <SettingsDrawer
        nodeId={rfId}
        title="Reference settings"
        hint="Add notes that downstream Concept / Multi-view nodes will see when composing prompts."
      >
        <TextAreaField
          label="Custom note"
          value={(data.customNote as string | undefined) ?? ""}
          onChange={(next) => persistNodeData(rfId, { customNote: next || null })}
          placeholder="Optional. e.g. style intent, era, palette intent. Picked up by downstream auto-prompt."
          rows={3}
          hint="Backend pickup ships in a follow-up; the value persists today."
        />
      </SettingsDrawer>
    </div>
  );
}


