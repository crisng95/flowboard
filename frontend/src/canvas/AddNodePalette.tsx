import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Plus,
  StickyNote,
  MessageSquarePlus,
  Bot,
  MousePointer2,
  Hand,
  Scissors,
  Undo2,
  Redo2,
  Search,
  Type,
  ImageUp,
  Upload,
  Layers,
  List,
  Video,
} from "lucide-react";

import { useBoardStore } from "../store/board";
import type { NodeType } from "../store/board";
import { cn } from "../lib/utils";

interface NodeEntry {
  type: NodeType;
  icon: typeof Type;
  label: string;
}

interface Category {
  name: string;
  nodes: NodeEntry[];
}

const CATEGORIES: Category[] = [
  {
    name: "BASICS",
    nodes: [
      { type: "text", icon: Type, label: "Text" },
      { type: "note", icon: StickyNote, label: "Note" },
      { type: "assistant", icon: Bot, label: "Assistant" },
    ],
  },
  {
    name: "IMAGE",
    nodes: [
      { type: "reference", icon: ImageUp, label: "Image Generator" },
      { type: "variant", icon: Layers, label: "Variant" },
      { type: "list", icon: List, label: "List" },
    ],
  },
  {
    name: "MEDIA",
    nodes: [
      { type: "video", icon: Video, label: "Video Generator" },
      { type: "upload", icon: Upload, label: "Upload" },
    ],
  },
];

const PANEL_WIDTH = 240;
const PANEL_ESTIMATED_HEIGHT = 388;
const VIEWPORT_PAD = 12;
const MENU_GAP = 8;

function samePanelStyle(a: CSSProperties | null, b: CSSProperties): boolean {
  if (!a) return false;
  return a.left === b.left
    && a.top === b.top
    && a.transform === b.transform
    && a.maxHeight === b.maxHeight;
}

export function AddNodePanel({ onClose, position }: { onClose: () => void; position?: { x: number; y: number } }) {
  const [search, setSearch] = useState("");
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);

  const baseFloatingStyle = useMemo<CSSProperties>(() => {
    if (!position) return { backgroundColor: "#1a1a1a" };
    const viewportW = window.innerWidth;
    const left = Math.max(
      VIEWPORT_PAD,
      Math.min(position.x + MENU_GAP, viewportW - VIEWPORT_PAD - PANEL_WIDTH),
    );

    return {
      backgroundColor: "#1a1a1a",
      position: "fixed",
      left,
      top: position.y + MENU_GAP,
      maxHeight: Math.max(160, window.innerHeight - position.y - VIEWPORT_PAD - MENU_GAP),
    };
  }, [position]);

  const panelStyle = position ? (floatingStyle ?? baseFloatingStyle) : baseFloatingStyle;
  const listMaxHeight = typeof panelStyle.maxHeight === "number"
    ? Math.max(96, panelStyle.maxHeight - 38)
    : 360;

  function handleAdd(type: NodeType) {
    const pos = position
      ? screenToFlowPosition({ x: position.x, y: position.y })
      : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addNodeOfType(type, pos);
    onClose();
  }

  const filtered = useMemo(
    () => CATEGORIES.map((cat) => ({
      ...cat,
      nodes: cat.nodes.filter((n) => n.label.toLowerCase().includes(search.toLowerCase())),
    })).filter((cat) => cat.nodes.length > 0),
    [search],
  );

  useLayoutEffect(() => {
    if (!position) return;

    const updatePlacement = () => {
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const searchHeight = searchRef.current?.getBoundingClientRect().height ?? 38;
      const naturalListHeight = listRef.current?.scrollHeight ?? 360;
      const naturalPanelHeight = Math.min(
        PANEL_ESTIMATED_HEIGHT,
        searchHeight + Math.min(naturalListHeight, 360),
      );
      const availableBelow = viewportH - position.y - VIEWPORT_PAD - MENU_GAP;
      const availableAbove = position.y - VIEWPORT_PAD - MENU_GAP;
      const openUp = naturalPanelHeight > availableBelow && availableAbove > availableBelow;
      const maxHeight = Math.max(160, openUp ? availableAbove : availableBelow);
      const left = Math.max(
        VIEWPORT_PAD,
        Math.min(position.x + MENU_GAP, viewportW - VIEWPORT_PAD - PANEL_WIDTH),
      );

      const nextStyle: CSSProperties = {
        backgroundColor: "#1a1a1a",
        position: "fixed",
        left,
        top: openUp ? position.y - MENU_GAP : position.y + MENU_GAP,
        transform: openUp ? "translateY(-100%)" : undefined,
        maxHeight,
      };
      setFloatingStyle((prev) => (samePanelStyle(prev, nextStyle) ? prev : nextStyle));
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [filtered, position]);

  return (
    <div
      ref={panelRef}
      className={cn(
        "z-50 flex w-[240px] flex-col rounded-xl border border-white/[0.08] shadow-2xl overflow-hidden",
        position ? "" : "absolute top-0 left-12",
      )}
      style={panelStyle}
    >
      <div ref={searchRef} className="flex items-center gap-2 px-3 py-2.5 border-b border-white/[0.06]">
        <Search size={14} strokeWidth={1.5} className="text-white/40 shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          autoFocus
          className="flex-1 bg-transparent text-sm text-white placeholder:text-white/40 outline-none border-0"
        />
      </div>

      <div ref={listRef} className="py-2 min-h-0 overflow-y-auto img-gen-prompt" style={{ maxHeight: listMaxHeight }}>
        {filtered.map((cat) => (
          <div key={cat.name}>
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-white/30 uppercase tracking-wider">
              {cat.name}
            </div>
            {cat.nodes.map((node) => (
              <button
                key={node.type}
                onClick={() => handleAdd(node.type)}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors text-white/80 hover:text-white hover:bg-white/[0.06] cursor-pointer"
                title={node.label}
              >
                <node.icon size={16} strokeWidth={1.5} className="shrink-0 text-white/50" />
                <span className="min-w-0 flex-1 text-left">{node.label}</span>
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-sm text-white/30 text-center">No results</div>
        )}
      </div>
    </div>
  );
}

export function AddNodePalette() {
  const [panelOpen, setPanelOpen] = useState(false);
  const tool = useBoardStore((s) => s.toolMode);
  const setToolMode = useBoardStore((s) => s.setToolMode);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const canUndo = useBoardStore((s) => s.historyPast.length > 0);
  const canRedo = useBoardStore((s) => s.historyFuture.length > 0);
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);

  function spawnNote() {
    const pos = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    void addNodeOfType("note", pos);
  }

  return (
    <div
      className="absolute top-1/2 -translate-y-1/2 left-4 z-40 nowheel nodrag flex flex-col items-center gap-1 px-1.5 py-2 rounded-[22px]"
      style={{
        backgroundColor: "rgba(20, 21, 27, 0.88)",
        backdropFilter: "blur(18px)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 20px 40px rgba(0,0,0,0.35)",
      }}
    >
      <div className="relative">
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          className={cn(
            "flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150 cursor-pointer",
            panelOpen
              ? "bg-white text-black"
              : "text-white/80 hover:text-white hover:bg-white/[0.08]",
          )}
          title="Add node"
        >
          <Plus size={16} strokeWidth={2} />
        </button>
        {panelOpen && <AddNodePanel onClose={() => setPanelOpen(false)} />}
      </div>

      <button
        type="button"
        onClick={() => setToolMode("select")}
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150 cursor-pointer",
          tool === "select" ? "bg-white text-black" : "text-white/60 hover:text-white hover:bg-white/[0.08]",
        )}
        title="Select tool"
      >
        <MousePointer2 size={16} strokeWidth={1.5} />
      </button>

      <button
        type="button"
        onClick={() => setToolMode("pan")}
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150 cursor-pointer",
          tool === "pan" ? "bg-white text-black" : "text-white/60 hover:text-white hover:bg-white/[0.08]",
        )}
        title="Pan tool"
      >
        <Hand size={16} strokeWidth={1.5} />
      </button>

      <button
        type="button"
        onClick={() => setToolMode("cut")}
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150 cursor-pointer",
          tool === "cut" ? "bg-white text-black" : "text-white/60 hover:text-white hover:bg-white/[0.08]",
        )}
        title="Cut connections"
      >
        <Scissors size={16} strokeWidth={1.5} />
      </button>

      <span className="h-px w-5 bg-white/[0.08] my-0.5" />

      <button
        type="button"
        onClick={spawnNote}
        className="flex items-center justify-center w-9 h-9 rounded-full text-white/60 hover:text-white hover:bg-white/[0.08] transition-all duration-150 cursor-pointer"
        title="Add note"
      >
        <MessageSquarePlus size={16} strokeWidth={1.5} />
      </button>

      <button
        type="button"
        onClick={() => void undo()}
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150",
          canUndo ? "text-white/60 hover:text-white hover:bg-white/[0.08] cursor-pointer" : "text-white/35 cursor-not-allowed",
        )}
        title="Undo"
        disabled={!canUndo}
      >
        <Undo2 size={16} strokeWidth={1.5} />
      </button>

      <button
        type="button"
        onClick={() => void redo()}
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150",
          canRedo ? "text-white/60 hover:text-white hover:bg-white/[0.08] cursor-pointer" : "text-white/35 cursor-not-allowed",
        )}
        title="Redo"
        disabled={!canRedo}
      >
        <Redo2 size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
