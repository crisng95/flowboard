import { create } from "zustand";
import type { Edge, Node } from "@xyflow/react";
import {
  listBoards,
  createBoard,
  getBoard,
  patchBoard as apiPatchBoard,
  deleteBoard as apiDeleteBoard,
  createNode,
  patchNode,
  deleteNode,
  createEdge,
  deleteEdge,
  type Board,
  type NodeType,
} from "../api/client";

export type { NodeType };

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

export interface FlowboardNodeData extends Record<string, unknown> {
  type: NodeType;
  shortId: string;
  title: string;
  status?: NodeStatus;
  prompt?: string;
  thumbnailUrl?: string;
  mediaId?: string;
  // Per-variant media ids in dispatch order. `null` entries are
  // positional placeholders for variants that failed (e.g. Veo content
  // filter blocked one of the 4 i2v clips while the other 3 succeeded);
  // keeping the slot preserves alignment with the upstream image's
  // variants for poster/edge-pin lookups.
  mediaIds?: (string | null)[];
  // Per-slot error code, aligned to `mediaIds` indexing. `null` for
  // succeeded slots, an error string (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION")
  // for blocked ones. ResultViewer reads this to render the exact
  // filter reason on the blocked tile instead of falling through to
  // the previous variant.
  slotErrors?: (string | null)[];
  variantCount?: number;
  // The aspect-ratio enum the asset was generated / uploaded at — used to
  // default-match downstream gen dialogs (e.g. a 9:16 visual_asset feeds
  // into a downstream image / video that defaults to 9:16). Values are
  // Flow's IMAGE_ASPECT_RATIO_* enum strings since that's what the upload
  // route + gen worker produce. Video targets map them onto the matching
  // VIDEO_ASPECT_RATIO_* enum at dialog-open time.
  aspectRatio?: string;
  // AI-generated factual description of mediaId (set by /api/vision/describe).
  // Spliced into auto-prompts on downstream nodes for richer context.
  aiBrief?: string;
  aiBriefStatus?: "pending" | "done" | "failed";
  // Transient status while the GenerationDialog runs `autoPrompt` /
  // `autoPromptBatch` against this node — set to "pending" while the
  // backend is composing the prompt, cleared on success/failure. Not
  // persisted to the DB; it's a few-second UX flag so the node can
  // render a visible "busy" treatment that blocks duplicate dispatches.
  autoPromptStatus?: "pending" | "done" | "failed";
  // ISO timestamp persisted when a generation completes successfully.
  // Powers the "5 phút trước" relative-time display in ResultViewer.
  // Uploads also stamp this so the timestamp reflects "when the asset
  // landed on the node" regardless of source.
  renderedAt?: string;
  // Model used to produce the rendered media. Populated on completion
  // of gen_image / edit_image (`imageModel`, e.g. "NANO_BANANA_PRO") or
  // gen_video (`videoQuality`, e.g. "fast" / "lite" / "quality"). Absent
  // on uploads (no model involved) and on nodes generated before this
  // feature shipped — ResultViewer falls back to current settings as
  // plain text in that case so the user knows it's an estimate.
  imageModel?: string;
  videoQuality?: string;
  // Character-builder selections — persisted on dispatch so the detail
  // panel can show "Country / Vibe / Gender" pills under METADATA. Keys
  // (`vn`, `clean`, `female`) match the constants in
  // `src/constants/character.ts`; viewer maps key → display label.
  charCountry?: string;
  charVibe?: string;
  charGender?: string;
  error?: string;
}

export type FlowNode = Node<FlowboardNodeData>;

// Per-edge data we attach to ReactFlow's `Edge.data` so dispatch and
// edge-rendering paths can read it without a round-trip through the
// backend. `sourceVariantIdx` mirrors `EdgeDTO.source_variant_idx`.
export interface FlowboardEdgeData extends Record<string, unknown> {
  sourceVariantIdx?: number | null;
}

/** Map an EdgeDTO from the backend into ReactFlow's Edge shape, carrying
 * the variant pin through `data` so dispatch + edge UI can read it. */
function edgeFromDto(dto: {
  id: number;
  source_id: number;
  target_id: number;
  source_variant_idx?: number | null;
}): Edge<FlowboardEdgeData> {
  return {
    id: String(dto.id),
    source: String(dto.source_id),
    target: String(dto.target_id),
    data: { sourceVariantIdx: dto.source_variant_idx ?? null },
  };
}

// ── Tiny per-node debounce (no external deps) ─────────────────────────────
const positionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncePosition(rfId: string, fn: () => void, delay = 150) {
  const existing = positionTimers.get(rfId);
  if (existing !== undefined) clearTimeout(existing);
  positionTimers.set(rfId, setTimeout(() => {
    positionTimers.delete(rfId);
    fn();
  }, delay));
}

// ── Type-to-title lookup ───────────────────────────────────────────────────
const TYPE_TITLE: Record<NodeType, string> = {
  character: "Character",
  image: "Image",
  video: "Video",
  prompt: "Prompt",
  note: "Note",
  visual_asset: "Visual asset",
};

// ── Persisted active-board id ─────────────────────────────────────────────
// Survives page reloads so refreshing on project #4 doesn't kick the user
// back to project #1. localStorage is fine here — single-user, single-host.
const ACTIVE_BOARD_KEY = "flowboard.activeBoardId";

function loadPersistedBoardId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_BOARD_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistBoardId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_BOARD_KEY);
    else localStorage.setItem(ACTIVE_BOARD_KEY, String(id));
  } catch {
    // Storage disabled / quota exceeded — non-fatal, just lose persistence.
  }
}

// ── Store ──────────────────────────────────────────────────────────────────
interface BoardState {
  boardId: number | null;
  boardName: string;
  // Lightweight summary list rendered by the ProjectSidebar — full node /
  // edge content lives only on the active board to keep memory bounded.
  boards: Board[];
  nodes: FlowNode[];
  edges: Edge[];
  loading: boolean;
  error: string | null;

  loadInitialBoard(): Promise<void>;
  refreshBoardState(): Promise<void>;
  refreshBoardList(): Promise<void>;
  renameBoard(name: string): Promise<void>;
  // Switch the active board: load detail, replace nodes/edges, reset
  // poll-state on the generation store.
  switchBoard(id: number): Promise<void>;
  // Create a new board, switch to it, return id.
  createNewBoard(name: string): Promise<number | null>;
  // Delete a board. If it's the active one, switch to first remaining
  // board (or create a fresh "Untitled" if list ends up empty).
  deleteBoardById(id: number): Promise<void>;

  // Returns the new node's rfId on success, or null if creation failed.
  // Callers that need to wire up an edge immediately (e.g. drop-popover
  // shortcut) need the id back synchronously.
  addNodeOfType(type: NodeType, position: { x: number; y: number }): Promise<string | null>;
  persistNodePosition(rfId: string, position: { x: number; y: number }): Promise<void>;
  deleteNodeByRfId(rfId: string): Promise<void>;
  addEdgeFromConnection(source: string, target: string): Promise<void>;
  deleteEdgeByRfId(rfId: string): Promise<void>;
  // Spawn an empty sibling node next to `rfId` with the same type and the
  // same upstream edges. Returns the new node's rfId so callers can focus
  // / open the generation dialog on it. Used by ResultViewer's
  // "New variant +" — gives the user a fresh canvas to gen another shot
  // sharing the original's source refs.
  cloneNodeWithUpstream(rfId: string): Promise<string | null>;

  updateNodeData(rfId: string, partial: Partial<FlowboardNodeData>): void;
  /** Merge `partial` into edge.data — used to refresh the local cache
   * after a PATCH /api/edges/{id} so the badge updates without waiting
   * for a full board refresh. */
  updateEdgeData(edgeId: string, partial: Partial<FlowboardEdgeData>): void;
  setNodes(nodes: FlowNode[]): void;
  setEdges(edges: Edge[]): void;
  clearError(): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  boardId: null,
  boardName: "",
  boards: [],
  nodes: [],
  edges: [],
  loading: false,
  error: null,

  async loadInitialBoard() {
    set({ loading: true, error: null });
    try {
      let boards = await listBoards();
      // Prefer the user's last-active board if it still exists; fall back
      // to the first board in the list. Without this, refresh always
      // snapped back to boards[0] regardless of what was selected before.
      const persistedId = loadPersistedBoardId();
      let board =
        (persistedId !== null && boards.find((b) => b.id === persistedId)) ||
        boards[0];
      if (!board) {
        board = await createBoard("Untitled");
        boards = [board];
      }
      const detail = await getBoard(board.id);

      const nodes: FlowNode[] = detail.nodes.map((n) => ({
        id: String(n.id),
        type: n.type,
        position: { x: n.x, y: n.y },
        data: {
          type: n.type,
          shortId: n.short_id,
          title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
          status: n.status,
          prompt: n.data["prompt"] as string | undefined,
          thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
          mediaId: n.data["mediaId"] as string | undefined,
          mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
          slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
          variantCount: n.data["variantCount"] as number | undefined,
          aspectRatio: n.data["aspectRatio"] as string | undefined,
          aiBrief: n.data["aiBrief"] as string | undefined,
          imageModel: n.data["imageModel"] as string | undefined,
          videoQuality: n.data["videoQuality"] as string | undefined,
          charCountry: n.data["charCountry"] as string | undefined,
          charVibe: n.data["charVibe"] as string | undefined,
          charGender: n.data["charGender"] as string | undefined,
        },
      }));

      const edges: Edge[] = detail.edges.map(edgeFromDto);

      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        boards,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshBoardList() {
    try {
      const boards = await listBoards();
      set({ boards });
    } catch {
      // non-fatal
    }
  },

  async switchBoard(id) {
    if (id === get().boardId) return;
    set({ loading: true, error: null });
    try {
      const detail = await getBoard(id);
      const nodes: FlowNode[] = detail.nodes.map((n) => ({
        id: String(n.id),
        type: n.type,
        position: { x: n.x, y: n.y },
        data: {
          type: n.type,
          shortId: n.short_id,
          title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
          status: n.status,
          prompt: n.data["prompt"] as string | undefined,
          thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
          mediaId: n.data["mediaId"] as string | undefined,
          mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
          slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
          variantCount: n.data["variantCount"] as number | undefined,
          aspectRatio: n.data["aspectRatio"] as string | undefined,
          aiBrief: n.data["aiBrief"] as string | undefined,
          imageModel: n.data["imageModel"] as string | undefined,
          videoQuality: n.data["videoQuality"] as string | undefined,
          charCountry: n.data["charCountry"] as string | undefined,
          charVibe: n.data["charVibe"] as string | undefined,
          charGender: n.data["charGender"] as string | undefined,
        },
      }));
      const edges: Edge[] = detail.edges.map(edgeFromDto);
      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createNewBoard(name) {
    try {
      const board = await createBoard(name || "Untitled");
      // Add to list (front of list so the newly-created project shows up
      // at the top of the sidebar) and switch to it.
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async deleteBoardById(id) {
    try {
      await apiDeleteBoard(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const remaining = get().boards.filter((b) => b.id !== id);
    set({ boards: remaining });
    // If we just deleted the active board, switch to the first remaining
    // board — or create a fresh "Untitled" if none left.
    if (get().boardId === id) {
      if (remaining.length > 0) {
        await get().switchBoard(remaining[0].id);
      } else {
        try {
          const board = await createBoard("Untitled");
          set({ boards: [board] });
          await get().switchBoard(board.id);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  },

  async refreshBoardState() {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      const nodes: FlowNode[] = detail.nodes.map((n) => ({
        id: String(n.id),
        type: n.type,
        position: { x: n.x, y: n.y },
        data: {
          type: n.type,
          shortId: n.short_id,
          title: (n.data["title"] as string | undefined) ?? TYPE_TITLE[n.type],
          status: n.status,
          prompt: n.data["prompt"] as string | undefined,
          thumbnailUrl: n.data["thumbnailUrl"] as string | undefined,
          mediaId: n.data["mediaId"] as string | undefined,
          mediaIds: n.data["mediaIds"] as (string | null)[] | undefined,
          slotErrors: n.data["slotErrors"] as (string | null)[] | undefined,
          variantCount: n.data["variantCount"] as number | undefined,
          aiBrief: n.data["aiBrief"] as string | undefined,
          imageModel: n.data["imageModel"] as string | undefined,
          videoQuality: n.data["videoQuality"] as string | undefined,
          charCountry: n.data["charCountry"] as string | undefined,
          charVibe: n.data["charVibe"] as string | undefined,
          charGender: n.data["charGender"] as string | undefined,
          error: n.data["error"] as string | undefined,
        },
      }));
      const edges: Edge[] = detail.edges.map(edgeFromDto);
      set({ nodes, edges });
    } catch {
      // ignore — leave state alone, next poll will retry
    }
  },

  async renameBoard(name: string) {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const updated = await apiPatchBoard(boardId, name);
      set((s) => ({
        boardName: updated.name,
        boards: s.boards.map((b) =>
          b.id === boardId ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch {
      // non-fatal; keep local name
    }
  },

  async addNodeOfType(type, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = TYPE_TITLE[type];
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: { title },
      });
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: dto.status,
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return node.id;
    } catch {
      // surface silently for now
    }
    return null;
  },

  async persistNodePosition(rfId, position) {
    debouncePosition(rfId, async () => {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) return;
      try {
        await patchNode(dbId, { x: Math.round(position.x), y: Math.round(position.y) });
      } catch {
        // ignore persist failures
      }
    });
  },

  async deleteNodeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    // Cancel any pending debounced patch for this node (it would 404 after delete).
    const pending = positionTimers.get(rfId);
    if (pending !== undefined) {
      clearTimeout(pending);
      positionTimers.delete(rfId);
    }
    // Also cancel any in-flight generation poll — otherwise the poll loop
    // keeps pinging the server about a node that no longer exists.
    // Dynamic import to avoid a circular store dependency at module init.
    try {
      const { useGenerationStore } = await import("./generation");
      useGenerationStore.getState().cancelGeneration(rfId);
    } catch {
      // If the module isn't loaded yet (tree-shaken test path), ignore.
    }
    try {
      await deleteNode(dbId);
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== rfId),
        edges: s.edges.filter((e) => e.source !== rfId && e.target !== rfId),
      }));
    } catch {
      // ignore
    }
  },

  async addEdgeFromConnection(source, target) {
    const { boardId } = get();
    if (boardId === null) return;
    const sourceId = parseInt(source, 10);
    const targetId = parseInt(target, 10);
    if (isNaN(sourceId) || isNaN(targetId)) return;
    try {
      const dto = await createEdge({ board_id: boardId, source_id: sourceId, target_id: targetId });
      set((s) => ({ edges: [...s.edges, edgeFromDto(dto)] }));
    } catch {
      // ignore
    }
  },

  async cloneNodeWithUpstream(rfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const src = nodes.find((n) => n.id === rfId);
    if (!src) return null;

    // Position the clone to the lower-right of the source so it doesn't
    // overlap. Title gets a " (variant)" suffix if not already present so
    // it's easy to tell apart at a glance.
    const offset = { x: 60, y: 60 };
    const newPos = {
      x: Math.round(src.position.x + offset.x),
      y: Math.round(src.position.y + offset.y),
    };
    const baseTitle = src.data.title ?? TYPE_TITLE[src.data.type];
    const newTitle = baseTitle.endsWith("(variant)")
      ? baseTitle
      : `${baseTitle} (variant)`;

    let nodeDto;
    try {
      nodeDto = await createNode({
        board_id: boardId,
        type: src.data.type,
        x: newPos.x,
        y: newPos.y,
        data: { title: newTitle },
      });
    } catch {
      return null;
    }

    const newNode: FlowNode = {
      id: String(nodeDto.id),
      type: nodeDto.type,
      position: { x: nodeDto.x, y: nodeDto.y },
      data: {
        type: nodeDto.type,
        shortId: nodeDto.short_id,
        title: (nodeDto.data["title"] as string | undefined) ?? newTitle,
        status: nodeDto.status,
      },
    };
    set((s) => ({ nodes: [...s.nodes, newNode] }));

    // Replicate upstream edges: every (upstream → src) becomes (upstream → clone).
    const upstreamSourceRfIds = edges
      .filter((e) => e.target === rfId)
      .map((e) => e.source);
    for (const usrc of upstreamSourceRfIds) {
      const sourceId = parseInt(usrc, 10);
      if (isNaN(sourceId)) continue;
      try {
        const eDto = await createEdge({
          board_id: boardId,
          source_id: sourceId,
          target_id: nodeDto.id,
        });
        const newEdge: Edge = {
          id: String(eDto.id),
          source: String(eDto.source_id),
          target: String(eDto.target_id),
        };
        set((s) => ({ edges: [...s.edges, newEdge] }));
      } catch {
        // best-effort — partial edge replication still useful
      }
    }
    return newNode.id;
  },

  async deleteEdgeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    try {
      await deleteEdge(dbId);
      set((s) => ({ edges: s.edges.filter((e) => e.id !== rfId) }));
    } catch {
      // ignore
    }
  },

  updateNodeData: (rfId, partial) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === rfId ? { ...n, data: { ...n.data, ...partial } } : n,
      ),
    })),
  updateEdgeData: (edgeId, partial) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...(e.data ?? {}), ...partial } }
          : e,
      ),
    })),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearError: () => set({ error: null }),
}));
