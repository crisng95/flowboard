import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore } from "../store/board";

const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "3:4" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
  { key: "IMAGE_ASPECT_RATIO_WIDESCREEN", label: "2.39:1" },
] as const;

const VIDEO_ASPECT_RATIOS = [
  { key: "VIDEO_ASPECT_RATIO_LANDSCAPE", label: "16:9 landscape" },
  { key: "VIDEO_ASPECT_RATIO_PORTRAIT", label: "9:16 portrait" },
] as const;

type ImageAspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
type VideoAspectKey = (typeof VIDEO_ASPECT_RATIOS)[number]["key"];
type AspectKey = ImageAspectKey | VideoAspectKey;

export function GenerationDialog() {
  const openDialog = useGenerationStore((s) => s.openDialog);
  const closeGenerationDialog = useGenerationStore((s) => s.closeGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);

  const [prompt, setPrompt] = useState(openDialog.prompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [paygateTier, setPaygateTier] = useState<"PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO">(
    "PAYGATE_TIER_ONE",
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const rfId = openDialog.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = nodes.length;
  const edges = useBoardStore((s) => s.edges);

  const targetType = node?.data.type ?? "image";
  const isVideo = targetType === "video";

  // Find upstream source image for video nodes
  const sourceEdge = isVideo ? edges.find((e) => e.target === rfId) : undefined;
  const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : undefined;
  const sourceMediaId = sourceNode?.data.mediaId ?? null;

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      setPrompt(openDialog.prompt);
      const openNode = nodes.find((n) => n.id === rfId);
      const openNodeType = openNode?.data.type ?? "image";
      setAspectRatio(
        openNodeType === "video" ? "VIDEO_ASPECT_RATIO_LANDSCAPE" : "IMAGE_ASPECT_RATIO_LANDSCAPE",
      );
      setPaygateTier("PAYGATE_TIER_ONE");
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

  function handleSubmit() {
    if (!rfId) return;
    if (isVideo) {
      dispatchGeneration(rfId, {
        prompt,
        aspectRatio,
        paygateTier,
        kind: "video",
        sourceMediaId: sourceMediaId ?? undefined,
      });
    } else {
      dispatchGeneration(rfId, { prompt, aspectRatio, paygateTier });
    }
    closeGenerationDialog();
  }

  const canGenerate =
    prompt.trim().length > 0 && (!isVideo || sourceMediaId !== null);

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
              {isVideo ? "Generate video" : "Generate image"}
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
        <div className="gen-dialog__field">
          <div className="gen-dialog__label-row">
            <label className="gen-dialog__label" htmlFor="gen-prompt">
              {isVideo ? "Motion prompt" : "Prompt"}
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
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              isVideo
                ? "Describe the motion you want to generate…"
                : "Describe the image you want to generate…"
            }
          />
        </div>

        {/* Source image (video only) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Source image</span>
            {sourceMediaId && sourceNode ? (
              <div className="source-image-row">
                <span>#{sourceNode.data.shortId} — mediaId {sourceMediaId.slice(0, 12)}…</span>
              </div>
            ) : (
              <div className="source-image-row source-image-row--empty">
                Connect an upstream image node with rendered media first
              </div>
            )}
          </div>
        )}

        {/* Aspect ratio */}
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

        {/* Paygate tier */}
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">Paygate tier</span>
          <div className="tier-radio-row">
            {(["PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"] as const).map((tier) => (
              <label key={tier} className="tier-radio-label">
                <input
                  type="radio"
                  name="paygate-tier"
                  value={tier}
                  checked={paygateTier === tier}
                  onChange={() => setPaygateTier(tier)}
                />
                {tier === "PAYGATE_TIER_ONE" ? "TIER_ONE (free)" : "TIER_TWO (paid)"}
              </label>
            ))}
          </div>
        </div>

        {/* Variants stepper */}
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">Variants</span>
          <div className="variants-stepper">
            <button type="button" disabled aria-label="Decrease variants">
              −
            </button>
            <span>1</span>
            <button type="button" disabled aria-label="Increase variants">
              +
            </button>
            <span className="variants-stepper__hint">multi-variant in later run</span>
          </div>
        </div>

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
          >
            Generate ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
}
