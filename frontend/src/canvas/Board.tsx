import { useCallback, useEffect, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
} from "@xyflow/react";

import { useBoardStore, type FlowNode } from "../store/board";
import { NodeCard } from "./NodeCard";
import { useGenerationStore } from "../store/generation";

const nodeTypes = {
  character: NodeCard,
  image: NodeCard,
  video: NodeCard,
  prompt: NodeCard,
  note: NodeCard,
};

const defaultEdgeOptions = {
  style: { stroke: "var(--border)", strokeWidth: 1.5 },
};

export function Board() {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setEdges = useBoardStore((s) => s.setEdges);
  const persistNodePosition = useBoardStore((s) => s.persistNodePosition);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const deleteEdgeByRfId = useBoardStore((s) => s.deleteEdgeByRfId);
  const wrapperRef = useRef<HTMLDivElement>(null);

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
      }
    },
    [addEdgeFromConnection],
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
      const isGenerable = ["image", "prompt", "video"].includes(node.data.type);
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
            n.selected && ["image", "prompt", "video"].includes(n.data.type),
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
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2a2e38" />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
    </div>
  );
}
