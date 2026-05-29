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
import { Copy, Lock, Trash2, Ungroup, Unlock } from "lucide-react";

import { useBoardStore } from "../../store/board";

// 9-swatch premium synchronized palette matching NoteNode & the reference image
const PALETTE: string[] = [
  "transparent", // none (transparent/slate with red slash)
  "#2b2b2b",     // dark grey
  "#ef4444",     // red
  "#fb923c",     // orange
  "#f59e0b",     // yellow
  "#22c55e",     // green
  "#14b8a6",     // teal
  "#3b82f6",     // blue
  "#7c5cff",     // purple
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
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center shrink-0">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={() => setPaletteOpen((v) => !v)}
            className="nodrag nowheel h-7 px-2 flex items-center justify-center gap-1.5 rounded-full transition-colors hover:bg-white/[0.08]"
            style={{
              backgroundColor: paletteOpen ? "rgba(255,255,255,0.08)" : "transparent",
              cursor: "pointer",
            }}
            title="Color"
          >
            {color === "transparent" ? (
              <div className="relative w-3.5 h-3.5 rounded-full border border-white/40 flex items-center justify-center bg-white overflow-hidden shrink-0">
                <div className="w-[18px] h-[1.5px] bg-red-500 rotate-[45deg]" />
              </div>
            ) : (
              <div
                className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0"
                style={{ backgroundColor: color }}
              />
            )}
            <span className="text-[7px] text-white/50 select-none">
              {paletteOpen ? "▲" : "▼"}
            </span>
          </button>

          {paletteOpen && (
            <div
              className="absolute -top-11 left-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full z-50 animate-fade-in"
              style={{
                backgroundColor: "rgba(20, 20, 20, 0.95)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 8px 28px -10px rgba(0,0,0,0.6)",
              }}
            >
              {PALETTE.map((swatch) => {
                const isSelected = swatch === color;
                const isTransparent = swatch === "transparent";
                return (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={`Set color ${swatch}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={() => {
                      void updateGroupColor(groupRfId, swatch);
                      setPaletteOpen(false);
                    }}
                    className="nodrag nowheel w-5.5 h-5.5 rounded-full border transition-transform hover:scale-110 relative flex items-center justify-center shrink-0 cursor-pointer"
                    style={{
                      backgroundColor: isTransparent ? "#ffffff" : swatch,
                      width: "20px",
                      height: "20px",
                      borderColor: isSelected ? "#f5f5f5" : "rgba(255,255,255,0.2)",
                      boxShadow: isSelected ? "0 0 0 2px rgba(124,92,255,0.5)" : "none",
                    }}
                  >
                    {isTransparent && (
                      <div className="absolute inset-0 rounded-full overflow-hidden flex items-center justify-center">
                        {/* Red diagonal line for None */}
                        <div className="w-[22px] h-[2px] bg-red-500 rotate-[45deg]" />
                      </div>
                    )}
                    {isSelected && !isTransparent && (
                      <div className="w-1.5 h-1.5 bg-white rounded-full" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
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
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`nodrag nowheel w-7 h-7 flex items-center justify-center rounded-full transition-colors ${
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
