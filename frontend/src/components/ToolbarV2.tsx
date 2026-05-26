/**
 * ToolbarV2 — Magnific-style glassmorphism top bar.
 *
 * Visual treatment:
 *   - Backdrop-blur + semi-transparent surface (glass effect)
 *   - Subtle inner highlight (1px white/3% inset shadow)
 *   - Wordmark "Concepta" in accent gradient
 *   - Board name editable inline (click to rename)
 *   - Right side: Activity bell + AI Provider badge
 *   - No "Sponsor" button (fork-specific, removed)
 *
 * Replaces the V1 Toolbar when `flowboard_ui = "v2"` is set.
 * Falls back to V1 otherwise (see App.tsx routing).
 */
import { useState, useRef, type KeyboardEvent } from "react";
import { useBoardStore } from "../store/board";
import { ActivityBell } from "./activity/ActivityBell";
import { AiProviderBadge } from "./AiProviderBadge";
import { AppLogo } from "./AppLogo";

export function ToolbarV2() {
  const boardName = useBoardStore((s) => s.boardName);
  const renameBoard = useBoardStore((s) => s.renameBoard);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(boardName);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commitEdit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== boardName) {
      renameBoard(trimmed);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") inputRef.current?.blur();
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <header
      className="flex items-center gap-3 h-12 px-4 shrink-0 z-20 relative"
      style={{
        // Glass surface — semi-transparent dark with backdrop blur.
        // Inline so Tailwind JIT can't tree-shake the custom rgba.
        backgroundColor: "rgba(14, 16, 22, 0.72)",
        backdropFilter: "blur(16px) saturate(1.4)",
        WebkitBackdropFilter: "blur(16px) saturate(1.4)",
        // Inner highlight + bottom separator — single box-shadow
        // combining both so we don't need a pseudo-element.
        boxShadow:
          "inset 0 1px 0 0 rgba(255,255,255,0.04), 0 1px 0 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* Brand logo & wordmark */}
      <div className="flex items-center gap-2 select-none">
        <AppLogo className="size-5 shrink-0" />
        <span
          className="text-sm font-bold tracking-tight"
          style={{
            background: "linear-gradient(135deg, #9d80ff 0%, #7c5cff 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          Concepta
        </span>
      </div>

      {/* Separator */}
      <span className="text-ink-placeholder text-sm select-none">/</span>

      {/* Board name — editable inline */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          aria-label="Board name"
          className="text-sm text-ink-primary font-medium px-1.5 py-0.5 rounded-md outline-none border border-accent/50 bg-surface-2"
          style={{ width: 160 }}
        />
      ) : (
        <button
          onClick={startEdit}
          aria-label="Rename board"
          title="Click to rename"
          className="text-sm text-ink-primary font-medium px-1.5 py-0.5 rounded-md hover:bg-white/[0.05] transition-colors"
        >
          {boardName || "Untitled"}
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right actions */}
      <div className="flex items-center gap-2">
        <ActivityBell />
        <AiProviderBadge />
      </div>
    </header>
  );
}
