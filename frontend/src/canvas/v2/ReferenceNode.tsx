/**
 * ReferenceNode — Concepta-fork rename of VisualAsset.
 *
 * Role in the Concepta pipeline: input layer. Holds a single image
 * (texture sample, sketch, photograph, mood reference) that downstream
 * Concept / Multi-view / Part / Variant nodes consume as a positional
 * `ref_image_N` input.
 *
 * Backend node type: `reference` (registered in `routes/nodes.py`).
 *
 * Compared to the legacy Visual Asset node: same upload + drag-drop +
 * vision auto-brief flow, but presents itself as a ref input rather
 * than a "product to put in a scene". Naming + placeholder copy are
 * the only meaningful differences — the underlying machinery is
 * shared via `useUploadFlow`.
 */
import { Copy, FileImage, Sparkles, Upload, Wand2 } from "lucide-react";
import { type NodeProps } from "@xyflow/react";

import { patchNode } from "../../api/client";
import { useBoardStore } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import type { FlowNode, FlowboardNodeData } from "../../store/board";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { CaptionRow } from "./shared/CaptionRow";
import { ErrorOverlay } from "./shared/ErrorOverlay";
import { IconChip } from "./shared/IconChip";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { ResizeHandle } from "./shared/ResizeHandle";
import { cssAspect, defaultEmptyAspect } from "./shared/aspect";
import { mediaUrl, useUploadFlow } from "./shared/useUploadFlow";

// User resize bounds — see ConceptNode for rationale. Reference cards
// are smaller-default than Concept since their content is auxiliary.
const MIN_WIDTH = 220;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 260;

export function ReferenceNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const flow = useUploadFlow(rfId, data);
  const mediaId = data.mediaId;
  const userWidth = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }
  function onCopyId() {
    if (mediaId) navigator.clipboard.writeText(mediaId).catch(() => {});
  }
  function persistWidth(newWidth: number) {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(newWidth)));
    useBoardStore.getState().updateNodeData(rfId, { nodeWidth: clamped });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { nodeWidth: clamped } }).catch(() => {});
    }
  }

  return (
    <>
      <NodeShell
        Icon={FileImage}
        title={data.title || "Reference"}
        shortId={data.shortId}
        selected={selected}
        width={userWidth}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: FileImage, label: "Reference output" }}
        toolbarLeft={
          <>
            <IconChip
              icon={Upload}
              label={flow.uploading ? "Uploading…" : "Upload reference"}
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
          </>
        }
        toolbarRight={
          mediaId ? (
            <IconChip icon={Copy} label="Copy media id" onClick={onCopyId} />
          ) : null
        }
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
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <img
            src={mediaUrl(mediaId)}
            alt={data.title}
            // object-contain so the user sees the full reference —
            // important for sketches / mood-board collages where edge
            // detail matters. Slot aspect tracks image aspect via
            // parent's `aspectRatio` style, so there's no letterbox.
            className="size-full object-contain animate-fade-in"
            onClick={() => useGenerationStore.getState().openResultViewer(rfId)}
          />
        )}

        {flow.bodyState === "uploading" && <UploadingOverlay />}

        {flow.bodyState === "processing" && (
          <div className="flex flex-col items-center gap-2 text-ink-muted">
            <Sparkles size={18} className="animate-pulse-soft text-accent" />
            <span className="text-2xs">Generating…</span>
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
          <div className="px-4 text-center">
            <p className="text-2xs text-ink-placeholder leading-relaxed">
              Drop a reference image, or use<br />the toolbar above.
            </p>
          </div>
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
              ✓ Uploaded
            </span>
          </div>
        )}
      </div>

      <CaptionRow data={data} bodyState={flow.bodyState} />

      <input
        type="file"
        className="hidden"
        ref={flow.fileInputProps.ref}
        accept={flow.fileInputProps.accept}
        onChange={flow.fileInputProps.onChange}
      />

      {/* DOM-anchored resize handle. Bám card-body corner, không
          phụ thuộc RF's stale dimension tracking. */}
      <ResizeHandle
        minWidth={MIN_WIDTH}
        maxWidth={MAX_WIDTH}
        currentWidth={userWidth}
        onResize={(width) => {
          useBoardStore.getState().updateNodeData(rfId, { nodeWidth: width });
        }}
        onResizeEnd={(width) => {
          persistWidth(width);
        }}
      />
      </NodeShell>
    </>
  );
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
