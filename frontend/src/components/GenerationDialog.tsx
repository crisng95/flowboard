import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore } from "../store/board";
import { autoPrompt as autoPromptApi, mediaUrl } from "../api/client";

const REF_SOURCE_TYPES = new Set(["character", "image", "visual_asset"]);

// Character builder presets — keep the list short and opinionated. Labels
// shown to the user; `tag` is the English noun injected into the prompt.
const CHARACTER_GENDERS = [
  { key: "male", label: "Nam", tag: "male" },
  { key: "female", label: "Nữ", tag: "female" },
] as const;

const CHARACTER_COUNTRIES = [
  { key: "vn", label: "Việt Nam", tag: "Vietnamese" },
  { key: "jp", label: "Nhật Bản", tag: "Japanese" },
  { key: "kr", label: "Hàn Quốc", tag: "Korean" },
  { key: "cn", label: "Trung Quốc", tag: "Chinese" },
  { key: "th", label: "Thái Lan", tag: "Thai" },
  { key: "us", label: "Mỹ", tag: "American" },
  { key: "fr", label: "Pháp", tag: "French" },
] as const;

type GenderKey = (typeof CHARACTER_GENDERS)[number]["key"];
type CountryKey = (typeof CHARACTER_COUNTRIES)[number]["key"];

function buildCharacterPrompt(
  gender: GenderKey | null,
  country: CountryKey | null,
  extras: string,
): string {
  const g = CHARACTER_GENDERS.find((x) => x.key === gender)?.tag;
  const c = CHARACTER_COUNTRIES.find((x) => x.key === country)?.tag;
  const subject = [c, g].filter(Boolean).join(" ") || "person";
  const tail = extras.trim();
  // Anchor the framing hard: full frontal face, both eyes visible, nothing
  // covering the face, neutral expression. Model used as a downstream
  // character reference must be consistent across every shot.
  return [
    `Studio portrait headshot of a ${subject} character`,
    tail || null,
    "looking directly at the camera, full frontal face, both eyes clearly visible",
    "no glasses, no hat, no mask, no occlusion, nothing covering the face",
    "neutral closed-mouth expression, head and shoulders framing, centered composition",
    "sharp focus on face, even softbox lighting, neutral solid grey background",
    "photorealistic, ultra-detailed, consistent character reference",
  ]
    .filter(Boolean)
    .join(", ");
}

const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
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

function cameraInstruction(key: CameraKey): string {
  return CAMERA_MOVEMENTS.find((c) => c.key === key)?.instruction ?? "";
}

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
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("static");

  // Character builder state — only used when targetType === "character".
  const [charGender, setCharGender] = useState<GenderKey | null>(null);
  const [charCountry, setCharCountry] = useState<CountryKey | null>(null);
  const [charExtras, setCharExtras] = useState("");

  // Auto-prompt state — set when the user submits an empty prompt and we
  // synthesise one from upstream context. Surfaced as a small ✨ badge.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);

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
  const isCharacter = targetType === "character";

  // Find upstream source image for video nodes
  const sourceEdge = isVideo ? edges.find((e) => e.target === rfId) : undefined;
  const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : undefined;
  const sourceMediaId = sourceNode?.data.mediaId ?? null;

  // Image nodes: list every upstream node feeding this one as a reference
  // image (character / image / visual_asset that has a mediaId).
  const refSourceNodes = !isVideo && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter(
          (n): n is NonNullable<typeof n> =>
            !!n &&
            REF_SOURCE_TYPES.has(n.data.type) &&
            typeof n.data.mediaId === "string" &&
            n.data.mediaId.length > 0,
        )
    : [];

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      setPrompt(openDialog.prompt);
      const openNode = nodes.find((n) => n.id === rfId);
      const openNodeType = openNode?.data.type ?? "image";
      // Character → 1:1 portrait headshot is the cleanest default for a
      // consistent reference. Video → landscape. Image → landscape.
      setAspectRatio(
        openNodeType === "video"
          ? "VIDEO_ASPECT_RATIO_LANDSCAPE"
          : openNodeType === "character"
          ? "IMAGE_ASPECT_RATIO_SQUARE"
          : "IMAGE_ASPECT_RATIO_LANDSCAPE",
      );
      setPaygateTier("PAYGATE_TIER_ONE");
      setVariants(1);
      setCamera("static");
      setCharGender(null);
      setCharCountry(null);
      setCharExtras("");
      setAutoBuilding(false);
      setAutoPromptUsed(false);
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

  async function handleSubmit() {
    if (!rfId) return;
    if (isCharacter) {
      const built = buildCharacterPrompt(charGender, charCountry, charExtras);
      dispatchGeneration(rfId, {
        prompt: built,
        aspectRatio,
        paygateTier,
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    // Image / video branch — if user left the prompt blank, synthesise one
    // from upstream briefs (composition prompt for image, motion prompt for
    // video) before dispatching.
    let finalPrompt = prompt;
    if (!finalPrompt.trim()) {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        return;
      }
      setAutoBuilding(true);
      try {
        const res = await autoPromptApi(dbId, isVideo ? { camera } : undefined);
        finalPrompt = res.prompt;
        setPrompt(finalPrompt);
        setAutoPromptUsed(true);
      } catch (err) {
        setAutoBuilding(false);
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
      dispatchGeneration(rfId, {
        prompt: videoPrompt,
        aspectRatio,
        paygateTier,
        kind: "video",
        sourceMediaId: sourceMediaId ?? undefined,
      });
    } else {
      dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        paygateTier,
        variantCount: variants,
      });
    }
    closeGenerationDialog();
  }

  // Both image and video allow empty prompt — we'll auto-synth on submit.
  // Video still needs a connected source image.
  const canGenerate = isCharacter
    ? charGender !== null || charCountry !== null || charExtras.trim().length > 0
    : isVideo
    ? sourceMediaId !== null && !autoBuilding
    : !autoBuilding;

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
              {isVideo
                ? "Generate video"
                : isCharacter
                ? "Generate character"
                : "Generate image"}
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

        {/* Prompt — hidden when character mode shows the builder instead */}
        {!isCharacter && (
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
                  : "Bỏ trống để tự generate prompt từ upstream nodes ✨"
              }
              disabled={autoBuilding}
            />
            {autoBuilding && (
              <p className="gen-dialog__hint">✨ Đang dựng prompt từ upstream context…</p>
            )}
          </div>
        )}

        {/* Character builder (character node only) */}
        {isCharacter && (
          <>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Gender</span>
              <div className="aspect-chip-row">
                {CHARACTER_GENDERS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`aspect-chip${charGender === g.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharGender(charGender === g.key ? null : g.key)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Quốc gia</span>
              <div className="aspect-chip-row">
                {CHARACTER_COUNTRIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`aspect-chip${charCountry === c.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharCountry(charCountry === c.key ? null : c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <div className="gen-dialog__label-row">
                <label className="gen-dialog__label" htmlFor="gen-char-extras">
                  Mô tả thêm (tuỳ chọn)
                </label>
                <span className="gen-dialog__char-count">{charExtras.length}/200</span>
              </div>
              <textarea
                id="gen-char-extras"
                ref={firstFocusRef}
                className="gen-dialog__textarea"
                rows={3}
                maxLength={200}
                value={charExtras}
                onChange={(e) => setCharExtras(e.target.value)}
                placeholder="Tuổi, kiểu tóc, trang phục, biểu cảm…"
              />
              <p className="gen-dialog__hint">
                Prompt được auto-build: portrait headshot · neutral background ·
                photorealistic — tối ưu cho character reference.
              </p>
            </div>
          </>
        )}

        {/* Source image (video only — i2v, single image input) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Source image</span>
            {sourceMediaId && sourceNode ? (
              <div className="source-image-row">
                <img
                  className="source-image-row__thumb"
                  src={mediaUrl(sourceMediaId)}
                  alt={sourceNode.data.title}
                />
                <span className="source-image-row__label">
                  #{sourceNode.data.shortId}
                </span>
              </div>
            ) : (
              <div className="source-image-row source-image-row--empty">
                Connect an upstream image node with rendered media first
              </div>
            )}
          </div>
        )}

        {/* Reference images (image only) */}
        {!isVideo && refSourceNodes.length > 0 && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Source references ({refSourceNodes.length})
            </span>
            <div className="ref-source-row">
              {refSourceNodes.map((n) => (
                <div key={n.id} className="ref-source-chip" title={n.data.title}>
                  <img
                    className="ref-source-chip__img"
                    src={mediaUrl(n.data.mediaId as string)}
                    alt={n.data.title}
                  />
                  <span className="ref-source-chip__id">
                    #{n.data.shortId}
                  </span>
                </div>
              ))}
            </div>
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

        {/* Camera movement (video only) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Camera</span>
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
            <p className="gen-dialog__hint">
              <strong>Static</strong> = locked-off, không zoom/pan — phù hợp
              e-commerce product shot. <strong>Dynamic</strong> = để auto-prompt
              tự quyết camera move (dolly / micro-shift / …).
            </p>
          </div>
        )}

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

        {/* Variants stepper — image only */}
        {!isVideo && (
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
          >
            {autoBuilding ? "Building…" : "Generate ⌘↵"}
          </button>
        </div>
      </div>
    </div>
  );
}
