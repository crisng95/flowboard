import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Plus,
  StickyNote,
  Undo2,
  Redo2,
  Search,
  Type,
  ImageUp,
  Upload,
  Video,
  Sparkles,
  Image,
  Layers,
  Palette,
  Box,
  RotateCw,
  PersonStanding,
  Puzzle,
  LayoutGrid,
  Clapperboard,
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
    ],
  },
  {
    name: "REFERENCES",
    nodes: [
      { type: "add_reference", icon: ImageUp, label: "Add Reference" },
    ],
  },
  {
    name: "IMAGE",
    nodes: [
      { type: "reference", icon: ImageUp, label: "Image Generator" },
      { type: "image", icon: Image, label: "Image" },
      { type: "visual_asset", icon: Sparkles, label: "Visual Asset" },
      { type: "concept", icon: Box, label: "Concept" },
      { type: "multiview", icon: LayoutGrid, label: "Multi-view" },
      { type: "variant", icon: Layers, label: "Variant" },
      { type: "style_pack", icon: Palette, label: "Style Pack" },
    ],
  },
  {
    name: "CHARACTER",
    nodes: [
      { type: "character", icon: PersonStanding, label: "Character" },
      { type: "pose", icon: PersonStanding, label: "Pose" },
      { type: "part", icon: Puzzle, label: "Part" },
      { type: "turntable", icon: RotateCw, label: "Turntable" },
    ],
  },
  {
    name: "VIDEO",
    nodes: [
      { type: "video", icon: Video, label: "Video" },
      { type: "Storyboard", icon: Clapperboard, label: "Storyboard" },
    ],
  },
  {
    name: "MEDIA",
    nodes: [
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
                onClick={() => handleAdd(node.type)}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-white/80 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <node.icon size={16} strokeWidth={1.5} className="shrink-0 text-white/50" />
                {node.label}
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

  return (
    <div
      className="absolute top-1/2 -translate-y-1/2 left-4 z-10 flex flex-col items-center gap-1 px-1 py-1.5 rounded-xl"
      style={{
        backgroundColor: "rgba(14, 16, 22, 0.8)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Add node button */}
      <div className="relative">
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          className={cn(
            "flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 cursor-pointer",
            panelOpen
              ? "bg-white/[0.12] text-white"
              : "text-white/60 hover:text-white hover:bg-white/[0.08]",
          )}
          title="Add node"
        >
          <Plus size={16} strokeWidth={2} />
        </button>
        {panelOpen && <AddNodePanel onClose={() => setPanelOpen(false)} />}
      </div>

      {/* Note mode button (placeholder) */}
      <button
        className="flex items-center justify-center w-8 h-8 rounded-lg text-white/60 hover:text-white hover:bg-white/[0.08] transition-all duration-150 cursor-pointer"
        title="Note (coming soon)"
        disabled
      >
        <StickyNote size={16} strokeWidth={1.5} />
      </button>

      {/* Separator */}
      <span className="h-px w-4 bg-white/[0.08] my-0.5" />

      {/* Undo */}
      <button
        className="flex items-center justify-center w-8 h-8 rounded-lg text-white/60 hover:text-white hover:bg-white/[0.08] transition-all duration-150 cursor-pointer"
        title="Undo"
      >
        <Undo2 size={16} strokeWidth={1.5} />
      </button>

      {/* Redo */}
      <button
        className="flex items-center justify-center w-8 h-8 rounded-lg text-white/60 hover:text-white hover:bg-white/[0.08] transition-all duration-150 cursor-pointer"
        title="Redo"
      >
        <Redo2 size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
