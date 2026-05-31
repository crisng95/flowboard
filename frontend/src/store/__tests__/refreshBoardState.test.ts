// Tests for refreshBoardState merge behaviour (Phase 1, item 1.5):
//   1. nodes with an active generation poll keep their in-memory (optimistic)
//      state instead of being clobbered by server truth;
//   2. the undo/redo history stack is preserved across a refresh (previously
//      wiped on every poll tick during a pipeline run).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, getBoard: vi.fn() };
});

import { getBoard, type BoardDetail, type NodeDTO } from "../../api/client";
import { useBoardStore } from "../board";
import { useGenerationStore } from "../generation";

const getBoardMock = vi.mocked(getBoard);

function makeNodeDto(
  partial: Partial<NodeDTO> & Pick<NodeDTO, "id" | "type" | "data">,
): NodeDTO {
  return {
    board_id: 7,
    short_id: `n${partial.id}`,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    status: "done",
    created_at: "2024-01-01T00:00:00Z",
    parent_id: null,
    ...partial,
  } as NodeDTO;
}

beforeEach(() => {
  useBoardStore.setState({
    boardId: 7,
    boardName: "",
    nodes: [],
    edges: [],
    historyPast: [],
    historyFuture: [],
    historyPresent: null,
  });
  useGenerationStore.setState({ active: {} });
  getBoardMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshBoardState — preserve in-flight optimistic node state", () => {
  it("keeps the in-memory version of a node that has an active poll", async () => {
    // In-memory: node 1 just optimistically went "done" with a fresh mediaId.
    useBoardStore.setState({
      nodes: [
        {
          id: "1",
          type: "reference",
          position: { x: 0, y: 0 },
          data: { type: "reference", status: "done", mediaId: "fresh-local" },
        } as never,
      ],
    });
    // Generation store says node 1 is still being polled.
    useGenerationStore.setState({ active: { "1": { requestId: 99, timerId: null } } });

    // Server is still behind: node 1 shows "running" with no media yet.
    getBoardMock.mockResolvedValue({
      board: { id: 7, name: "b", created_at: "2024-01-01T00:00:00Z" },
      nodes: [
        makeNodeDto({ id: 1, type: "reference", status: "running", data: { type: "reference", status: "running" } }),
      ],
      edges: [],
    } as BoardDetail);

    await useBoardStore.getState().refreshBoardState();

    const node = useBoardStore.getState().nodes.find((n) => n.id === "1");
    // The optimistic in-memory result is preserved, not clobbered by server.
    expect(node?.data.status).toBe("done");
    expect(node?.data.mediaId).toBe("fresh-local");
  });

  it("adopts server truth for nodes that are NOT actively polling", async () => {
    useBoardStore.setState({
      nodes: [
        {
          id: "2",
          type: "reference",
          position: { x: 0, y: 0 },
          data: { type: "reference", status: "idle" },
        } as never,
      ],
    });
    // No active polls.
    useGenerationStore.setState({ active: {} });

    getBoardMock.mockResolvedValue({
      board: { id: 7, name: "b", created_at: "2024-01-01T00:00:00Z" },
      nodes: [
        makeNodeDto({ id: 2, type: "reference", status: "done", data: { type: "reference", status: "done", mediaId: "server-mid" } }),
      ],
      edges: [],
    } as BoardDetail);

    await useBoardStore.getState().refreshBoardState();

    const node = useBoardStore.getState().nodes.find((n) => n.id === "2");
    expect(node?.data.status).toBe("done");
    expect(node?.data.mediaId).toBe("server-mid");
  });
});

describe("refreshBoardState — preserve undo history", () => {
  it("does not wipe historyPast / historyFuture", async () => {
    const fakePast = [{ nodes: [], edges: [] }] as never;
    const fakeFuture = [{ nodes: [], edges: [] }] as never;
    useBoardStore.setState({ historyPast: fakePast, historyFuture: fakeFuture });

    getBoardMock.mockResolvedValue({
      board: { id: 7, name: "b", created_at: "2024-01-01T00:00:00Z" },
      nodes: [],
      edges: [],
    } as BoardDetail);

    await useBoardStore.getState().refreshBoardState();

    const { historyPast, historyFuture } = useBoardStore.getState();
    expect(historyPast.length).toBe(1);
    expect(historyFuture.length).toBe(1);
  });
});
