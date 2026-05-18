/**
 * PartNode — Concepta-fork zoom-isolation card.
 *
 * Backend node type: `part`. Takes a single upstream Concept (or
 * Multi-view tile / another Part) and renders a tight close-up of one
 * region (head / weapon / boots / accessory…). Backend dispatches as
 * a single Flow `edit_image` with the upstream's mediaId as the base
 * + a region-specific prompt template — the result preserves the
 * source's design language while re-cropping and re-lighting on the
 * picked region.
 *
 * Persisted node data:
 *   - `regionKey` (string) → which Part region preset
 *   - `mediaId` / `mediaIds` / `aspectRatio` (filled on dispatch)
 *   - `nodeWidth` (resize)
 *
 * Region presets come from `GET /api/concepta/part-regions` so the
 * canonical list lives backend-side and we don't have to ship a
 * frontend redeploy when adding a new region.
 */
import { useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Crop, Layers, Play, Sparkles } from "lucide-react";

import { getPartRegions, patchNode, type PartRegionDTO } from "../../api/client";
import { useBoardStore, type FlowNode, type FlowboardNodeData } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { CaptionRow } from "./shared/CaptionRow";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { mediaUrl } from "./shared/useUploadFlow";

const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 280;

export function PartNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const userWidth = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;
  const regionKey = (data.regionKey as string | undefined) ?? null;
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";

  // Region picker — fetched once from /api/concepta/part-regions on
  // first render. Lives on the node component so the network call
  // costs once per board mount instead of once per Part node.
  // Cached at module level via the helper below.
  const [regions, setRegions] = useState<PartRegionDTO[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const regionAnchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPartRegionsCached().then((rs) => {
      if (!cancelled) setRegions(rs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const regionLabel = regions.find((r) => r.key === regionKey)?.label ?? null;

  function persistRegion(key: string) {
    useBoardStore.getState().updateNodeData(rfId, { regionKey: key });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { regionKey: key } }).catch(() => {});
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
    if (!regionKey) return;
    useGenerationStore.getState().dispatchPart(rfId, { regionKey });
  }

  // Hover state — controls reveal on hover OR when node is selected.
  const [hovered, setHovered] = useState(false);
  const showControls = hovered || selected || false;

  return (
    <>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <NodeShell
          Icon={Crop}
          title={data.title || "Part"}
          shortId={data.shortId}
          selected={selected}
          width={userWidth}
          status={normaliseStatus(data.status)}
          sourceHandle={{ id: "source", icon: Crop, label: "Part output" }}
          targetHandle={{ id: "target", icon: Layers, label: "Concept / Multi-view input" }}
        >
          {/* Media slot */}
          <div
            style={{ backgroundColor: "#1a1d25" }}
            className={cn(
              "rounded-xl overflow-hidden",
              "flex items-center justify-center relative cursor-pointer",
              "transition-all duration-150",
            )}
            onClick={() => {
              if (mediaId) {
                useGenerationStore.getState().openResultViewer(rfId);
              }
            }}
          >
            {mediaId ? (
              <img
                src={mediaUrl(mediaId)}
                alt={data.title}
                className="w-full h-auto block animate-fade-in rounded-xl"
              />
            ) : isProcessing ? (
              <div className="flex flex-col items-center gap-2 text-ink-muted py-12" style={{ minHeight: 160 }}>
                <Sparkles size={20} className="animate-pulse-soft text-accent" />
                <span className="text-2xs">Isolating part…</span>
              </div>
            ) : (
              <div className="px-4 text-center flex flex-col items-center gap-1.5 py-12" style={{ minHeight: 160 }}>
                <Crop size={28} strokeWidth={1.2} className="text-ink-placeholder mb-2" />
                <p className="text-sm font-medium text-ink-primary mb-1">
                  Isolate a region
                </p>
                <p className="text-2xs text-ink-placeholder">
                  Zoom into a specific part of your concept
                </p>
              </div>
            )}
          </div>

          {/* Bottom control bar — hidden by default, reveal on hover */}
          <div
            className={cn(
              "transition-all duration-200 overflow-hidden",
              showControls ? "max-h-24 opacity-100 mt-3" : "max-h-0 opacity-0 mt-0",
            )}
          >
            <div className="flex items-center gap-2">
              <RegionChip
                ref={regionAnchorRef}
                label="Region"
                value={regionLabel}
                isOpen={pickerOpen}
                onToggle={() => setPickerOpen(!pickerOpen)}
              />

              {/* Spacer */}
              <div className="flex-1" />

              {/* Run button — accent gradient circle */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  generate();
                }}
                disabled={!regionKey || isProcessing}
                title="Generate part"
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

            <PickerDropdown
              anchorRef={regionAnchorRef}
              isOpen={pickerOpen}
              onClose={() => setPickerOpen(false)}
              items={regions.map((r) => ({ key: r.key, label: r.label }))}
              activeKey={regionKey ?? undefined}
              onPick={(key) => {
                persistRegion(key);
                setPickerOpen(false);
              }}
            />
          </div>

          <CaptionRow
            data={data}
            bodyState={
              isProcessing ? "processing" : mediaId ? "filled" : "empty"
            }
          />
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

/* ── Region chip (mirror of ConceptNode's PickerChipButton) ─────── */

interface RegionChipProps {
  label: string;
  value: string | null;
  isOpen: boolean;
  onToggle: () => void;
}

import { forwardRef } from "react";

const RegionChip = forwardRef<HTMLButtonElement, RegionChipProps>(
  function RegionChip({ label, value, isOpen, onToggle }, ref) {
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
          <path d="M1 2.5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
    );
  },
);

/* ── Module-level cache for the regions list ──────────────────────
 * The Part region preset list is small + stable for a session, but
 * each Part node mounts independently. Without a cache we'd hit
 * /api/concepta/part-regions once per Part node; with this we hit
 * it once per page load. The promise itself is cached so concurrent
 * mounts dedupe to a single in-flight fetch. */
let partRegionsCache: Promise<PartRegionDTO[]> | null = null;
function fetchPartRegionsCached(): Promise<PartRegionDTO[]> {
  if (partRegionsCache === null) {
    partRegionsCache = getPartRegions().catch((err) => {
      // Reset on failure so a transient network error doesn't poison
      // the cache for the rest of the session.
      partRegionsCache = null;
      throw err;
    });
  }
  return partRegionsCache;
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
