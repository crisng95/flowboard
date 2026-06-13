/**
 * useUploadFlow — shared upload + state-machine hook.
 *
 * Extracts the upload / drag-drop / error / "✓ Uploaded" pulse logic
 * that every V2 media node (Reference, Concept, eventually Multi-view
 * variants, Part) needs. Keeps the per-node component focused on
 * layout instead of plumbing.
 *
 * Returns:
 *   - state: derived `bodyState` for the slot ("empty" | "uploading"
 *     | "processing" | "filled" | "error")
 *   - flags: `dragOver`, `uploadJustFinished` for transient pulse
 *   - actions: `pickFile`, `onDrop`, `onDragOver`, `onDragLeave`,
 *     `dismissError`
 *   - input: `fileInputProps` to spread on the hidden <input>
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { mediaUrl as _mediaUrl, patchNode, uploadImage } from "../../../api/client";
import { requestAutoBrief } from "../../../api/autoBrief";
import { useBoardStore, type FlowboardNodeData } from "../../../store/board";
import { useGenerationStore } from "../../../store/generation";

const ACCEPT_MIME = "image/png,image/jpeg,image/webp,image/gif";
// 20 MB — Flow rejects anything larger before we ever reach Veo.
// Better to fail-fast on the client with a clear message than after a
// 5s upload.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type BodyState =
  | "empty"
  | "uploading"
  | "processing"
  | "filled"
  | "error";

export interface UploadFlow {
  bodyState: BodyState;
  uploading: boolean;
  uploadJustFinished: boolean;
  dragOver: boolean;
  error: string | null;
  pickFile: () => void;
  onDrop: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  dismissError: () => void;
  /**
   * Spread onto the hidden `<input type="file" />`. We can't render
   * the input from inside this hook (Rules of Hooks would still allow
   * it, but pure-data hooks compose better) so the consumer renders
   * the input + spreads these props.
   */
  fileInputProps: {
    ref: React.RefObject<HTMLInputElement>;
    accept: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  };
  /** Upload an image from a remote URL. Fetches client-side and
   *  re-uploads as a blob. May fail on CORS-restricted origins. */
  uploadFromUrl: (url: string) => Promise<void>;
}

/**
 * Wire up upload + drag-drop + error + analysing state for one node.
 *
 * `rfId` is the React Flow node id (string of the DB primary key);
 * `data` is the current `FlowboardNodeData`. The hook reads
 * `mediaId`, `status`, `aiBrief*` from `data` to derive `bodyState`.
 */
export function useUploadFlow(
  rfId: string,
  data: FlowboardNodeData,
  selected?: boolean,
): UploadFlow {
  const [uploading, setUploading] = useState(false);
  const [uploadJustFinished, setUploadJustFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selected) return;

    const handlePaste = (e: ClipboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        void uploadOwn(files[0]);
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [selected, rfId]);

  // Brief "✓ Uploaded" pulse — fades on its own ~1.4s timer so the
  // success moment registers before the node settles into the filled
  // state.
  useEffect(() => {
    if (!uploadJustFinished) return;
    const t = window.setTimeout(() => setUploadJustFinished(false), 1400);
    return () => window.clearTimeout(t);
  }, [uploadJustFinished]);

  function persistMedia(
    newMediaId: string,
    aspectRatio?: string,
    fileName?: string,
    imageWidth?: number,
    imageHeight?: number,
    assetId?: string,
    storageKey?: string,
  ) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      assetId,
      storageKey,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
      fileName: fileName ?? null,
      imageWidth,
      imageHeight,
    });
    const dbId = parseInt(rfId, 10);
    if (!Number.isNaN(dbId)) {
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          assetId: assetId ?? null,
          storageKey: storageKey ?? null,
          aiBrief: null,
          aspectRatio,
          fileName: fileName ?? null,
          imageWidth,
          imageHeight,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    // Only request auto-brief when the user has opted in via settings.
    if (data.type === "add_reference" || data.autoBriefEnabled) {
      requestAutoBrief(rfId, newMediaId);
    }
  }

  async function uploadOwn(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `File too large (${(file.size / 1_048_576).toFixed(1)} MB · max 20 MB)`,
      );
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError(`Unsupported type: ${file.type || "unknown"}`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("No Flow project linked to this board");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(
        file,
        projectId,
        Number.isNaN(dbId) ? undefined : dbId,
      );
      persistMedia(
        resp.media_id,
        resp.aspect_ratio,
        file.name,
        resp.width,
        resp.height,
        resp.asset_id,
        resp.storage_key,
      );
      setUploadJustFinished(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  function pickFile() {
    setError(null);
    fileInputRef.current?.click();
  }
  function dismissError() {
    setError(null);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = (e.dataTransfer as DataTransfer | undefined)?.files?.[0];
    if (f) uploadOwn(f);
  }
  function onDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }
  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadOwn(f);
    e.target.value = "";
  }

  // Order matters — error wins over uploading wins over processing
  // wins over filled/empty. Locks the slot into the loudest state so
  // the user can't miss a failure.
  const isProcessing = data.status === "queued" || data.status === "running";
  const bodyState: BodyState = error
    ? "error"
    : uploading
      ? "uploading"
      : isProcessing
        ? "processing"
        : data.mediaId
          ? "filled"
          : "empty";

  async function uploadFromUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setUploading(true);
    try {
      const res = await fetch(trimmed);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) {
        throw new Error(`Not an image: ${blob.type || "unknown type"}`);
      }
      const ext = blob.type.split("/")[1]?.split("+")[0] ?? "jpg";
      const fileName = trimmed.split("/").pop()?.split("?")[0] ?? `ref.${ext}`;
      const file = new File([blob], fileName, { type: blob.type });
      await uploadOwn(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "URL fetch failed");
    } finally {
      setUploading(false);
    }
  }

  return {
    bodyState,
    uploading,
    uploadJustFinished,
    dragOver,
    error,
    pickFile,
    onDrop,
    onDragOver,
    onDragLeave,
    dismissError,
    fileInputProps: {
      ref: fileInputRef,
      accept: ACCEPT_MIME,
      onChange,
    },
    uploadFromUrl,
  };
}

// Re-export for nodes that need direct access to media URL building
// without importing from `api/client` separately.
export const mediaUrl = _mediaUrl;
