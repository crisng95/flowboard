import type { Board, NodeDTO, EdgeDTO, NodeType, NodeStatus } from "./client";

const BOARDS_KEY = "flowboard.guest.boards.v2";
const NODES_PREFIX = "flowboard.guest.nodes.v2.";
const EDGES_PREFIX = "flowboard.guest.edges.v2.";

function getSafe<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function setSafe<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota errors silently
  }
}

export function getGuestBoards(): Board[] {
  return getSafe<Board[]>(BOARDS_KEY, []);
}

export function saveGuestBoards(boards: Board[]): void {
  setSafe(BOARDS_KEY, boards);
}

export function getGuestNodes(boardId: number): NodeDTO[] {
  return getSafe<NodeDTO[]>(`${NODES_PREFIX}${boardId}`, []);
}

export function saveGuestNodes(boardId: number, nodes: NodeDTO[]): void {
  setSafe(`${NODES_PREFIX}${boardId}`, nodes);
}

export function getGuestEdges(boardId: number): EdgeDTO[] {
  return getSafe<EdgeDTO[]>(`${EDGES_PREFIX}${boardId}`, []);
}

export function saveGuestEdges(boardId: number, edges: EdgeDTO[]): void {
  setSafe(`${EDGES_PREFIX}${boardId}`, edges);
}

function findBoardIdForNode(nodeId: number): number | null {
  const boards = getGuestBoards();
  for (const b of boards) {
    const nodes = getGuestNodes(b.id);
    if (nodes.some((n) => n.id === nodeId)) return b.id;
  }
  return null;
}

function findBoardIdForEdge(edgeId: number): number | null {
  const boards = getGuestBoards();
  for (const b of boards) {
    const edges = getGuestEdges(b.id);
    if (edges.some((e) => e.id === edgeId)) return b.id;
  }
  return null;
}

// --- Local CRUD implementations ---

export function mockListBoards(): Board[] {
  return getGuestBoards();
}

export function mockCreateBoard(name: string): Board {
  const boards = getGuestBoards();
  const id = Date.now() + Math.floor(Math.random() * 1000);
  const newBoard: Board = {
    id,
    name: name || "Untitled space",
    created_at: new Date().toISOString(),
  };
  saveGuestBoards([newBoard, ...boards]);
  saveGuestNodes(id, []);
  saveGuestEdges(id, []);
  return newBoard;
}

export function mockGetBoard(boardId: number): { board: Board; nodes: NodeDTO[]; edges: EdgeDTO[] } {
  const boards = getGuestBoards();
  let board = boards.find((b) => b.id === boardId);
  if (!board) {
    // If not found, dynamically create it to prevent blank page crash
    board = mockCreateBoard(`Untitled space #${boards.length + 1}`);
  }
  return {
    board,
    nodes: getGuestNodes(board.id),
    edges: getGuestEdges(board.id),
  };
}

export function mockPatchBoard(boardId: number, name: string): Board {
  const boards = getGuestBoards();
  const index = boards.findIndex((b) => b.id === boardId);
  if (index === -1) throw new Error("board not found");
  boards[index].name = name;
  saveGuestBoards(boards);
  return boards[index];
}

export function mockDeleteBoard(boardId: number): { deleted: number } {
  const boards = getGuestBoards();
  saveGuestBoards(boards.filter((b) => b.id !== boardId));
  try {
    localStorage.removeItem(`${NODES_PREFIX}${boardId}`);
    localStorage.removeItem(`${EDGES_PREFIX}${boardId}`);
  } catch {
    // ignore
  }
  return { deleted: boardId };
}

export function mockCreateNode(input: {
  board_id: number;
  type: NodeType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  data?: object;
  parent_id?: number | null;
}): NodeDTO {
  const nodes = getGuestNodes(input.board_id);
  const id = Date.now() + Math.floor(Math.random() * 1000);
  const newNode: NodeDTO = {
    id,
    board_id: input.board_id,
    short_id: "n" + Math.random().toString(36).substring(2, 6),
    type: input.type,
    x: input.x,
    y: input.y,
    w: input.w ?? 240,
    h: input.h ?? 160,
    data: (input.data as Record<string, unknown>) ?? {},
    status: "idle",
    created_at: new Date().toISOString(),
    parent_id: input.parent_id ?? null,
  };
  saveGuestNodes(input.board_id, [...nodes, newNode]);
  return newNode;
}

export function mockPatchNode(
  nodeId: number,
  patch: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    status?: NodeStatus;
    parent_id?: number | null;
    data?: Record<string, unknown>;
  },
): NodeDTO {
  const boardId = findBoardIdForNode(nodeId);
  if (boardId === null) throw new Error("node not found");

  const nodes = getGuestNodes(boardId);
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index === -1) throw new Error("node not found");

  const node = nodes[index];
  if (patch.x !== undefined) node.x = patch.x;
  if (patch.y !== undefined) node.y = patch.y;
  if (patch.w !== undefined) node.w = patch.w;
  if (patch.h !== undefined) node.h = patch.h;
  if (patch.status !== undefined) node.status = patch.status;
  if (patch.parent_id !== undefined) node.parent_id = patch.parent_id;
  if (patch.data !== undefined) {
    node.data = { ...node.data, ...patch.data };
  }

  saveGuestNodes(boardId, nodes);
  return node;
}

export function mockDeleteNode(nodeId: number): { ok: true; deleted_edges: number[]; deleted_child_ids?: number[] } {
  const boardId = findBoardIdForNode(nodeId);
  if (boardId === null) throw new Error("node not found");

  const nodes = getGuestNodes(boardId);
  const edges = getGuestEdges(boardId);

  // Group handling: cascade delete children or parent remapping
  const nodeToDelete = nodes.find((n) => n.id === nodeId);
  const deletedChildIds: number[] = [];

  if (nodeToDelete?.type === "group") {
    // Collect all children of this group to clear parent_id or delete them
    nodes.forEach((n) => {
      if (n.parent_id === nodeId) {
        n.parent_id = null; // Detach
      }
    });
  }

  const newNodes = nodes.filter((n) => n.id !== nodeId);
  saveGuestNodes(boardId, newNodes);

  // Filter out edges that touch this node
  const deletedEdges = edges.filter((e) => e.source_id === nodeId || e.target_id === nodeId).map((e) => e.id);
  const newEdges = edges.filter((e) => e.source_id !== nodeId && e.target_id !== nodeId);
  saveGuestEdges(boardId, newEdges);

  return { ok: true, deleted_edges: deletedEdges, deleted_child_ids: deletedChildIds };
}

export function mockCreateEdge(input: {
  board_id: number;
  source_id: number;
  target_id: number;
  kind?: string;
  source_handle?: string | null;
  target_handle?: string | null;
  source_variant_idx?: number | null;
}): EdgeDTO {
  const edges = getGuestEdges(input.board_id);
  const id = Date.now() + Math.floor(Math.random() * 1000);
  const newEdge: EdgeDTO = {
    id,
    board_id: input.board_id,
    source_id: input.source_id,
    target_id: input.target_id,
    kind: input.kind ?? "default",
    source_handle: input.source_handle ?? null,
    target_handle: input.target_handle ?? null,
    source_variant_idx: input.source_variant_idx ?? null,
  };
  saveGuestEdges(input.board_id, [...edges, newEdge]);
  return newEdge;
}

export function mockDeleteEdge(edgeId: number): { ok: true } {
  const boardId = findBoardIdForEdge(edgeId);
  if (boardId === null) throw new Error("edge not found");

  const edges = getGuestEdges(boardId);
  saveGuestEdges(boardId, edges.filter((e) => e.id !== edgeId));
  return { ok: true };
}

export function mockGroupNodes(input: {
  board_id: number;
  child_ids: number[];
  title?: string;
  color?: string;
  locked?: boolean;
  x: number;
  y: number;
  w?: number;
  h?: number;
}): { group: NodeDTO; children: NodeDTO[] } {
  const group = mockCreateNode({
    board_id: input.board_id,
    type: "group",
    x: input.x,
    y: input.y,
    w: input.w,
    h: input.h,
    data: {
      title: input.title ?? "Group",
      groupColor: input.color ?? "rgba(82,60,128,0.28)",
      locked: input.locked ?? false,
    },
  });

  const children: NodeDTO[] = [];
  for (const childId of input.child_ids) {
    const updated = mockPatchNode(childId, { parent_id: group.id });
    children.push(updated);
  }

  return { group, children };
}

export function mockUngroupNodes(groupId: number): { deleted_group_id: number; children: NodeDTO[] } {
  const boardId = findBoardIdForNode(groupId);
  if (boardId === null) throw new Error("group not found");

  const nodes = getGuestNodes(boardId);
  const children = nodes.filter((n) => n.parent_id === groupId);

  const updatedChildren: NodeDTO[] = [];
  for (const child of children) {
    const updated = mockPatchNode(child.id, { parent_id: null });
    updatedChildren.push(updated);
  }

  mockDeleteNode(groupId);
  return { deleted_group_id: groupId, children: updatedChildren };
}
