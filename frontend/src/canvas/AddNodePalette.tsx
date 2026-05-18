/**
 * Bottom-of-canvas chip palette for adding nodes.
 *
 * Concepta fork (v2): surfaces only the new node taxonomy
 * (Reference, Concept now; Multi-view / Part / Variant in Phase 2;
 * Pose / Turntable in Phase 3). Phase-2/3 chips render disabled with
 * a "soon" badge so the roadmap is visible to the user without
 * letting them create types whose nodes don't yet have a V2 body.
 *
 * Power-user escape hatch: set `localStorage.flowboard_palette =
 * "all"` to also surface the legacy chips (character / image / video
 * / prompt / note / visual_asset / Storyboard) for old-board work.
 */
import { useReactFlow } from "@xyflow/react";

import { useBoardStore } from "../store/board";
import type { NodeType } from "../store/board";

interface Chip {
  type: NodeType;
  icon: string;
  label: string;
  /** Locked chips render disabled with a "soon" badge — used for
   *  Phase 2/3 nodes whose V2 body isn't shipped yet. */
  locked?: boolean;
}

// Concepta core — always visible.
const CORE_CHIPS: Chip[] = [
  { type: "reference", icon: "◇", label: "Reference" },
  { type: "concept", icon: "◆", label: "Concept" },
  { type: "multiview", icon: "▦", label: "Multi-view" },
  { type: "part", icon: "◐", label: "Part" },
  { type: "variant", icon: "◇", label: "Variant" },
];

// Concepta — coming soon. Render disabled so the user sees the
// roadmap without being able to add a half-built node.
const ROADMAP_CHIPS: Chip[] = [
  { type: "pose", icon: "✦", label: "Pose", locked: true },
  { type: "turntable", icon: "▶", label: "Turntable", locked: true },
];

// Legacy escape hatch — flowboard_palette = "all" surfaces these
// chips so old boards (with character / image / etc. nodes) can be
// extended without round-tripping through the API.
const LEGACY_CHIPS: Chip[] = [
  { type: "character", icon: "◎", label: "Character (legacy)" },
  { type: "image", icon: "▣", label: "Image (legacy)" },
  { type: "video", icon: "▶", label: "Video (legacy)" },
  { type: "visual_asset", icon: "◇", label: "Visual asset (legacy)" },
];

function paletteChips(): Chip[] {
  if (typeof window === "undefined") return [...CORE_CHIPS, ...ROADMAP_CHIPS];
  const mode = window.localStorage.getItem("flowboard_palette");
  if (mode === "all") {
    return [...CORE_CHIPS, ...ROADMAP_CHIPS, ...LEGACY_CHIPS];
  }
  return [...CORE_CHIPS, ...ROADMAP_CHIPS];
}

export function AddNodePalette() {
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);

  function handleAdd(type: NodeType) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNodeOfType(type, position);
  }

  /** Template: Character Sheet — Concept + 4 Parts (head/torso/weapon/legs)
   *  pre-wired in a left-to-right layout. One click → 5 nodes + 4 edges. */
  async function handleCharacterSheet() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const origin = screenToFlowPosition({ x: cx - 200, y: cy });

    // 1. Concept node (left)
    const conceptId = await addNodeOfType("concept", origin);
    if (!conceptId) return;

    // 2. Parts (right, stacked vertically)
    const parts: { type: NodeType; region: string; yOffset: number }[] = [
      { type: "part", region: "head", yOffset: -180 },
      { type: "part", region: "torso", yOffset: -60 },
      { type: "part", region: "weapon", yOffset: 60 },
      { type: "part", region: "legs", yOffset: 180 },
    ];

    for (const p of parts) {
      const pos = screenToFlowPosition({ x: cx + 200, y: cy + p.yOffset });
      const partId = await useBoardStore.getState().addNodeOfType(p.type, pos);
      if (partId) {
        // Wire edge (auto-connect may have already done it if concept
        // was selected, but addNodeOfType only auto-connects when 1
        // node is selected — after the first Part is created, 0 nodes
        // are selected so we wire manually here).
        await addEdgeFromConnection(conceptId, partId);
        // Set region key on the Part node
        const dbId = parseInt(partId, 10);
        if (!Number.isNaN(dbId)) {
          useBoardStore.getState().updateNodeData(partId, { regionKey: p.region });
          import("../api/client").then(({ patchNode: pn }) => {
            pn(dbId, { data: { regionKey: p.region } }).catch(() => {});
          });
        }
      }
    }
  }

  /** Template: Turnaround — Concept + Multi-view (4-view) pre-wired. */
  async function handleTurnaround() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const conceptPos = screenToFlowPosition({ x: cx - 150, y: cy });
    const mvPos = screenToFlowPosition({ x: cx + 150, y: cy });

    const conceptId = await addNodeOfType("concept", conceptPos);
    if (!conceptId) return;
    const mvId = await useBoardStore.getState().addNodeOfType("multiview", mvPos);
    if (mvId) {
      await addEdgeFromConnection(conceptId, mvId);
    }
  }

  return (
    <div
      className="absolute top-14 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2 py-1.5 rounded-full"
      style={{
        backgroundColor: "rgba(14, 16, 22, 0.72)",
        backdropFilter: "blur(14px) saturate(1.3)",
        WebkitBackdropFilter: "blur(14px) saturate(1.3)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 4px 20px -4px rgba(0,0,0,0.5), inset 0 1px 0 0 rgba(255,255,255,0.04)",
      }}
      aria-label="Add node"
    >
      <span className="text-xs text-ink-muted px-1 select-none" aria-hidden="true">+</span>
      {paletteChips().map((chip) => (
        <button
          key={chip.type}
          aria-label={`Add ${chip.label} node`}
          disabled={chip.locked}
          title={chip.locked ? "Coming soon" : undefined}
          onClick={() => !chip.locked && handleAdd(chip.type)}
          className={`
            inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full
            text-2xs font-medium whitespace-nowrap transition-all duration-150
            ${chip.locked
              ? "opacity-40 cursor-not-allowed text-ink-muted"
              : "text-ink-muted hover:text-ink-primary hover:bg-white/[0.07] cursor-pointer"
            }
          `}
        >
          <span aria-hidden="true">{chip.icon}</span>
          {chip.label}
          {chip.locked && (
            <span
              aria-hidden="true"
              className="text-[8px] ml-0.5 px-1.5 py-px rounded-full bg-accent/15 text-accent font-semibold uppercase tracking-wider"
            >
              soon
            </span>
          )}
        </button>
      ))}

      {/* Separator */}
      <span className="w-px h-4 bg-white/[0.08] mx-1" aria-hidden="true" />

      {/* Templates — 1-click pre-wired graphs */}
      <button
        onClick={handleCharacterSheet}
        title="Template: Concept + 4 Parts (head, torso, weapon, legs)"
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-2xs font-medium whitespace-nowrap text-accent hover:bg-accent/10 transition-all duration-150 cursor-pointer"
      >
        ⚡ Char Sheet
      </button>
      <button
        onClick={handleTurnaround}
        title="Template: Concept + Multi-view (4-view turnaround)"
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-2xs font-medium whitespace-nowrap text-accent hover:bg-accent/10 transition-all duration-150 cursor-pointer"
      >
        ⚡ Turnaround
      </button>
    </div>
  );
}
