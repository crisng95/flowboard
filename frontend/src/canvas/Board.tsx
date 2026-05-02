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
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";

import { useBoardStore, type FlowNode, type NodeType } from "../store/board";
import { NodeCard } from "./NodeCard";
import { VariantEdge } from "./VariantEdge";
import { useGenerationStore } from "../store/generation";

const nodeTypes = {
  character: NodeCard,
  image: NodeCard,
  video: NodeCard,
  prompt: NodeCard,
  note: NodeCard,
  visual_asset: NodeCard,
};

// Single edge type used for everything — VariantEdge renders the
// default bezier line and additionally surfaces a `v{N}` chip when the
// edge has a variant pin in `data.sourceVariantIdx`.
const edgeTypes = {
  default: VariantEdge,
};

const defaultEdgeOptions = {
  // Bump the visible stroke + a wider transparent hit area so the edge is
  // easy to *select*. Selected edge is then deleted via Backspace/Delete.
  style: { stroke: "var(--border)", strokeWidth: 2, cursor: "pointer" },
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
      <button type="button" className="drop-popover__btn" onClick={() => handle("image")}>
        <span className="drop-popover__icon">▣</span> Image
      </button>
      <button type="button" className="drop-popover__btn" onClick={() => handle("video")}>
        <span className="drop-popover__icon">▶</span> Video
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

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addEdgeFromConnection(connection.source, connection.target);
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
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2a2e38" />
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
