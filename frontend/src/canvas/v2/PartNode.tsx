/**
 * PartNode - Concepta-fork zoom-isolation card.
 *
 * Backend node type: `part`. Takes a single upstream Concept (or
 * Multi-view tile / another Part) and renders a tight close-up of one
 * region (head / weapon / boots / accessory). Backend dispatches as
 * a single Flow `edit_image` with the upstream''s mediaId as the base
 * + a region-specific prompt template - the result preserves the
 * source''s design language while re-cropping and re-lighting on the
 * picked region.
 *
 * Persisted node data:
 *   - regionKey (string) -> which Part region preset
 *   - mediaId / mediaIds / aspectRatio (filled on dispatch)
 *   - nodeWidth (resize)
 *
 * Region presets come from `GET /api/concepta/part-regions`.
 *
 * UI pattern (locked Concepta v1):
 *   - Hover/selected reveal bottom bar (Magnific). Mirrors Concept /
 *     Reference / Multi-view / Variant.
 */
import { useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { Crop, Layers, Sparkles } from "lucide-react";

import { getPartRegions, patchNode, type PartRegionDTO } from "../../api/client";
import { useBoardStore, type FlowNode } from "../../store/board";
import { useGenerationStore } from "../../store/generation";
import { cn } from "../../lib/utils";
import { NodeShell } from "./NodeShell";
import { CaptionRow } from "./shared/CaptionRow";
import { ChipPicker } from "./shared/ChipPicker";
import { SettingsButton } from "./shared/SettingsButton";
import { SettingsDrawer } from "./shared/SettingsDrawer";
import { TextAreaField } from "./shared/SettingsFields";
import { persistNodeData } from "./shared/persistNodeData";
import { EmptyState } from "./shared/EmptyState";
import { PickerDropdown } from "./shared/PickerDropdown";
import { ResizeHandle } from "./shared/ResizeHandle";
import { RevealBar } from "./shared/RevealBar";
import { RunButton } from "./shared/RunButton";
import { normaliseStatus } from "./shared/status";
import { useNodeHover } from "./shared/useNodeHover";
import { useNodeWidth } from "./shared/useNodeWidth";
import { mediaUrl } from "./shared/useUploadFlow";

const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 280;

export function PartNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const regionKey = (data.regionKey as string | undefined) ?? null;
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";

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

  const { width, onResize, onResizeEnd } = useNodeWidth({
    nodeId: rfId,
    data,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: DEFAULT_WIDTH,
  });
  const { showControls, bind } = useNodeHover(selected);

  function persistRegion(key: string) {
    useBoardStore.getState().updateNodeData(rfId, { regionKey: key });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, { data: { regionKey: key } }).catch(() => {});
    }
  }

  function generate() {
    if (!regionKey) return;
    useGenerationStore.getState().dispatchPart(rfId, { regionKey });
  }

  return (
    <div {...bind}>
      <NodeShell
        Icon={Crop}
        title={data.title || "Part"}
        shortId={data.shortId}
        selected={selected}
        width={width}
        status={normaliseStatus(data.status)}
        sourceHandle={{ id: "source", icon: Crop, label: "Part output" }}
        targetHandle={{
          id: "target",
          icon: Layers,
          label: "Concept / Multi-view input",
        }}
      >
        <div
          style={{ backgroundColor: "#1a1d25" }}
          className={cn(
            "rounded-xl overflow-hidden",
            "flex items-center justify-center relative cursor-pointer",
            "transition-all duration-150",
          )}
          onClick={() => {
            if (mediaId) useGenerationStore.getState().openResultViewer(rfId);
          }}
        >
          {mediaId ? (
            <img
              src={mediaUrl(mediaId)}
              alt={data.title}
              className="w-full h-auto block animate-fade-in rounded-xl"
            />
          ) : isProcessing ? (
            <div
              className="flex flex-col items-center gap-2 text-ink-muted py-12"
              style={{ minHeight: 160 }}
            >
              <Sparkles size={20} className="animate-pulse-soft text-accent" />
              <span className="text-2xs">Isolating part...</span>
            </div>
          ) : (
            <EmptyState
              Icon={Crop}
              title="Isolate a region"
              hint="Zoom into a specific part of your concept"
              minHeight={160}
            />
          )}
        </div>

        <RevealBar show={showControls}>
          <div className="flex items-center gap-2">
            <ChipPicker
              ref={regionAnchorRef}
              label="Region"
              value={regionLabel}
              isOpen={pickerOpen}
              onToggle={() => setPickerOpen(!pickerOpen)}
            />
            <div className="flex-1" />
            <SettingsButton nodeId={rfId} label="Part settings" />
            <RunButton
              onClick={generate}
              disabled={!regionKey || isProcessing}
              label="Generate part"
              busy={isProcessing}
            />
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
        </RevealBar>

        <CaptionRow
          data={data}
          bodyState={
            isProcessing ? "processing" : mediaId ? "filled" : "empty"
          }
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
        title="Part settings"
        hint="Override the region prompt with extra notes specific to this Part."
      >
        <TextAreaField
          label="Custom system prompt"
          value={(data.customSystemPrompt as string | undefined) ?? ""}
          onChange={(next) => persistNodeData(rfId, { customSystemPrompt: next || null })}
          placeholder="Optional. Appended to the region template - e.g. zoom level, lighting, material focus."
          rows={3}
          hint="Backend pickup ships in a follow-up; the value persists today."
        />
      </SettingsDrawer>
    </div>
  );
}

/**
 * Module-level cache for the regions list. Each Part node mounts
 * independently; without this cache we''d hit /api/concepta/part-regions
 * once per Part node. The promise itself is cached so concurrent mounts
 * dedupe to a single in-flight fetch. Reset on failure so a transient
 * network error doesn''t poison the cache for the rest of the session.
 */
let partRegionsCache: Promise<PartRegionDTO[]> | null = null;
function fetchPartRegionsCached(): Promise<PartRegionDTO[]> {
  if (partRegionsCache === null) {
    partRegionsCache = getPartRegions().catch((err) => {
      partRegionsCache = null;
      throw err;
    });
  }
  return partRegionsCache;
}

