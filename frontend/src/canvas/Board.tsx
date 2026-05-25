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
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";

import { deleteNode as apiDeleteNode } from "../api/client";
import { useBoardStore, type FlowNode, type NodeType, registerUpdateNodeInternals } from "../store/board";
import { NodeCard } from "./NodeCard";
import { VariantEdge } from "./VariantEdge";
import { useGenerationStore } from "../store/generation";
import { getUiVersion } from "../lib/utils";
import { AddReferenceNode } from "./v2/AddReferenceNode";
import { VariantNode } from "./v2/VariantNode";
import { UploadNode } from "./v2/UploadNode";
import { ImageGeneratorNode } from "./v2/ImageGeneratorNode";
import { AddNodePanel } from "./AddNodePalette";
import { TextNode } from "./v2/TextNode";
import { NoteNode } from "./v2/NoteNode";
import { GroupNodeShell } from "./v2/GroupNodeShell";
import { SelectionContextMenu } from "./SelectionContextMenu";
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
      note: NoteNode,
      reference: ImageGeneratorNode,
      variant: VariantNode,
      upload: UploadNode,
      text: TextNode,
      add_reference: AddReferenceNode,
      group: GroupNodeShell,
    }
  : {
      note: NodeCard,
      reference: NodeCard,
      variant: NodeCard,
      upload: NodeCard,
      text: NodeCard,
      add_reference: AddReferenceNode,
      group: GroupNodeShell,
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
  // Layer contract:
  //   group frames  = -1
  //   edges         = 0
  //   regular nodes = 1
  // This keeps wires beneath normal cards while still visible above
  // large tinted group backgrounds.
  zIndex: 0,
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
    >`r`n      <button type="button" className="drop-popover__btn" onClick={() => handle("variant")}>
        <span className="drop-popover__icon">◇</span> Variant
      </button>
    </div>
  );
}

export function Board({
  showMiniMap = true,
  showControls = true,
}: {
  showMiniMap?: boolean;
  showControls?: boolean;
}) {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const toolMode = useBoardStore((s) => s.toolMode);
  const commitHistorySnapshot = useBoardStore((s) => s.commitHistorySnapshot);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setEdges = useBoardStore((s) => s.setEdges);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const deleteEdgeByRfId = useBoardStore((s) => s.deleteEdgeByRfId);
  const { screenToFlowPosition } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Hook up ReactFlow's internal cache-invalidation callback to the board store
  // so that grouping/ungrouping actions can ask RF to re-measure parent-relative coordinates.
  useEffect(() => {
    registerUpdateNodeInternals(updateNodeInternals);
    return () => {
      registerUpdateNodeInternals(null);
    };
  }, [updateNodeInternals]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      commitHistorySnapshot();
    }, 260);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, commitHistorySnapshot]);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectionContextMenu, setSelectionContextMenu] = useState<{ x: number; y: number } | null>(null);

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

  // Reference-panel drop handler — fires when the user drags a saved
  // reference card from the right-side library onto the canvas. We
  // detect the custom MIME we set in ReferencesPanel and spawn a new
  // add_reference node at the cursor's flow-space position. The browser
  // requires onDragOver to call preventDefault() or the onDrop never
  // fires on this element.
  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-flowboard-reference")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData("application/x-flowboard-reference");
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const ref = JSON.parse(raw) as {
          mediaId: string;
          aiBrief?: string | null;
          aspectRatio?: string | null;
          kind: string;
          label: string;
        };
        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        void useBoardStore.getState().addReferenceNode(ref, flowPos);
      } catch (err) {
        console.warn("Failed to parse reference drop payload", err);
      }
    },
    [screenToFlowPosition],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Persist node deletes immediately. ReactFlow ALSO fires
      // `onNodesDelete` for the same event, but we don't trust it as the
      // sole hook because in some keyboard-focus configurations only the
      // `onNodesChange` event with type:"remove" fires (the local state
      // updates via applyNodeChanges but onNodesDelete never gets called
      // → node visually disappears but reappears on reload because the
      // backend never heard about it). Calling deleteNodeByRfId here
      // covers both cases; the action is idempotent server-side (404 on
      // the second call is silently swallowed).
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteNodeByRfId(c.id);
        }
      }
      setNodes(applyNodeChanges(changes, useBoardStore.getState().nodes) as FlowNode[]);
    },
    [setNodes, deleteNodeByRfId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Same fix as onNodesChange — backend deletion is driven by the
      // change event, not by ReactFlow's separate onEdgesDelete callback.
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteEdgeByRfId(c.id);
        }
      }
      setEdges(applyEdgeChanges(changes, useBoardStore.getState().edges));
    },
    [setEdges, deleteEdgeByRfId],
  );

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      if (!node || !node.position) return;
      const { nodes, reparentNode, persistNodePosition } = useBoardStore.getState();

      // Calculate absolute position of the dragged node
      let absX = node.position.x;
      let absY = node.position.y;
      if (node.parentId) {
        const parent = nodes.find((n) => n.id === node.parentId);
        if (parent) {
          absX += parent.position.x;
          absY += parent.position.y;
        }
      }

      const nodeStyle = (node.style ?? {}) as { width?: number; height?: number };
      const nodeW = node.measured?.width ?? nodeStyle.width ?? node.data.nodeWidth ?? 260;
      const nodeH = node.measured?.height ?? nodeStyle.height ?? 200;
      const nodeCenterX = absX + nodeW / 2;
      const nodeCenterY = absY + nodeH / 2;

      // Rule: Exclude the node's current parent group when looking for new groups
      const potentialGroups = nodes.filter((g) => {
        if (g.data.type !== "group" || g.id === node.id) return false;
        if (node.parentId && g.id === node.parentId) return false;
        return true;
      });

      // Find all groups containing the node's center
      const matchingGroups = potentialGroups.filter((g) => {
        const groupStyle = (g.style ?? {}) as { width?: number; height?: number };
        const gW = g.measured?.width ?? groupStyle.width ?? 320;
        const gH = g.measured?.height ?? groupStyle.height ?? 200;
        const gX = g.position.x;
        const gY = g.position.y;

        return (
          nodeCenterX >= gX &&
          nodeCenterX <= gX + gW &&
          nodeCenterY >= gY &&
          nodeCenterY <= gY + gH
        );
      });

      let targetGroup: FlowNode | undefined = undefined;
      if (matchingGroups.length > 0) {
        // Grouping Priority: Sort by area in ascending order (smallest first)
        matchingGroups.sort((a, b) => {
          const aStyle = (a.style ?? {}) as { width?: number; height?: number };
          const aW = a.measured?.width ?? aStyle.width ?? 320;
          const aH = a.measured?.height ?? aStyle.height ?? 200;

          const bStyle = (b.style ?? {}) as { width?: number; height?: number };
          const bW = b.measured?.width ?? bStyle.width ?? 320;
          const bH = b.measured?.height ?? bStyle.height ?? 200;

          return (aW * aH) - (bW * bH);
        });
        targetGroup = matchingGroups[0];
      }

      if (targetGroup) {
        // Dragged into a new group
        void reparentNode(node.id, targetGroup.id, absX, absY);
      } else {
        if (node.parentId) {
          // Dragged out of its parent group - check if center is completely outside
          const parent = nodes.find((n) => n.id === node.parentId);
          if (parent) {
            const parentStyle = (parent.style ?? {}) as { width?: number; height?: number };
            const pW = parent.measured?.width ?? parentStyle.width ?? 320;
            const pH = parent.measured?.height ?? parentStyle.height ?? 200;
            const pX = parent.position.x;
            const pY = parent.position.y;

            const isStillInside =
              nodeCenterX >= pX &&
              nodeCenterX <= pX + pW &&
              nodeCenterY >= pY &&
              nodeCenterY <= pY + pH;

            if (!isStillInside) {
              // Center is completely outside -> Auto-ungroup!
              void reparentNode(node.id, undefined, absX, absY);
            } else {
              // Center is still inside -> keep grouped and persist relative position
              void persistNodePosition(node.id, node.position);
            }
          } else {
            // Parent not found -> fallback to ungroup
            void reparentNode(node.id, undefined, absX, absY);
          }
        } else {
          // Regular absolute drag on root canvas
          void persistNodePosition(node.id, node.position);
        }
      }
    },
    [],
  );


  // Connection validation: only allow compatible handle types
  // Text nodes (type="text") can only connect to "target-text" handles
  // Image nodes (type="upload"/"reference"/etc) can only connect to "target-image" handles
  // If target has no specific handle id (legacy nodes), allow any connection
  const TEXT_SOURCE_TYPES = new Set(["text"]);
  const IMAGE_SOURCE_TYPES = new Set(["upload", "reference", "variant", "add_reference"]);

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

      // Extract client coordinates from either MouseEvent or TouchEvent
      const isTouch = "changedTouches" in event;
      const clientX = isTouch
        ? (event as TouchEvent).changedTouches[0]?.clientX
        : (event as MouseEvent).clientX;
      const clientY = isTouch
        ? (event as TouchEvent).changedTouches[0]?.clientY
        : (event as MouseEvent).clientY;

      let targetEl: Element | null = null;
      if (typeof clientX === "number" && typeof clientY === "number") {
        targetEl = document.elementFromPoint(clientX, clientY);
      }
      if (!targetEl) {
        targetEl = event.target as Element;
      }

      // Check if dropped on a node body
      const nodeEl = targetEl?.closest?.(".react-flow__node");
      const targetNodeId = nodeEl?.getAttribute("data-id");

      if (targetNodeId && targetNodeId !== sourceId) {
        // Drop on a node body! Add connection using smart edge routing.
        addEdgeFromConnection(sourceId, targetNodeId);
        return;
      }

      // Drop on empty canvas — pop up a quick-add menu at the release
      // point. Coords are in client (screen) space; the popover will
      // convert to flow space for the new node's position.
      const cx = typeof clientX === "number" ? clientX : 0;
      const cy = typeof clientY === "number" ? clientY : 0;
      setDropPopover({ clientX: cx, clientY: cy, sourceId });
    },
    [addEdgeFromConnection],
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

  // Close context menu on any pane click
  const onPaneClick = useCallback(() => {
    setContextMenu(null);
    setSelectionContextMenu(null);
  }, []);

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY });
    },
    [],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, _node: FlowNode) => {
      event.preventDefault();
      const selectedNodes = useBoardStore.getState().nodes.filter((n) => n.selected);
      if (selectedNodes.length >= 2) {
        setSelectionContextMenu({ x: event.clientX, y: event.clientY });
      }
    },
    [],
  );

  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setSelectionContextMenu({ x: event.clientX, y: event.clientY });
    },
    [],
  );

  const onNodesDelete = useCallback(
    (deletedNodes: FlowNode[]) => {
      deletedNodes.forEach((n) => {
        const dbId = parseInt(n.id, 10);
        if (!isNaN(dbId)) apiDeleteNode(dbId).catch(() => { });
      });
    },
    [],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: { id: string }[]) => {
      deletedEdges.forEach((e) => deleteEdgeByRfId(e.id));
    },
    [deleteEdgeByRfId],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: FlowNode) => {
      const isGenerable = node.data.type === "reference";
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

  // Keyboard shortcut: g key opens generation dialog for the selected image-generator node
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
            n.data.type === "reference",
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

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      if (toolMode !== "cut") return;
      void deleteEdgeByRfId(edge.id);
    },
    [toolMode, deleteEdgeByRfId],
  );

  // Keyboard shortcut: Ctrl+G (or Cmd+G) to group selected nodes
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      if (!isCtrlOrMeta || e.key.toLowerCase() !== "g" || e.altKey) return;

      // Skip if focus is in an editable element
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

      const { nodes, groupNodes } = useBoardStore.getState();
      const selectedIds = nodes
        .filter((n) => n.selected && n.data.type !== "group" && n.parentId === undefined)
        .map((n) => n.id);

      if (selectedIds.length >= 2) {
        e.preventDefault();
        e.stopPropagation();
        void groupNodes(selectedIds);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={toolMode === "cut" ? "board-shell board-shell--cut" : "board-shell"}
      style={{ flex: 1, minHeight: 0, width: "100%", height: "100%" }}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
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
        onEdgeClick={onEdgeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={defaultEdgeOptions}
        // Larger connection-drop radius so users don't have to land
        // pixel-perfect on the handle to complete an edge.
        connectionRadius={32}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        isValidConnection={isValidConnection}
        connectionLineComponent={DashedConnectionLine}
        nodesDraggable={toolMode !== "pan"}
        elementsSelectable={toolMode !== "pan"}
        selectionOnDrag={toolMode !== "pan"}
        panOnDrag={toolMode === "pan"}
        panOnScroll
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} color="rgba(255,255,255,0.15)" />
        {showMiniMap ? <MiniMap pannable zoomable /> : null}
        {showControls ? <Controls /> : null}
        {contextMenu && (
          <div style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 100 }}>
            <AddNodePanel onClose={() => setContextMenu(null)} position={contextMenu} />
          </div>
        )}
        <DropAddPopover
          popover={dropPopover}
          onPick={handlePickAdd}
          onClose={() => setDropPopover(null)}
        />
        {selectionContextMenu && (
          <SelectionContextMenu
            position={selectionContextMenu}
            onClose={() => setSelectionContextMenu(null)}
          />
        )}
      </ReactFlow>
    </div>
  );
}


