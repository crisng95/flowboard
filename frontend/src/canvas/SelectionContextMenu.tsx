/**
 * SelectionContextMenu - lightweight context menu shown when the user
 * right-clicks on the canvas while at least 2 nodes are selected.
 *
 * Today the menu only exposes "Group nodes". The component is
 * intentionally generic so future actions (lock, duplicate selection,
 * align...) can slot in next to it without touching Board.tsx.
 */
import { useEffect, useRef } from "react";
import { Layers } from "lucide-react";

import { useBoardStore } from "../store/board";

export function SelectionContextMenu({
  position,
  onClose,
}: {
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const groupNodes = useBoardStore((s) => s.groupNodes);
  const nodes = useBoardStore((s) => s.nodes);

  // Filter to a stable list of selectable rfIds (drop groups + nodes
  // that already live in a group; the action can't operate on them).
  const selectedIds = nodes
    .filter((n) => n.selected && n.data.type !== "group" && n.parentId === undefined)
    .map((n) => n.id);
  const canGroup = selectedIds.length >= 2;

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  function handleGroup() {
    if (!canGroup) return;
    void groupNodes(selectedIds);
    onClose();
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[200px] rounded-xl border border-white/[0.08] shadow-2xl py-1.5"
      style={{ left: position.x, top: position.y, backgroundColor: "#1a1a1a" }}
      role="menu"
      aria-label="Selection actions"
    >
      <button
        type="button"
        onClick={handleGroup}
        disabled={!canGroup}
        className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-white/85 hover:text-white hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Layers size={14} strokeWidth={1.75} className="text-white/60" />
        <span className="flex-1 text-left">Group nodes</span>
        <kbd className="text-[10px] text-white/40 font-mono">Ctrl+G</kbd>
      </button>
    </div>
  );
}