import { useReactFlow } from "@xyflow/react";
import { useBoardStore } from "../store/board";
import type { NodeType } from "../store/board";

interface Chip {
  type: NodeType;
  icon: string;
  label: string;
}

const CHIPS: Chip[] = [
  { type: "character", icon: "◎", label: "Character" },
  { type: "image", icon: "▣", label: "Image" },
  { type: "video", icon: "▶", label: "Video" },
  { type: "prompt", icon: "✦", label: "Prompt" },
  { type: "note", icon: "✎", label: "Note" },
];

export function AddNodePalette() {
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);

  function handleAdd(type: NodeType) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNodeOfType(type, position);
  }

  return (
    <div className="add-node-palette" aria-label="Add node">
      <span className="add-node-plus" aria-hidden="true">+</span>
      {CHIPS.map((chip) => (
        <button
          key={chip.type}
          className="add-node-chip"
          aria-label={`Add ${chip.label} node`}
          onClick={() => handleAdd(chip.type)}
        >
          <span aria-hidden="true">{chip.icon}</span>
          {chip.label}
        </button>
      ))}
    </div>
  );
}
