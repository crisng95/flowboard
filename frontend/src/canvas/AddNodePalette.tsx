import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Plus,
  StickyNote,
  MessageSquarePlus,
  MousePointer2,
  Hand,
  Scissors,
  Settings2,
  Undo2,
  Redo2,
  Search,
  Type,
  ImageUp,
  Upload,
  Layers,
  Video,
} from "lucide-react";

import { useBoardStore } from "../store/board";
import type { NodeType } from "../store/board";
import { cn } from "../lib/utils";

interface NodeEntry {
  type: NodeType;
  icon: typeof Type;
  label: string;
  disabled?: boolean;
  badge?: string;
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
    ],
  },
  {
    name: "REFERENCES",
    nodes: [
      { type: "add_reference", icon: ImageUp, label: "Add Reference", disabled: true, badge: "Soon" },
    ],
  },
  {
    name: "IMAGE",
    nodes: [
      { type: "reference", icon: ImageUp, label: "Image Generator" },
      { type: "variant", icon: Layers, label: "Variant" },
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

export function AddNodePanel({ onClose, position }: { onClose: () => void; position?: { x: number; y: number } }) {
  const [search, setSearch] = useState("");
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);

  function handleAdd(type: NodeType) {
    const pos = position
      ? screenToFlowPosition({ x: position.x, y: position.y })
      : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addNodeOfType(type, pos);
    onClose();
  }

  const filtered = CATEGORIES.map((cat) => ({
    ...cat,
    nodes: cat.nodes.filter((n) =>
      n.label.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter((cat) => cat.nodes.length > 0);

  return (
    <div
      className="absolute top-0 left-12 z-50 w-[240px] rounded-xl border border-white/[0.08] shadow-2xl"
      style={{ backgroundColor: "#1a1a1a" }}
    >
      {/* Search */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/[0.06]">
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

      {/* Node list */}
      <div className="py-2 max-h-[360px] overflow-y-auto img-gen-prompt">
        {filtered.map((cat) => (
          <div key={cat.name}>
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-white/30 uppercase tracking-wider">
              {cat.name}
            </div>
            {cat.nodes.map((node) => (
              <button
                key={node.type}
                onClick={() => !node.disabled && handleAdd(node.type)}
                disabled={node.disabled}
                className={cn(
                  "flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors",
                  node.disabled
                    ? "text-white/35 cursor-not-allowed"
                    : "text-white/80 hover:text-white hover:bg-white/[0.06] cursor-pointer",
                )}
                title={node.disabled ? `${node.label} is coming soon` : node.label}
              >
                <node.icon size={16} strokeWidth={1.5} className="shrink-0 text-white/50" />
                <span className="min-w-0 flex-1 text-left">{node.label}</span>
                {node.badge && (
                  <span className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/45">
                    {node.badge}
                  </span>
                )}
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

      <span className="h-px w-5 bg-white/[0.08] my-0.5" />

      <button
        type="button"
        className="flex items-center justify-center w-9 h-9 rounded-full text-white/60 hover:text-white hover:bg-white/[0.08] transition-all duration-150 cursor-pointer"
        title="Settings"
      >
        <Settings2 size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
