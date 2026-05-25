/**
 * NoteNode — Canvas V2 Sticky Note
 *
 * Renders a premium, beautiful post-it sticky note with:
 *   • 5 Pastel paper color configs + 1 transparent "None" mode
 *   • Font Size adjustment dropdown (Small, Medium, Large, Extra Large)
 *   • Rich-Text styling (Bold, Italic, Bullet lists, Numbered lists, HR line)
 *     - Keeps selections intact via onMouseDown preventDefault!
 *     - Natural typing with zero cursor jumps!
 *   • Action quick-triggers: Duplicate (clone node) and Delete
 *   • Fully isolated canvas interactions (nodrag, nowheel, preventDefault)
 *   • NO Handles as Post-it notes are purely cosmetic/annotation blocks.
 */
import { useCallback, useRef, useState, useEffect } from "react";
import { type NodeProps, useReactFlow, NodeToolbar, Position } from "@xyflow/react";
import { Bold, Italic, List, ListOrdered, Minus, Copy, Trash2, Check, Ban } from "lucide-react";

import { useBoardStore, type FlowNode } from "../../store/board";
import { persistNodeData } from "./shared/persistNodeData";
import { cn } from "../../lib/utils";
import { createNode } from "../../api/client";
import { DropdownCaret } from "./shared/DropdownCaret";
import { PickerDropdown } from "./shared/PickerDropdown";

/* ═══════════════════════════════════════════════════════════════════════════
   LAYOUT CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */
const MIN_WIDTH = 100;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 300;

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;

/* ═══════════════════════════════════════════════════════════════════════════
   STYLES & MAPS
   ═══════════════════════════════════════════════════════════════════════════ */
interface NoteColorStyle {
  bg: string;
  border: string;
  dotBg: string;
  text: string;
  label: string;
  swatchBorder?: string;
  isTransparent?: boolean;
}

const COLOR_OPTIONS: Record<string, NoteColorStyle> = {
  none: {
    bg: "transparent",
    border: "transparent",
    dotBg: "bg-transparent",
    text: "rgba(255,255,255,0.92)",
    label: "None",
    swatchBorder: "rgba(255,255,255,0.4)",
    isTransparent: true,
  },
  grey: {
    bg: "#334155",
    border: "#475569",
    dotBg: "bg-slate-500",
    text: "rgba(255,255,255,0.92)",
    label: "Grey",
  },
  red: {
    bg: "#fee2e2",
    border: "#f87171",
    dotBg: "bg-red-400",
    text: "#1f2937",
    label: "Red",
  },
  orange: {
    bg: "#ffedd5",
    border: "#fb923c",
    dotBg: "bg-orange-400",
    text: "#1f2937",
    label: "Orange",
  },
  yellow: {
    bg: "#fef3c7",
    border: "#f59e0b",
    dotBg: "bg-yellow-400",
    text: "#1f2937",
    label: "Yellow",
  },
  green: {
    bg: "#d1fae5",
    border: "#10b981",
    dotBg: "bg-emerald-400",
    text: "#1f2937",
    label: "Green",
  },
  teal: {
    bg: "#ccfbf1",
    border: "#14b8a6",
    dotBg: "bg-teal-400",
    text: "#1f2937",
    label: "Teal",
  },
  blue: {
    bg: "#dbeafe",
    border: "#3b82f6",
    dotBg: "bg-blue-400",
    text: "#1f2937",
    label: "Blue",
  },
  purple: {
    bg: "#f3e8ff",
    border: "#8b5cf6",
    dotBg: "bg-purple-400",
    text: "#1f2937",
    label: "Purple",
  },
};

const FONT_SIZES = ["Small", "Medium", "Large", "Extra Large"] as const;
type FontSizeOption = typeof FONT_SIZES[number];

const FONT_SIZE_MAP: Record<FontSizeOption, string> = {
  "Small": "12px",
  "Medium": "14px",
  "Large": "18px",
  "Extra Large": "24px",
};

function ColorSwatch({ colorKey, className }: { colorKey: string; className?: string }) {
  const option = COLOR_OPTIONS[colorKey] || COLOR_OPTIONS.yellow;

  if (option.isTransparent) {
    return (
      <div
        className={cn(
          "relative flex items-center justify-center rounded-full border",
          className,
        )}
        style={{ borderColor: option.swatchBorder ?? "rgba(255,255,255,0.4)" }}
      >
        <Ban size={10} className="text-white/85" strokeWidth={2} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-full border border-white/20",
        option.dotBg,
        className,
      )}
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   DUAL RESIZE HANDLE
   ═══════════════════════════════════════════════════════════════════════════ */
interface DualResizeHandleProps {
  forceVisible?: boolean;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  currentWidth: number;
  currentHeight: number;
  onResize: (width: number, height: number) => void;
  onResizeEnd: (width: number, height: number) => void;
}

function DualResizeHandle({
  minWidth,
  maxWidth,
  minHeight,
  maxHeight,
  currentWidth,
  currentHeight,
  onResize,
  onResizeEnd,
  forceVisible = false,
}: DualResizeHandleProps) {
  const { getZoom } = useReactFlow();
  const [isDragging, setIsDragging] = useState(false);
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    zoom: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: currentWidth,
      startHeight: currentHeight,
      zoom: getZoom(),
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setLiveSize({ w: Math.round(currentWidth), h: Math.round(currentHeight) });
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const deltaY = (e.clientY - s.startY) / s.zoom;
    const nextW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    const nextH = Math.max(minHeight, Math.min(maxHeight, s.startHeight + deltaY));
    onResize(nextW, nextH);
    setLiveSize({ w: Math.round(nextW), h: Math.round(nextH) });
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = dragStateRef.current;
    if (!s) return;
    const deltaX = (e.clientX - s.startX) / s.zoom;
    const deltaY = (e.clientY - s.startY) / s.zoom;
    const finalW = Math.max(minWidth, Math.min(maxWidth, s.startWidth + deltaX));
    const finalH = Math.max(minHeight, Math.min(maxHeight, s.startHeight + deltaY));
    dragStateRef.current = null;
    setIsDragging(false);
    setLiveSize(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    onResizeEnd(finalW, finalH);
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-10 flex items-center justify-center group",
        isDragging ? "[&_path]:opacity-100" : forceVisible ? "[&_path]:opacity-30 group-hover:[&_path]:opacity-100" : "[&_path]:opacity-0",
        "[&_path]:transition-opacity [&_path]:duration-100",
        isDragging && "[&_path]:!opacity-100",
      )}
      style={{
        bottom: 0,
        right: 20,
        width: 48,
        height: 48,
        transform: "translate(50%, 50%)",
        background: "transparent",
        touchAction: "none",
      }}
    >
      {liveSize !== null && (
        <div
          className="absolute pointer-events-none rounded-full border text-[10px] font-mono leading-none px-2 py-1 tabular-nums animate-fade-in"
          style={{
            bottom: "calc(100% + 6px)",
            right: "50%",
            transform: "translateX(50%)",
            backgroundColor: "#ffffff",
            borderColor: "rgba(0,0,0,0.14)",
            color: "rgba(0,0,0,0.9)",
            whiteSpace: "nowrap",
            zIndex: 100,
          }}
          aria-live="polite"
        >
          {liveSize.w} × {liveSize.h}px
        </div>
      )}
      <svg
        viewBox="0 0 48 48"
        style={{
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          overflow: "visible",
        }}
      >
        <path
          d="M 36 22 A 14 14 0 0 1 22 36"
          stroke="rgba(0,0,0,0)"
          strokeWidth="14"
          strokeLinecap="round"
          fill="none"
          pointerEvents="stroke"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <path
          d="M 36 22 A 14 14 0 0 1 22 36"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL COLOR & SIZE DROPDOWNS
   ═══════════════════════════════════════════════════════════════════════════ */
interface DropdownProps {
  buttonRef: React.RefObject<HTMLButtonElement>;
  open: boolean;
  setOpen: (val: boolean) => void;
  menuPos: { left: number; top: number } | null;
  menuId: string;
}


function ColorDropdownPortal({
  buttonRef,
  open,
  setOpen,
  menuId,
  value,
  onChange,
}: {
  buttonRef: React.RefObject<HTMLButtonElement>;
  open: boolean;
  setOpen: (val: boolean) => void;
  menuId: string;
  value: string;
  onChange: (val: string) => void;
}) {
  void menuId;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="h-7 px-2 rounded-full flex items-center justify-center gap-1.5 bg-transparent hover:bg-white/[0.08] transition-all cursor-pointer select-none text-white/70 hover:text-white nodrag"
      >
        <ColorSwatch colorKey={value} className="h-3.5 w-3.5 shrink-0" />
        <DropdownCaret open={open} className="text-white/50 select-none" />
      </button>

      <PickerDropdown
        anchorRef={buttonRef}
        isOpen={open}
        onClose={() => setOpen(false)}
        items={Object.keys(COLOR_OPTIONS).map((key) => ({
          key,
          label: COLOR_OPTIONS[key].label,
        }))}
        activeKey={value}
        onPick={(key) => {
          onChange(key);
          setOpen(false);
        }}
        minWidth={112}
        estimatedHeight={260}
        matchAnchorWidth={false}
        renderItem={(item, state) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              onChange(item.key);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors",
              state.active ? "bg-white/[0.08] text-white" : "text-white/78 hover:bg-white/[0.06] hover:text-white",
            )}
          >
            <ColorSwatch colorKey={item.key} className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-2xs font-medium">{item.label}</span>
            {state.active && <Check size={12} className="shrink-0 text-accent" />}
          </button>
        )}
      />
    </>
  );
}

interface SizeDropdownProps extends DropdownProps {
  value: FontSizeOption;
  onChange: (val: FontSizeOption) => void;
}

function SizeDropdownPortal({
  buttonRef,
  open,
  setOpen,
  menuPos,
  menuId,
  value,
  onChange,
}: SizeDropdownProps) {
  void menuPos;
  void menuId;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="h-7 px-2 rounded-full flex items-center justify-between gap-1 text-[10px] font-medium bg-transparent hover:bg-white/[0.08] transition-all cursor-pointer select-none text-white/70 hover:text-white nodrag"
      >
        <span className="truncate max-w-[80px]">{value}</span>
        <DropdownCaret open={open} className="text-white/50" />
      </button>

      <PickerDropdown
        anchorRef={buttonRef}
        isOpen={open}
        onClose={() => setOpen(false)}
        items={FONT_SIZES.map((size) => ({ key: size, label: size }))}
        activeKey={value}
        onPick={(key) => {
          onChange(key as FontSizeOption);
          setOpen(false);
        }}
        minWidth={104}
        matchAnchorWidth={false}
        estimatedHeight={220}
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   NOTE NODE COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */
export function NoteNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const textHtml = (data.prompt as string | undefined) ?? "";

  // Custom data states
  const noteColor = (data.noteColor as string | undefined) ?? "yellow";
  const noteFontSize = (data.noteFontSize as FontSizeOption | undefined) ?? "Medium";

  // Width & Height Resizing
  const storeWidth = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;
  const storeHeight = (data.nodeHeight as number | undefined) ?? DEFAULT_HEIGHT;

  // Local state for live resize — bypasses store to avoid heavy re-renders
  const [liveW, setLiveW] = useState<number | null>(null);
  const [liveH, setLiveH] = useState<number | null>(null);
  const width = liveW ?? storeWidth;
  const height = liveH ?? storeHeight;

  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseEnter = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
  }, []);

  const onMouseLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHovered(false), 200);
  }, []);

  const showControls = hovered || !!selected;

  const editorRef = useRef<HTMLDivElement>(null);

  // Dropdown States
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showSizeMenu, setShowSizeMenu] = useState(false);
  const [sizeMenuPos, setSizeMenuPos] = useState<{ left: number; top: number } | null>(null);

  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const sizeBtnRef = useRef<HTMLButtonElement>(null);

  // Coordinate tracking for Portals
  useEffect(() => {
    const activePickers = {
      color: { open: showColorMenu, btn: colorBtnRef, setPos: () => {}, menuId: `note-color-menu-${rfId}`, close: () => setShowColorMenu(false) },
      size: { open: showSizeMenu, btn: sizeBtnRef, setPos: setSizeMenuPos, menuId: `note-size-menu-${rfId}`, close: () => setShowSizeMenu(false) },
    };

    const hasAnyOpen = showColorMenu || showSizeMenu;
    if (!hasAnyOpen) {
      setSizeMenuPos(null);
      return;
    }

    let raf = 0;
    function tick() {
      Object.values(activePickers).forEach(({ open, btn, setPos }) => {
        if (open && btn.current) {
          const rect = btn.current.getBoundingClientRect();
          setPos({
            left: rect.left,
            top: rect.bottom + 4,
          });
        } else {
          setPos(null);
        }
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    function onDocumentPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;

      Object.values(activePickers).forEach(({ open, btn, menuId, close }) => {
        if (!open) return;
        if (btn.current && btn.current.contains(target)) return;
        const menuEl = document.getElementById(menuId);
        if (menuEl && menuEl.contains(target)) return;
        close();
      });
    }

    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    };
  }, [showColorMenu, showSizeMenu, rfId]);

  // Sync size changes to board store and persist
  const onResize = useCallback(
    (nextW: number, nextH: number) => {
      setLiveW(nextW);
      setLiveH(nextH);
    },
    [],
  );

  const onResizeEnd = useCallback(
    (nextW: number, nextH: number) => {
      const clampedW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(nextW)));
      const clampedH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(nextH)));
      // Commit to store + persist, then clear local state
      useBoardStore.getState().updateNodeData(rfId, { nodeWidth: clampedW, nodeHeight: clampedH });
      persistNodeData(rfId, { nodeWidth: clampedW, nodeHeight: clampedH });
      setLiveW(null);
      setLiveH(null);
    },
    [rfId],
  );

  // Uncontrolled contentEditable logic: Set once on mount and check sync on external text changes (prevents cursor jumping)
  const lastPromptRef = useRef(textHtml);
  
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = textHtml;
      lastPromptRef.current = textHtml;
    }
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && document.activeElement !== editor && textHtml !== editor.innerHTML) {
      editor.innerHTML = textHtml;
      lastPromptRef.current = textHtml;
    }
  }, [textHtml]);

  // Save the current text selection so it can be restored after portal focus shifts
  const savedSelectionRef = useRef<Range | null>(null);

  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedSelectionRef.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const range = savedSelectionRef.current;
    if (range && editorRef.current) {
      editorRef.current.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, []);

  // Keep selection saved whenever the editor blurs (e.g. toolbar button clicked)
  const handleEditorBlur = useCallback(() => {
    saveSelection();
  }, [saveSelection]);

  // Format Helper — restore focus and selection before execCommand
  const handleFormat = (command: string, value: string = "") => {
    // Restore editor focus + selection so execCommand works
    restoreSelection();
    document.execCommand(command, false, value);
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      lastPromptRef.current = html;
      persistNodeData(rfId, { prompt: html });
    }
    // Re-save the updated selection after formatting
    saveSelection();
  };

  // Handle Note edits and persist
  const handleEditorInput = () => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      lastPromptRef.current = html;
      persistNodeData(rfId, { prompt: html });
    }
  };

  // Handle Color picking
  const handleColorChange = (colorKey: string) => {
    persistNodeData(rfId, { noteColor: colorKey });
  };

  // Handle Font Size picking
  const handleFontSizeChange = (sizeKey: FontSizeOption) => {
    persistNodeData(rfId, { noteFontSize: sizeKey });
  };

  // Duplicate node with offset
  const handleDuplicate = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { boardId, nodes } = useBoardStore.getState();
    if (!boardId) return;

    const sourceNode = nodes.find((n) => n.id === rfId);
    const posX = sourceNode ? sourceNode.position.x : 0;
    const posY = sourceNode ? sourceNode.position.y : 0;

    const offset = 40;
    const nextX = Math.round(posX + offset);
    const nextY = Math.round(posY + offset);

    try {
      await createNode({
        board_id: boardId,
        type: "note",
        x: nextX,
        y: nextY,
        data: {
          ...data,
          title: data.title ? `${data.title} (copy)` : "Note (copy)",
        },
      });
      await useBoardStore.getState().refreshBoardState();
    } catch (err) {
      console.error("Failed to duplicate note node:", err);
    }
  };

  // Delete node
  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useBoardStore.getState().deleteNodeByRfId(rfId);
  };

  // Dynamic Theme Styling
  const colorStyle = COLOR_OPTIONS[noteColor] || COLOR_OPTIONS.yellow;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="relative font-sans select-none group"
      style={{ width, padding: "0 20px 0 20px" }}
    >
      {/* Floating Formatting Toolbar (appears at the top of the Post-it card) */}
      <NodeToolbar
        position={Position.Top}
        offset={12}
        isVisible={showControls}
      >
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="flex items-center gap-1 px-1.5 py-1 rounded-full shadow-lg z-50 animate-fade-in whitespace-nowrap select-none nodrag nowheel"
          style={{
            backgroundColor: "rgba(20, 20, 20, 0.92)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 8px 28px -10px rgba(0,0,0,0.6)",
          }}
        >
          {/* Color dropdown */}
          <div className="relative flex items-center shrink-0">
            <ColorDropdownPortal
              buttonRef={colorBtnRef}
              open={showColorMenu}
              setOpen={setShowColorMenu}
              menuId={`note-color-menu-${rfId}`}
              value={noteColor}
              onChange={handleColorChange}
            />
          </div>

          {/* Size dropdown */}
          <SizeDropdownPortal
            buttonRef={sizeBtnRef}
            open={showSizeMenu}
            setOpen={setShowSizeMenu}
            menuPos={sizeMenuPos}
            menuId={`note-size-menu-${rfId}`}
            value={noteFontSize}
            onChange={handleFontSizeChange}
          />

          <span className="h-4 w-px bg-white/10 mx-0.5" />

          {/* Formatting: Bold */}
          <button
            type="button"
            onClick={() => handleFormat("bold")}
            className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer nodrag"
            title="Bold"
          >
            <Bold size={14} strokeWidth={1.75} />
          </button>

          {/* Formatting: Italic */}
          <button
            type="button"
            onClick={() => handleFormat("italic")}
            className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer nodrag"
            title="Italic"
          >
            <Italic size={14} strokeWidth={1.75} />
          </button>

          {/* Formatting: Bullet List */}
          <button
            type="button"
            onClick={() => handleFormat("insertUnorderedList")}
            className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer nodrag"
            title="Bullet List"
          >
            <List size={14} strokeWidth={1.75} />
          </button>

          {/* Formatting: Numbered List */}
          <button
            type="button"
            onClick={() => handleFormat("insertOrderedList")}
            className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer nodrag"
            title="Numbered List"
          >
            <ListOrdered size={14} strokeWidth={1.75} />
          </button>

          {/* Formatting: Horizontal line */}
          <button
            type="button"
            onClick={() => handleFormat("insertHorizontalRule")}
            className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer nodrag"
            title="Insert line"
          >
            <Minus size={14} strokeWidth={1.75} />
          </button>

          <span className="h-4 w-px bg-white/10 mx-0.5" />

          {/* Action: Duplicate */}
          <button
            type="button"
            onClick={handleDuplicate}
            className="w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer nodrag"
            title="Duplicate"
          >
            <Copy size={14} strokeWidth={1.75} />
          </button>

          {/* Action: Delete */}
          <button
            type="button"
            onClick={handleDelete}
            className="w-7 h-7 flex items-center justify-center rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer nodrag"
            title="Delete"
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      </NodeToolbar>

      {/* Main Post-it Card */}
      <div
        className={cn(
          "relative border flex flex-col p-4 overflow-hidden transition-colors transition-shadow duration-200 ease-out",
          !colorStyle.isTransparent && "shadow-md",
          selected && "ring-2 ring-accent/60",
          selected && !colorStyle.isTransparent && "shadow-lg",
        )}
        style={{
          borderRadius: 16,
          backgroundColor: colorStyle.bg,
          borderColor: colorStyle.border,
          height: `${height}px`,
        }}
      >
        {/* Editor Area (ContentEditable) */}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onInput={handleEditorInput}
          onBlur={handleEditorBlur}
          onMouseDown={(e) => e.stopPropagation()}
          className="nodrag nowheel w-full flex-1 outline-none text-left overflow-y-auto magnific-dropdown-scroll p-1 font-sans cursor-text note-editor-content"
          style={{
            fontSize: FONT_SIZE_MAP[noteFontSize],
            color: colorStyle.text,
            lineHeight: 1.5,
            textShadow: colorStyle.isTransparent ? "0 1px 2px rgba(0,0,0,0.35)" : undefined,
          }}
          data-placeholder="Type something..."
        />

      </div>

      {/* Custom Resize Control - positioned exactly at bottom-right corner of card */}
      <DualResizeHandle
        minWidth={MIN_WIDTH}
        maxWidth={MAX_WIDTH}
        minHeight={MIN_HEIGHT}
        maxHeight={MAX_HEIGHT}
        currentWidth={width}
        currentHeight={height}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        forceVisible={!!selected}
      />
    </div>
  );
}
