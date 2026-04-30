import { useState, useRef, type KeyboardEvent } from "react";
import { useBoardStore } from "../store/board";
import { AiProviderBadge } from "./AiProviderBadge";
import { SponsorButton } from "./SponsorDialog";

export function Toolbar() {
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
    if (e.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div className="toolbar">
      <span className="toolbar-wordmark">Flowboard</span>
      <span className="toolbar-sep" aria-hidden="true">/</span>
      {editing ? (
        <input
          ref={inputRef}
          className="toolbar-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          aria-label="Board name"
        />
      ) : (
        <button
          className="toolbar-name-btn"
          onClick={startEdit}
          aria-label="Rename board"
          title="Click to rename"
        >
          {boardName || "Untitled"}
        </button>
      )}

      <div className="toolbar-actions">
        <button className="toolbar-icon-btn" aria-label="Undo" title="Undo" disabled>
          ↶
        </button>
        <button className="toolbar-icon-btn" aria-label="Redo" title="Redo" disabled>
          ↷
        </button>
        <button className="toolbar-icon-btn" aria-label="Settings" title="Settings" disabled>
          ⚙
        </button>
        <span className="toolbar-actions__divider" aria-hidden="true" />
        <AiProviderBadge />
        <SponsorButton />
      </div>
    </div>
  );
}
