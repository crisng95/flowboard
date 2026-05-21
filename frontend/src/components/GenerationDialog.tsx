import { useEffect, useRef, useState } from "react";
import {
  useGenerationStore,
  REF_DISPATCH_TYPES,
  isMaterialRefDemoted,
  targetHasStructuralRef,
} from "../store/generation";
import { useBoardStore } from "../store/board";
import {
  autoPrompt as autoPromptApi,
  autoPromptBatch as autoPromptBatchApi,
  mediaUrl,
  patchEdge,
  patchNode,
} from "../api/client";
import {
  useSettingsStore,
  OMNI_FLASH_CREDIT_COST,
  OMNI_FLASH_DURATIONS,
  type OmniFlashDuration,
  type VideoQuality,
} from "../store/settings";

// Use the same dispatch set as `collectUpstreamRefMediaIds` so the
// chip preview lists every ref that will actually be sent to Flow,
// including `add_reference` nodes that the burn-and-bake rule may
// later filter out below.
const REF_SOURCE_TYPES = REF_DISPATCH_TYPES;

const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR", label: "3:4" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE", label: "4:3" },
] as const;

const VIDEO_ASPECT_RATIOS = [
  { key: "VIDEO_ASPECT_RATIO_LANDSCAPE", label: "16:9 landscape" },
  { key: "VIDEO_ASPECT_RATIO_PORTRAIT", label: "9:16 portrait" },
] as const;

// Camera movement presets for video.
// - `static` (default): locked-off, no zoom/pan — best for e-commerce
//   product showcase since it keeps the product fully framed.
// - `dynamic`: no camera constraint — the auto-prompt synthesiser is free
//   to suggest dolly / pan / etc. as it sees fit. Empty instruction → no
//   constraint string appended to the final prompt either.
const CAMERA_MOVEMENTS = [
  {
    key: "static",
    label: "Static",
    instruction:
      "Camera: locked-off static frame, no zoom and no pan. Keep the full "
      + "subject and any product clearly visible in the frame for the "
      + "entire clip. Background and crop must not change.",
  },
  {
    key: "dynamic",
    label: "Dynamic",
    instruction: "",
  },
] as const;

type CameraKey = (typeof CAMERA_MOVEMENTS)[number]["key"];

type VeoChip = {
  kind: "veo";
  quality: VideoQuality;
  label: string;
  ultraOnly: boolean;
};
type OmniChip = { kind: "omni"; label: string };
type VideoModelChip = VeoChip | OmniChip;

const VIDEO_MODEL_CHIPS: readonly VideoModelChip[] = [
  { kind: "veo", quality: "lite", label: "Veo 3.1 Lite", ultraOnly: false },
  { kind: "veo", quality: "fast", label: "Veo 3.1 Fast", ultraOnly: false },
  { kind: "veo", quality: "quality", label: "Veo 3.1 Quality", ultraOnly: false },
  { kind: "veo", quality: "lite_relaxed", label: "Veo 3.1 Lite (Low Priority)", ultraOnly: true },
  { kind: "omni", label: "Omni Flash" },
];

function cameraInstruction(key: CameraKey): string {
  return CAMERA_MOVEMENTS.find((c) => c.key === key)?.instruction ?? "";
}

type ImageAspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
type VideoAspectKey = (typeof VIDEO_ASPECT_RATIOS)[number]["key"];
type AspectKey = ImageAspectKey | VideoAspectKey;

// Map an upstream image aspect onto the closest video aspect. Square has
// no direct video equivalent — fall back to portrait per the
// "default-to-9:16 on mismatch" rule.
function imageAspectToVideo(img: string | undefined): VideoAspectKey | null {
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE") return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  if (img === "IMAGE_ASPECT_RATIO_PORTRAIT") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  if (img === "IMAGE_ASPECT_RATIO_SQUARE") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  // Video has no 4:3 / 3:4 enum, so we collapse to the closest
  // 16:9 / 9:16 bucket. The image asset itself stays at the original
  // ratio; only the video gen request swaps to a video-compatible
  // enum.
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE") return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  if (img === "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  return null;
}

// Walk upstream of the target node, collect each upstream's aspectRatio,
// then apply the user's rule:
//   • single distinct aspect → match it
//   • multiple distinct aspects → fall back to 9:16
//   • zero upstream / unknown → caller's default
function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: ReturnType<typeof useBoardStore.getState>["nodes"],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  // Image (and character — though character has its own opinionated
  // default; the caller short-circuits before reaching here).
  const validImg = upstreamAspects.filter((a): a is ImageAspectKey =>
    IMAGE_ASPECT_RATIOS.some((p) => p.key === a),
  );
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      className="gen-dialog__info-tip"
      title={tip}
      aria-label={tip}
      role="img"
    >
      (i)
    </span>
  );
}

export function GenerationDialog() {
  const openDialog = useGenerationStore((s) => s.openDialog);
  const closeGenerationDialog = useGenerationStore((s) => s.closeGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);

  const [prompt, setPrompt] = useState(openDialog.prompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("static");

  // Auto-prompt state — set when the user submits an empty prompt and we
  // synthesise one from upstream context. Surfaced as a small ✨ badge.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);

  // Per-variant selection for multi-source i2v. Default: all selected.
  // Stored as a Set of indices so the UI can toggle individual variants
  // and "All / None" without juggling parallel arrays.
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<Set<number>>(new Set());
  // Tracks which Source-Reference chip's variant picker is currently
  // open. Holds the edge id the picker is anchored to (one open at a
  // time). Click another chip → swap; click the same chip → close;
  // click outside (handled inline) → close.
  const [openVariantPicker, setOpenVariantPicker] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const rfId = openDialog.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = nodes.length;
  const edges = useBoardStore((s) => s.edges);

  // Hooks MUST be called unconditionally on every render — pull
  // videoModel out first, derive the boolean after.
  const videoModelFamily = useSettingsStore((s) => s.videoModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const omniFlashDuration = useSettingsStore((s) => s.omniFlashDuration);
  const setOmniFlashDuration = useSettingsStore((s) => s.setOmniFlashDuration);
  const paygateTier = useGenerationStore((s) => s.paygateTier);
  const targetType = (node?.data.type as string | undefined) ?? "reference";
  const isVideo = targetType === "video";
  const isCharacter = targetType === "character";
  const isStoryboard = targetType === "Storyboard";
  // Omni Flash is a video model but with image-target semantics: it
  // takes ingredients (multi reference images), NOT a single i2v start
  // frame. So the dialog should show the same "Source references" chip
  // list that image targets use, and hide Veo's source-image selector.
  const isOmniVideo = isVideo && videoModelFamily === "omni_flash";
  // Prompt nodes are text-only — clicking Generate runs auto_prompt
  // synthesis from upstream context and writes the result back to
  // node.data.prompt. No image dispatch, no aspect/variants.
  const isPrompt = targetType === "prompt";

  // Find upstream source image for video nodes. When the upstream has
  // multiple variants, we batch-i2v one video per variant — `sourceMediaIds`
  // captures the full set; `sourceMediaId` is the active variant for the
  // legacy single-source path.
  const sourceEdge = isVideo ? edges.find((e) => e.target === rfId) : undefined;
  const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : undefined;
  const sourceMediaId = sourceNode?.data.mediaId ?? null;
  // Drop null placeholders from the upstream variant list — partial-
  // batch results may carry them, but downstream dispatch needs a
  // dense array of valid mediaIds to feed into Flow.
  const sourceMediaIds: string[] = isVideo
    ? (sourceNode?.data.mediaIds ?? (sourceMediaId ? [sourceMediaId] : []))
        .filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];

  // Image nodes: list every upstream ref edge feeding this target. We
  // walk edges (not just nodes) so we can read each edge's variant pin
  // and show the EXACT thumbnail Flow will receive — when an edge is
  // pinned to variant 2 of a 4-variant source, the chip shows variant 2,
  // not the source's "active" mediaId. Mirrors the resolution used by
  // `collectUpstreamRefMediaIds` at dispatch time so the preview can't
  // diverge from the actual API call.
  //
  // We also surface the full `allVariants` list + the edge id so the
  // chip can offer a per-source variant picker without re-querying
  // the store on click.
  // Prompt sources — text-only upstream nodes whose `prompt` feeds the
  // auto-prompt synth as context. They have no mediaId so they live in a
  // separate list from refSourceNodes; the dialog renders them as a
  // text-only chip alongside image refs so the user can SEE that a
  // Prompt node is influencing the gen.
  const promptSourceNodes = (!isVideo || isOmniVideo) && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || (n.data.type as string) !== "prompt") return null;
          const text = typeof n.data.prompt === "string" ? n.data.prompt : "";
          return { edgeId: e.id, node: n, text };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  const refSourceNodes = (!isVideo || isOmniVideo) && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || !REF_SOURCE_TYPES.has(n.data.type)) return null;
          // Burn-and-bake: when at least one structural `add_reference`
          // is upstream, the dispatcher drops every material
          // `add_reference` from `ref_media_ids`. Hide them in the
          // chip preview too so the UI matches what Flow receives.
          // The directive lives in the auto-prompt text instead.
          if (rfId && isMaterialRefDemoted(n, targetHasStructuralRef(rfId))) return null;
          const variants = (Array.isArray(n.data.mediaIds) ? n.data.mediaIds : [])
            .filter((m): m is string => typeof m === "string" && m.length > 0);
          const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
          let mediaId: string | undefined;
          let variantIdx: number | null = null;
          if (pin !== null && pin >= 0 && pin < variants.length) {
            mediaId = variants[pin];
            variantIdx = pin;
          } else if (typeof n.data.mediaId === "string" && n.data.mediaId) {
            mediaId = n.data.mediaId;
            // When dispatch falls back to source.mediaId, that's
            // typically variants[0] (gen-result writes mediaId =
            // mediaIds[0]). Surface that as the displayed variantIdx
            // so the chip's badge matches what Flow will receive,
            // even before the user clicks to pin explicitly.
            const idx = variants.indexOf(n.data.mediaId);
            variantIdx = idx >= 0 ? idx : null;
          } else if (variants.length > 0) {
            mediaId = variants[0];
            variantIdx = 0;
          }
          if (!mediaId) return null;
          return {
            edgeId: e.id,
            node: n,
            mediaId,
            variantIdx,
            allVariants: variants,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      setPrompt(openDialog.prompt);
      const openNode = nodes.find((n) => n.id === rfId);
      const openNodeType = (openNode?.data.type as string | undefined) ?? "reference";
      // Character → always 1:1 portrait headshot (its own opinionated
      // default; ignores upstream aspect because character is the source).
      // Image / video → match upstream aspect when available; fall back to
      // landscape (image) / landscape (video) when the graph has no info.
      let nextAspect: AspectKey;
      const inherited = pickDefaultAspect(
        rfId,
        openNodeType,
        nodes,
        useBoardStore.getState().edges,
      );
      if (inherited !== null) {
        nextAspect = inherited;
      } else if (openNodeType === "video") {
        nextAspect = "VIDEO_ASPECT_RATIO_LANDSCAPE";
      } else {
        nextAspect = "IMAGE_ASPECT_RATIO_LANDSCAPE";
      }
      setAspectRatio(nextAspect);
      setVariants(1);
      setCamera("static");
      setAutoBuilding(false);
      setAutoPromptUsed(false);
      // Default-select every upstream source variant for video targets so
      // the user just hits Generate when they want all videos.
      const upstreamEdge = useBoardStore
        .getState()
        .edges.find((e) => e.target === rfId);
      const upstreamNode = upstreamEdge
        ? useBoardStore.getState().nodes.find((n) => n.id === upstreamEdge.source)
        : undefined;
      const ups =
        upstreamNode?.data.mediaIds ??
        (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);
      setSelectedSourceIdx(new Set(ups.map((_, i) => i)));
      triggerRef.current = document.activeElement;
      // Focus textarea on open
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    } else {
      // Return focus on close
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfId]);

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC closes the variant picker first if open, otherwise the
        // dialog. Lets the user back out of a stray picker click
        // without losing their prompt + form state.
        if (openVariantPicker !== null) {
          e.preventDefault();
          setOpenVariantPicker(null);
          return;
        }
        e.preventDefault();
        closeGenerationDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Click-outside to close the variant picker. We listen on
  // `mousedown` instead of `click` so the close fires BEFORE the chip's
  // `onClick` toggle would otherwise re-open it on the same gesture.
  // A click that lands inside any `.ref-source-chip-wrap` is ignored —
  // chip-internal handlers (toggle / swap / pick) own those.
  useEffect(() => {
    if (openVariantPicker === null) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".ref-source-chip-wrap")) return;
      setOpenVariantPicker(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openVariantPicker]);

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

  if (rfId === null) return null;

  /** Pick a different variant on a Source Reference chip. PATCHes the
   * edge so the dispatch path picks the new variant, then mirrors the
   * change into the local store so the chip thumbnail updates without
   * waiting for a board refresh. The pick also surfaces on the canvas
   * via the `v{N}` chip on the edge. */
  async function pickVariantForEdge(edgeId: string, variantIdx: number) {
    setOpenVariantPicker(null);
    const edgeDbId = parseInt(edgeId, 10);
    if (isNaN(edgeDbId)) return;
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleSubmit() {
    if (!rfId) return;
    // Defense in depth — block submit if the LLM layer is still composing
    // for this node from a prior dialog session. The Generate button is
    // already `disabled` at this point, but the user could still trigger
    // ⌘↵ via keyboard.
    if (
      node?.data.autoPromptStatus === "pending"
      || node?.data.aiBriefStatus === "pending"
    ) {
      return;
    }
    if (isPrompt) {
      // Prompt nodes are user-authored seed text. The dialog is just
      // an editor — Save persists whatever the user typed (or cleared).
      // No auto-synth, no image/video dispatch. Downstream image/video
      // nodes pick up this prompt as upstream context at their own
      // dispatch time.
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        closeGenerationDialog();
        return;
      }
      const finalPrompt = prompt;
      useBoardStore.getState().updateNodeData(rfId, {
        prompt: finalPrompt,
        status: finalPrompt.trim() ? "done" : "idle",
      });
      patchNode(dbId, {
        status: finalPrompt.trim() ? "done" : "idle",
        data: { prompt: finalPrompt },
      }).catch(() => {});
      closeGenerationDialog();
      return;
    }
    // Image / video branch — if user left the prompt blank, synthesise
    // from upstream briefs (composition prompt for image, motion prompt
    // for video) before dispatching. For image with variants > 1 use the
    // batch endpoint so each variant gets its own pose-distinct prompt.
    let finalPrompt = prompt;
    let perVariantPrompts: string[] | undefined;
    if (!finalPrompt.trim()) {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        return;
      }
      setAutoBuilding(true);
      // Mark the target node as "auto-prompt running" so the canvas
      // can render a busy treatment + block duplicate dispatches on
      // the same node. Cleared in finally below regardless of outcome.
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
      try {
        if (!isVideo && variants > 1) {
          const res = await autoPromptBatchApi(dbId, variants);
          perVariantPrompts = res.prompts;
          // Show all N prompts joined so the user can verify before
          // dispatch — we don't dispatch until they re-click Generate
          // (so they see what was synthesised first time around either)…
          // actually simpler: dispatch immediately with the first as the
          // "display" prompt; full per-variant list goes through opts.
          finalPrompt = res.prompts[0] ?? "";
          setPrompt(res.prompts.join("\n\n— variant —\n\n"));
        } else {
          const res = await autoPromptApi(dbId, isVideo ? { camera } : undefined);
          finalPrompt = res.prompt;
          setPrompt(finalPrompt);
        }
        setAutoPromptUsed(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      } catch (err) {
        setAutoBuilding(false);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "failed" });
        useGenerationStore.setState({
          error: err instanceof Error
            ? `Auto-prompt failed: ${err.message}`
            : "Auto-prompt failed",
        });
        return;
      }
      setAutoBuilding(false);
    }
    if (isVideo) {
      // Append the camera-movement constraint to whatever motion prompt
      // we have (manual or auto-synthesised). Putting it last makes it
      // the dominant instruction the model resolves against — overrides
      // any conflicting "slow dolly-in" the synthesizer might have output.
      const camInstruction = cameraInstruction(camera);
      const videoPrompt = camInstruction
        ? `${finalPrompt}. ${camInstruction}`
        : finalPrompt;
      // Filter the upstream variants to the user's selection — the dialog
      // shows one toggleable thumbnail per variant + an All/None action.
      const picked = sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
      const useMulti = picked.length > 1;
      dispatchGeneration(rfId, {
        prompt: videoPrompt,
        aspectRatio,
        kind: "video",
        sourceMediaId: useMulti ? undefined : picked[0],
        sourceMediaIds: useMulti ? picked : undefined,
        // Tell the node UI how many video tiles to reserve while pending —
        // otherwise it defaults to 1 placeholder even though we're
        // dispatching N i2v ops.
        variantCount: picked.length,
      });
    } else {
      dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        variantCount: variants,
        prompts: perVariantPrompts,
      });
    }
    closeGenerationDialog();
  }

  // The dialog's local `autoBuilding` flag covers the in-flight window
  // when THIS dialog instance is composing. But the dialog can be closed
  // + reopened mid-flight, leaving the local flag fresh while the node-
  // level `autoPromptStatus` / `aiBriefStatus` is still pending from the
  // first run. Treat both signals as "busy" so the user can't double-fire.
  const nodeLLMBusy =
    node?.data.autoPromptStatus === "pending"
    || node?.data.aiBriefStatus === "pending";
  const isWorking = autoBuilding || nodeLLMBusy;

  const canGenerate = isOmniVideo
    ? refSourceNodes.length > 0 && !isWorking
    : isVideo
    ? selectedSourceIdx.size > 0 && !isWorking
    : !isWorking;

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeGenerationDialog();
      }}
    >
      <div
        className="gen-dialog"
        role="dialog"
        aria-labelledby="gen-dialog-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Header */}
        <div className="gen-dialog__header">
          <div>
            <h2 id="gen-dialog-title" className="gen-dialog__title">
              {isVideo ? "Generate video" : isPrompt ? "Edit prompt" : "Generate image"}
            </h2>
            <span className="gen-dialog__subtitle">
              Node #{node?.data.shortId ?? rfId}
            </span>
          </div>
          <button
            className="gen-dialog__close"
            onClick={closeGenerationDialog}
            aria-label="Close dialog (Escape)"
          >
            esc
          </button>
        </div>

        {/* Prompt */}
        (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <label className="gen-dialog__label" htmlFor="gen-prompt">
                {isVideo ? "Motion prompt" : "Prompt"}
                {autoPromptUsed && (
                  <span className="gen-dialog__auto-badge" title="Auto-generated from upstream nodes">
                    ✨ auto
                  </span>
                )}
              </label>
              <span className="gen-dialog__char-count">{prompt.length}/500</span>
            </div>
            <textarea
              id="gen-prompt"
              ref={firstFocusRef}
              className="gen-dialog__textarea"
              rows={5}
              maxLength={500}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (autoPromptUsed) setAutoPromptUsed(false);
              }}
              placeholder={
                isVideo
                  ? "Bỏ trống để tự sinh motion prompt từ source image ✨"
                  : isPrompt
                  ? "Nhập prompt mồi để feed cho downstream image / video…"
                  : "Bỏ trống để tự generate prompt từ upstream nodes ✨"
              }
              disabled={isWorking}
            />
            {isWorking && (
              <p className="gen-dialog__hint">
                {node?.data.aiBriefStatus === "pending"
                  ? "✨ Đang phân tích image…"
                  : "✨ Đang dựng prompt từ upstream context…"}
              </p>
            )}
          </div>
        )

        {/* Source image (video only — i2v, multi-select variants → N videos) */}
        {isVideo && !isOmniVideo && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                Source image{sourceMediaIds.length > 1 ? `s (${sourceMediaIds.length})` : ""}
              </span>
              {sourceMediaIds.length > 1 && (
                <div className="source-select-actions">
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() =>
                      setSelectedSourceIdx(
                        new Set(sourceMediaIds.map((_, i) => i)),
                      )
                    }
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() => setSelectedSourceIdx(new Set())}
                  >
                    None
                  </button>
                </div>
              )}
            </div>
            {sourceMediaIds.length > 0 && sourceNode ? (
              <>
                <div className="source-image-row">
                  {sourceMediaIds.map((mid, i) => {
                    const checked = selectedSourceIdx.has(i);
                    return (
                      <button
                        key={mid}
                        type="button"
                        className={`source-thumb${checked ? " source-thumb--checked" : ""}`}
                        onClick={() => {
                          setSelectedSourceIdx((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        aria-pressed={checked}
                        aria-label={`Variant ${i + 1}${checked ? " selected" : ""}`}
                      >
                        <img
                          className="source-image-row__thumb"
                          src={mediaUrl(mid)}
                          alt={sourceNode.data.title}
                        />
                        <span className="source-thumb__check" aria-hidden="true">
                          {checked ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                  <span className="source-image-row__label">
                    #{sourceNode.data.shortId}
                  </span>
                </div>
                <p className="gen-dialog__hint">
                  {selectedSourceIdx.size === 0 ? (
                    <span style={{ color: "#ef4444" }}>
                      Chọn ít nhất 1 variant để gen video.
                    </span>
                  ) : (
                    <>
                      Sẽ gen <strong>{selectedSourceIdx.size} video</strong>
                      {selectedSourceIdx.size === sourceMediaIds.length
                        ? " (tất cả variants)"
                        : ` (${selectedSourceIdx.size}/${sourceMediaIds.length} variants)`}
                      — cùng prompt + camera setting.
                    </>
                  )}
                </p>
              </>
            ) : (
              <div className="source-image-row source-image-row--empty">
                Connect an upstream image node with rendered media first
              </div>
            )}
          </div>
        )}

        {/* Source references — image refs AND prompt-text refs. Prompt nodes don't have
            media but their text feeds the auto-prompt synth, so we
            surface them as text chips next to the thumbnails. */}
        {(!isVideo || isOmniVideo) && (refSourceNodes.length > 0 || promptSourceNodes.length > 0) && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Source references ({refSourceNodes.length + promptSourceNodes.length})
            </span>
            <div className="ref-source-row">
              {promptSourceNodes.map((p) => {
                const preview = p.text.trim() || "(empty prompt)";
                return (
                  <div
                    key={p.edgeId}
                    className="ref-source-chip ref-source-chip--prompt"
                    title={`${p.node.data.title || "Prompt"} — ${preview}`}
                  >
                    <div className="ref-source-chip__prompt-body">
                      <span className="ref-source-chip__prompt-icon" aria-hidden="true">✦</span>
                      <span className="ref-source-chip__prompt-text">
                        {preview}
                      </span>
                    </div>
                    <span className="ref-source-chip__id">
                      #{p.node.data.shortId}
                    </span>
                  </div>
                );
              })}
              {refSourceNodes.map((r) => {
                const isMulti = r.allVariants.length >= 2;
                const isPickerOpen = openVariantPicker === r.edgeId;
                const tooltip = isMulti
                  ? `${r.node.data.title} — variant ${(r.variantIdx ?? 0) + 1} · click to switch`
                  : r.node.data.title;
                return (
                  <div key={r.edgeId} className="ref-source-chip-wrap">
                    {isMulti ? (
                      <button
                        type="button"
                        className={`ref-source-chip ref-source-chip--switchable${
                          isPickerOpen ? " ref-source-chip--active" : ""
                        }`}
                        title={tooltip}
                        onClick={() =>
                          setOpenVariantPicker(isPickerOpen ? null : r.edgeId)
                        }
                      >
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={r.node.data.title}
                        />
                        <span className="ref-source-chip__variant">
                          v{(r.variantIdx ?? 0) + 1}
                        </span>
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </button>
                    ) : (
                      <div className="ref-source-chip" title={tooltip}>
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={r.node.data.title}
                        />
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </div>
                    )}
                    {isMulti && isPickerOpen && (
                      <div
                        className="ref-source-chip__picker"
                        role="dialog"
                        aria-label={`Pick variant for ${r.node.data.title}`}
                      >
                        {r.allVariants.map((mid, i) => {
                          const isCurrent = i === (r.variantIdx ?? 0);
                          return (
                            <button
                              key={mid}
                              type="button"
                              className={`ref-source-chip__picker-item${
                                isCurrent ? " ref-source-chip__picker-item--current" : ""
                              }`}
                              onClick={() => void pickVariantForEdge(r.edgeId, i)}
                              title={`Variant ${i + 1}`}
                              aria-current={isCurrent ? "true" : undefined}
                            >
                              <img
                                className="ref-source-chip__picker-img"
                                src={mediaUrl(mid)}
                                alt={`Variant ${i + 1}`}
                              />
                              <span className="ref-source-chip__picker-label">
                                v{i + 1}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Aspect ratio — irrelevant for prompt nodes (text-only). */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Aspect ratio</span>
            <div className="aspect-chip-row">
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
                <button
                  key={ar.key}
                  className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setAspectRatio(ar.key)}
                  type="button"
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Omni Flash duration picker */}
        {isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Duration (Omni Flash)
              <InfoTip tip="Omni Flash dispatches via video:batchAsyncGenerateVideoReferenceImages with the upstream image(s) as IMAGE_USAGE_TYPE_ASSET refs. Duration scales credit cost: 4s=15, 6s=20, 8s=25, 10s=30." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_DURATIONS.map((d) => {
                const active = omniFlashDuration === d;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`aspect-chip${active ? " aspect-chip--active" : ""}`}
                    onClick={() => setOmniFlashDuration(d as OmniFlashDuration)}
                    title={`${d}s — ${OMNI_FLASH_CREDIT_COST[d]} credits`}
                  >
                    {d}s / {OMNI_FLASH_CREDIT_COST[d]}c
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Model picker (video only) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Model
              <InfoTip tip="Sticky setting shared with Settings. Veo uses i2v with one source image. Omni Flash uses reference ingredients and the 4/6/8/10s duration picker below." />
            </span>
            <select
              className="gen-dialog__select"
              value={videoModelFamily === "omni_flash" ? "omni" : `veo:${videoQuality}`}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "omni") {
                  setVideoModel("omni_flash");
                  return;
                }
                const [, quality] = v.split(":") as ["veo", VideoQuality];
                setVideoModel("veo");
                setVideoQuality(quality);
              }}
            >
              {VIDEO_MODEL_CHIPS.map((m) => {
                if (m.kind === "omni") {
                  return <option key="omni" value="omni">Omni Flash</option>;
                }
                const locked = m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                return (
                  <option key={`veo:${m.quality}`} value={`veo:${m.quality}`} disabled={locked}>
                    {m.label}{m.ultraOnly ? " / Ultra only" : ""}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Camera movement (video only) */}
        {isVideo && !isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Camera
              <InfoTip tip="Static keeps the camera locked. Dynamic lets auto-prompt choose camera motion." />
            </span>
            <div className="aspect-chip-row">
              {CAMERA_MOVEMENTS.map((c) => (
                <button
                  key={c.key}
                  className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setCamera(c.key)}
                  type="button"
                  title={c.instruction}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Variants stepper — image only (not storyboard, prompt; video
            has its own one-clip-per-source-variant flow above). */}
        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Variants</span>
            <div className="variants-stepper">
              <button
                type="button"
                disabled={variants <= 1}
                aria-label="Decrease variants"
                onClick={() => setVariants((v) => Math.max(1, v - 1))}
              >
                −
              </button>
              <span>{variants}</span>
              <button
                type="button"
                disabled={variants >= 4}
                aria-label="Increase variants"
                onClick={() => setVariants((v) => Math.min(4, v + 1))}
              >
                +
              </button>
              <span className="variants-stepper__hint">1–4 images per request</span>
            </div>
          </div>
        )}


        {/* Footer */}
        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {boardName} · {nodeCount} node{nodeCount !== 1 ? "s" : ""}
          </span>
          <button
            className="gen-dialog__cta"
            type="button"
            onClick={handleSubmit}
            disabled={!canGenerate}
            title={
              nodeLLMBusy && !autoBuilding
                ? "Backend is still composing — try again in a moment"
                : undefined
            }
          >
            {isWorking
              ? "Building…"
              : isPrompt
              ? "Save ⌘↵"
              : "Generate ⌘↵"}
          </button>
        </div>
      </div>
    </div>
  );
}

