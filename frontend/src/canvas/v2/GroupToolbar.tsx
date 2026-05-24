/**
 * GroupToolbar - floating action bar that hovers above a selected
 * group node. Uses React Flow's <NodeToolbar> so positioning tracks
 * the node automatically (incl. zoom + pan). Mirrors the toolbar in
 * the Magnific reference: small pill of icon buttons + a 6-swatch
 * color palette.
 *
 * Buttons (left to right):
 *   - Color swatches (palette of 6)
 *   - Lock toggle
 *   - Duplicate group
 *   - Ungroup
 *   - Delete group (cascades children)
 */
import { useState, type ReactNode } from "react";
import { NodeToolbar, Position } from "@xyflow/react";
import { Copy, Lock, Palette, Trash2, Ungroup, Unlock } from "lucide-react";

import { useBoardStore } from "../../store/board";

// 6-swatch Figma-style palette. Picked to read well against the dark
// canvas; the first entry doubles as the system default.
const PALETTE: string[] = [
  "#7c5cff", // purple (default)
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#0ea5e9", // blue
  "#ec4899", // pink
];

export function GroupToolbar({
  groupRfId,
  color,
  locked,
  selected,
}: {
  groupRfId: string;
  color: string;
  locked: boolean;
  selected: boolean;
}) {
  const updateGroupColor = useBoardStore((s) => s.updateGroupColor);
  const toggleGroupLock = useBoardStore((s) => s.toggleGroupLock);
  const duplicateGroup = useBoardStore((s) => s.duplicateGroup);
  const ungroupNodes = useBoardStore((s) => s.ungroupNodes);
  const deleteGroupCascade = useBoardStore((s) => s.deleteGroupCascade);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  function handleDuplicate() {
    if (duplicating) return;
    setDuplicating(true);
    void duplicateGroup(groupRfId);
    setTimeout(() => setDuplicating(false), 500);
  }

  return (
    <NodeToolbar position={Position.Top} offset={12} isVisible={selected}>
      <div
        className="flex items-center gap-1 px-1.5 py-1 rounded-full"
        style={{
          backgroundColor: "rgba(20, 20, 20, 0.92)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 8px 28px -10px rgba(0,0,0,0.6)",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ToolbarButton
          label="Color"
          active={paletteOpen}
          onClick={() => setPaletteOpen((v) => !v)}
        >
          <Palette size={14} strokeWidth={1.75} />
        </ToolbarButton>
        {paletteOpen && (
          <div className="flex items-center gap-1 pl-1 pr-2 border-l border-white/10">
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Set color ${swatch}`}
                onClick={() => {
                  void updateGroupColor(groupRfId, swatch);
                  setPaletteOpen(false);
                }}
                className="w-4 h-4 rounded-full border"
                style={{
                  backgroundColor: swatch,
                  borderColor: swatch === color ? "#f5f5f5" : "rgba(255,255,255,0.2)",
                }}
              />
            ))}
          </div>
        )}
        <ToolbarDivider />
        <ToolbarButton
          label={locked ? "Unlock group" : "Lock group"}
          onClick={() => void toggleGroupLock(groupRfId)}
          active={locked}
        >
          {locked ? <Lock size={14} strokeWidth={1.75} /> : <Unlock size={14} strokeWidth={1.75} />}
        </ToolbarButton>
        <ToolbarButton
          label={duplicating ? "Duplicating..." : "Duplicate group"}
          onClick={handleDuplicate}
          disabled={duplicating}
        >
          <Copy size={14} strokeWidth={1.75} className={duplicating ? "animate-spin" : ""} />
        </ToolbarButton>
        <ToolbarButton
          label="Ungroup"
          onClick={() => void ungroupNodes(groupRfId)}
        >
          <Ungroup size={14} strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton
          label="Delete group"
          danger
          onClick={() => void deleteGroupCascade(groupRfId)}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolbarButton>
      </div>
    </NodeToolbar>
  );
}

function ToolbarButton({
  children,
  onClick,
  label,
  active = false,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`w-7 h-7 flex items-center justify-center rounded-full transition-colors ${
        disabled ? "opacity-50 cursor-not-allowed" : ""
      }`}
      style={{
        color: danger ? "#ef4444" : active ? "#f5f5f5" : "rgba(245,245,245,0.7)",
        backgroundColor: active ? "rgba(255,255,255,0.08)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="h-4 w-px bg-white/10 mx-0.5" />;
}