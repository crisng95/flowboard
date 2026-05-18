/**
 * ConceptNode — Concepta-fork canonical asset sheet.
 *
 * Backend node type: `concept`. Replaces the legacy `character` node
 * in this fork. Anchors a 3D / game / illustration asset pipeline:
 *   - T-pose for humanoids/creatures/robots
 *   - Orthographic 3/4 for vehicles/buildings
 *   - Centered 3/4 for props/weapons/outfits
 *   - Neutral grey background, 3-point studio lighting
 *
 * Persisted node data (extends FlowboardNodeData):
 *   - `styleKey` (StyleKey)  → which STYLE_PRESETS entry
 *   - `typeKey`  (TypeKey)   → which TYPE_PRESETS entry
 *   - `mediaId` / `aspectRatio` — same as Reference once generated
 *   - `nodeWidth` (number)   → user-resized width (px); falls back to default
 *
 * Auto-prompt synth picks up `styleKey` + `typeKey` server-side
 * (`services/concept/subject.py`) and composes the system prompt
 * accordingly.
 */
import { forwardRef, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Box, Copy, Layers, Play, Sparkles, Upload } from "lucide-react";

import { patchNode } from "../../api/client";
import {
  STYLE_PRESETS,
  TYPE_PRESETS,
  type StyleKey,
  type TypeKey,
} from "../../constants/concept";
import { useBoardStore, type FlowNode, type FlowboardNodeData } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { CaptionRow } from "./shared/CaptionRow";
import { ErrorOverlay } from "./shared/ErrorOverlay";
import { IconChip } from "./shared/IconChip";
import { UploadingOverlay } from "./shared/UploadingOverlay";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { mediaUrl, useUploadFlow } from "./shared/useUploadFlow";

// User resize bounds. Below 240 the toolbar collapses; above 720 the
// card dwarfs the canvas. Persisted as `nodeWidth` on the node data
// blob so it survives reload + board switching.
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 300;

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

  // Picker state — close all dropdowns when one opens. Mutually
  // exclusive so the card's vertical rhythm stays predictable.
  const [pickerOpen, setPickerOpen] = useState<"style" | "type" | null>(null);
  const styleAnchorRef = useRef<HTMLButtonElement>(null);
  const typeAnchorRef = useRef<HTMLButtonElement>(null);

  const userWidth = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;

  function persistChoice(patch: { styleKey?: StyleKey; typeKey?: TypeKey }) {
    useBoardStore.getState().updateNodeData(rfId, patch);
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: patch }).catch(() => {});
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
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }
  function onCopyId() {
    if (mediaId) navigator.clipboard.writeText(mediaId).catch(() => {});
  }

  // Hover state — Magnific pattern: controls reveal on hover/selected.
  const [hovered, setHovered] = useState(false);
  const showControls = hovered || selected || false;

  return (
    <>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <NodeShell
          Icon={Box}
          title={data.title || "Concept"}
          shortId={data.shortId}
          selected={selected}
          width={userWidth}
          status={normaliseStatus(data.status)}
          sourceHandle={{ id: "source", icon: Box, label: "Concept output" }}
          targetHandle={{ id: "target", icon: Layers, label: "Reference inputs" }}
        >
        {/* Media slot — same as before but with w-full h-auto pattern */}
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
            <div className="flex flex-col items-center gap-2 text-ink-muted py-12" style={{ minHeight: 200 }}>
              <Sparkles size={20} className="animate-pulse-soft text-accent" />
              <span className="text-2xs">Generating concept…</span>
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
            <div className="px-4 text-center flex flex-col items-center gap-1.5 py-12" style={{ minHeight: 200 }}>
              <Box size={36} strokeWidth={1.2} className="text-ink-placeholder mb-4" />
              <p className="text-sm font-medium text-ink-primary mb-1">
                Design your concept
              </p>
              <p className="text-2xs text-ink-placeholder">
                Pick a style + type, then generate
              </p>
            </div>
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
                ✓ Uploaded
              </span>
            </div>
          )}
        </div>

        {/* Bottom control bar — hidden by default, reveal on hover.
            Contains Style/Type pickers + Upload/Generate + Run ▶ */}
        <div
          className={cn(
            "transition-all duration-200 overflow-hidden",
            showControls ? "max-h-40 opacity-100 mt-3" : "max-h-0 opacity-0 mt-0",
          )}
        >
          {/* Row 1: Style + Type chips */}
          <div className="flex items-center gap-1.5 mb-2">
            <PickerChipButton
              ref={styleAnchorRef}
              label="Style"
              value={styleLabelText}
              isOpen={pickerOpen === "style"}
              onToggle={() => setPickerOpen(pickerOpen === "style" ? null : "style")}
            />
            <PickerChipButton
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
            onPick={(key) => { persistChoice({ styleKey: key as StyleKey }); setPickerOpen(null); }}
          />
          <PickerDropdown
            anchorRef={typeAnchorRef}
            isOpen={pickerOpen === "type"}
            onClose={() => setPickerOpen(null)}
            items={TYPE_PRESETS.map((t) => ({ key: t.key, label: t.label, hint: t.hint }))}
            activeKey={typeKey}
            onPick={(key) => { persistChoice({ typeKey: key as TypeKey }); setPickerOpen(null); }}
          />

          {/* Row 2: Upload + Generate + Run ▶ */}
          <div className="flex items-center gap-2">
            <IconChip
              icon={Upload}
              label={flow.uploading ? "Uploading…" : "Upload"}
              onClick={flow.pickFile}
              busy={flow.uploading}
              disabled={flow.uploading}
            />
            <div className="flex-1" />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openGenerate(); }}
              disabled={flow.uploading}
              title="Generate concept"
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

        <CaptionRow data={data} bodyState={flow.bodyState} />

        <input
          type="file"
          className="hidden"
          ref={flow.fileInputProps.ref}
          accept={flow.fileInputProps.accept}
          onChange={flow.fileInputProps.onChange}
        />

      {/* DOM-anchored resize handle — pinned to the card body's
          bottom-right corner via absolute positioning. Independent
          of @xyflow/react's internal node dimension tracking, which
          stayed stale on content-sized cards and made the upstream
          NodeResizeControl float off mid-drag. */}
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
      </div>
    </>
  );
}

/* ── Picker chip ──────────────────────────────────────────────────── */

interface PickerChipProps {
  label: string;
  value: string | null | undefined;
  isOpen: boolean;
  onToggle: () => void;
}

const PickerChipButton = forwardRef<HTMLButtonElement, PickerChipProps>(
  function PickerChipButton({ label, value, isOpen, onToggle }, ref) {
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
          className={cn(
            "text-ink-muted transition-transform",
            isOpen && "rotate-180",
          )}
        >
          <path
            d="M1 2.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
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
