import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";

import { useBoardStore, type FlowNode, type NodeType } from "../store/board";
import { NodeCard } from "./NodeCard";
import { VariantEdge } from "./VariantEdge";
import { useGenerationStore } from "../store/generation";
import { getUiVersion } from "../lib/utils";
import { ReferenceNode } from "./v2/ReferenceNode";
import { ConceptNode } from "./v2/ConceptNode";
import { MultiviewNode } from "./v2/MultiviewNode";
import { PartNode } from "./v2/PartNode";
import { VariantNode } from "./v2/VariantNode";
import { UploadNode } from "./v2/UploadNode";
import { ImageGeneratorNode } from "./v2/ImageGeneratorNode";
import { TextNode } from "./v2/TextNode";
import { DashedConnectionLine } from "./DashedConnectionLine";

// V2 components are opt-in via `localStorage.flowboard_ui = "v2"`. For
// the Concepta fork, V2 introduces the new `reference` and `concept`
// node types — legacy types still render via the old NodeCard until
// (and unless) we migrate them. The map below routes EVERY type
// React Flow knows about so an old board with `character` nodes still
// renders without crashing the canvas.
const useV2 = getUiVersion() === "v2";

const nodeTypes = useV2
  ? {
      // Legacy types — keep rendering with the old NodeCard so old
      // boards still load. Palette doesn't surface these in V2 mode.
      character: NodeCard,
      image: NodeCard,
      video: NodeCard,
      prompt: NodeCard,
      note: NodeCard,
      visual_asset: ReferenceNode, // alias old type to new node body
      Storyboard: NodeCard,
      // Concepta fork V2
      reference: ImageGeneratorNode,
      style_pack: NodeCard, // TODO Phase 1 polish
      concept: ConceptNode,
      multiview: MultiviewNode,
      part: PartNode,
      variant: VariantNode,
      upload: UploadNode,
      text: TextNode,
      pose: NodeCard, // TODO Phase 3
      turntable: NodeCard, // TODO Phase 3
    }
  : {
      character: NodeCard,
      image: NodeCard,
      video: NodeCard,
      prompt: NodeCard,
      note: NodeCard,
      visual_asset: NodeCard,
      Storyboard: NodeCard,
      reference: NodeCard,
      style_pack: NodeCard,
      concept: NodeCard,
      multiview: NodeCard,
      part: NodeCard,
      variant: NodeCard,
      upload: NodeCard,
      text: NodeCard,
      pose: NodeCard,
      turntable: NodeCard,
    };

// Single edge type used for everything — VariantEdge renders the
// default bezier line and additionally surfaces a `v{N}` chip when the
// edge has a variant pin in `data.sourceVariantIdx`.
const edgeTypes = {
  default: VariantEdge,
};

const defaultEdgeOptions = {
  // Violet accent stroke so edges read as "data flowing" instead of
  // blending into the canvas dot grid. Wider transparent hit area
  // (24px) keeps selection forgiving. Selected edge gets a glow via
  // the CSS rule in globals.css.
  style: { stroke: "rgba(124, 92, 255, 0.45)", strokeWidth: 2, cursor: "pointer" },
  interactionWidth: 24,
};

// Quick-add popover that appears when the user drops a connection drag on
// empty canvas. Lives inside <ReactFlow> so it can use useReactFlow for
// screen↔flow coord conversion. Two buttons: Image, Video. Click → create
// node at the cursor + auto-connect from the source handle.
function DropAddPopover({
  popover,
  onPick,
  onClose,
}: {
  popover: { clientX: number; clientY: number; sourceId: string } | null;
  onPick: (type: NodeType, flowPos: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();

  // Auto-dismiss after 3s of no interaction so the popover doesn't linger
  // when the user actually meant to discard the drag.
  useEffect(() => {
    if (!popover) return;
    const t = window.setTimeout(onClose, 3000);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onOutside = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".drop-popover")) onClose();
    };
    document.addEventListener("keydown", onEsc);
    document.addEventListener("mousedown", onOutside);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [popover, onClose]);

  if (!popover) return null;

  const handle = (type: NodeType) => {
    const flowPos = screenToFlowPosition({ x: popover.clientX, y: popover.clientY });
    onPick(type, flowPos);
  };

  return (
    <div
      className="drop-popover"
      style={{ left: popover.clientX + 8, top: popover.clientY + 8 }}
      role="menu"
      aria-label="Add connected node"
    >
      <button type="button" className="drop-popover__btn" onClick={() => handle("multiview")}>
        <span className="drop-popover__icon">▦</span> Multi-view
      </button>
      <button type="button" className="drop-popover__btn" onClick={() => handle("part")}>
        <span className="drop-popover__icon">◐</span> Part
      </button>
      <button type="button" className="drop-popover__btn" onClick={() => handle("variant")}>
        <span className="drop-popover__icon">◇</span> Variant
      </button>
    </div>
  );
}

export function Board() {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setEdges = useBoardStore((s) => s.setEdges);
  const persistNodePosition = useBoardStore((s) => s.persistNodePosition);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const deleteEdgeByRfId = useBoardStore((s) => s.deleteEdgeByRfId);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [dropPopover, setDropPopover] = useState<
    { clientX: number; clientY: number; sourceId: string } | null
  >(null);
  // Drag-state: whether a connection was successfully made. onConnect fires
  // before onConnectEnd, so we use this to decide whether the drop landed
  // on empty canvas (→ show popover) or on a real handle (→ already wired).
  const connectStateRef = useRef<{ sourceId: string | null; didConnect: boolean }>({
    sourceId: null,
    didConnect: false,
  });

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes(applyNodeChanges(changes, useBoardStore.getState().nodes) as FlowNode[]);
    },
    [setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, useBoardStore.getState().edges));
    },
    [setEdges],
  );

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      persistNodePosition(node.id, node.position);
    },
    [persistNodePosition],
  );


  // Connection validation: only allow compatible handle types
  // Text nodes (type="text") can only connect to "target-text" handles
  // Image nodes (type="upload"/"reference"/etc) can only connect to "target-image" handles
  // If target has no specific handle id (legacy nodes), allow any connection
  const TEXT_SOURCE_TYPES = new Set(["text"]);
  const IMAGE_SOURCE_TYPES = new Set(["upload", "reference", "image", "visual_asset", "character", "concept", "multiview", "part", "variant", "Storyboard"]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;
      const targetHandle = connection.targetHandle;
      if (!targetHandle || targetHandle === "target") return true;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      if (!sourceNode) return true;
      const sourceType = sourceNode.data.type;
      if (targetHandle === "target-text") {
        return TEXT_SOURCE_TYPES.has(sourceType);
      }
      if (targetHandle === "target-image") {
        return IMAGE_SOURCE_TYPES.has(sourceType);
      }
      return true;
    },
    [nodes],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addEdgeFromConnection(connection.source, connection.target, connection.sourceHandle ?? undefined, connection.targetHandle ?? undefined);
        connectStateRef.current.didConnect = true;
      }
    },
    [addEdgeFromConnection],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      // Only track drags that started from a source handle (the right side
      // of a node). Target-side drags are unusual and the current edges
      // are directional source→target, so we don't open the popover for
      // those.
      if (params.handleType !== "source" || !params.nodeId) {
        connectStateRef.current = { sourceId: null, didConnect: false };
        return;
      }
      connectStateRef.current = { sourceId: params.nodeId, didConnect: false };
    },
    [],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const { sourceId, didConnect } = connectStateRef.current;
      connectStateRef.current = { sourceId: null, didConnect: false };
      if (!sourceId || didConnect) return;
      // Drop on empty canvas — pop up a quick-add menu at the release
      // point. Coords are in client (screen) space; the popover will
      // convert to flow space for the new node's position.
      const e = event as MouseEvent;
      const cx = typeof e.clientX === "number" ? e.clientX : 0;
      const cy = typeof e.clientY === "number" ? e.clientY : 0;
      setDropPopover({ clientX: cx, clientY: cy, sourceId });
    },
    [],
  );

  const handlePickAdd = useCallback(
    async (type: NodeType, flowPos: { x: number; y: number }) => {
      const sourceId = dropPopover?.sourceId;
      setDropPopover(null);
      if (!sourceId) return;
      const newId = await addNodeOfType(type, flowPos);
      if (newId) {
        await addEdgeFromConnection(sourceId, newId);
      }
    },
    [dropPopover, addNodeOfType, addEdgeFromConnection],
  );

  const onNodesDelete = useCallback(
    (deletedNodes: FlowNode[]) => {
      deletedNodes.forEach((n) => deleteNodeByRfId(n.id));
    },
    [deleteNodeByRfId],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: { id: string }[]) => {
      deletedEdges.forEach((e) => deleteEdgeByRfId(e.id));
    },
    [deleteEdgeByRfId],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: FlowNode) => {
      const isGenerable = ["image", "prompt", "video", "visual_asset", "character"].includes(node.data.type);
      if (!isGenerable) return;
      const s = useGenerationStore.getState();
      if (node.data.mediaId) {
        s.openResultViewer(node.id);
      } else {
        s.openGenerationDialog(node.id, node.data.prompt ?? "");
      }
    },
    [],
  );

  // Keyboard shortcut: g key opens generation dialog for selected image/prompt node
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip if modifier keys, or if focus is in an editable element
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const tag = (active?.tagName ?? "").toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key !== "g") return;

      const selectedNodes = useBoardStore
        .getState()
        .nodes.filter(
          (n) =>
            n.selected &&
            ["image", "prompt", "video", "character"].includes(n.data.type),
        );
      if (selectedNodes.length === 0) return;
      e.preventDefault();
      const target = selectedNodes[0];
      const s = useGenerationStore.getState();
      if (target.data.mediaId) {
        s.openResultViewer(target.id);
      } else {
        s.openGenerationDialog(target.id, target.data.prompt ?? "");
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div ref={wrapperRef} style={{ flex: 1, minHeight: 0, width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={defaultEdgeOptions}
        // Larger connection-drop radius so users don't have to land
        // pixel-perfect on the handle to complete an edge.
        connectionRadius={32}
        isValidConnection={isValidConnection}
        connectionLineComponent={DashedConnectionLine}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,0.04)" />
        <MiniMap pannable zoomable />
        <Controls />
        <DropAddPopover
          popover={dropPopover}
          onPick={handlePickAdd}
          onClose={() => setDropPopover(null)}
        />
      </ReactFlow>
    </div>
  );
}
