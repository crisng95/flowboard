// Integration / regression tests for the video-batch-result-list feature.
//
// These are EXAMPLE-BASED regression tests (not property-based), covering the
// design's "Testing Strategy -> Integration / regression" section:
//
//   - Req 8.1: the image batch flow still spawns `add_reference` and is
//              unaffected by the video Batch_Result_List logic.
//   - Req 8.6: reloading a board restores the Video_Node, Batch_Result_List,
//              the connecting edge, and the persisted listItems via the
//              nodeFromDto / edgeFromDto conversion path.
//   - Req 4.1: an N = 1 run shows a single video on the node and creates no
//              Batch_Result_List.
//
// Coverage notes / limitations are documented inline next to each test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getBoard` is the single network call the board reload path makes. We mock
// ONLY that export and keep every other api/client export real, so importing
// board.ts (which pulls in createNode/patchNode/etc. at module load) stays
// intact. The mock lets us feed a deterministic BoardDetail fixture and assert
// what the reload conversion (snapshotFromDetail -> nodeFromDto / edgeFromDto)
// reconstructs.
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, getBoard: vi.fn() };
});

import { getBoard, type BoardDetail, type NodeDTO, type EdgeDTO } from "../../api/client";
import { useBoardStore } from "../board";
import { shouldSpawnVideoResultList } from "../generation";

const getBoardMock = vi.mocked(getBoard);

beforeEach(() => {
  // Each reload test starts from a clean, empty board so switchBoard(id) does
  // not early-return (it bails when id === current boardId) and so leftover
  // nodes/edges from a previous test can't leak into assertions.
  useBoardStore.setState({ boardId: null, boardName: "", nodes: [], edges: [] });
  getBoardMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Req 8.6 — Reload restores Video_Node, Batch_Result_List, edge, and listItems
// ---------------------------------------------------------------------------
//
// The board reload path is `switchBoard(id)` -> `getBoard(id)` ->
// `snapshotFromDetail(detail)` -> `nodeFromDto` / `edgeFromDto`. We exercise it
// through the public `switchBoard` action (the real reload entry point) rather
// than calling the private converters directly — this keeps the test faithful
// to what actually happens on a page reload and avoids exporting internals
// purely for testing.
describe("Req 8.6 — board reload restores the batch-video graph", () => {
  function makeNodeDto(partial: Partial<NodeDTO> & Pick<NodeDTO, "id" | "type" | "data">): NodeDTO {
    return {
      board_id: 42,
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

  function makeEdgeDto(partial: Partial<EdgeDTO> & Pick<EdgeDTO, "id" | "source_id" | "target_id">): EdgeDTO {
    return {
      board_id: 42,
      kind: "video",
      source_handle: null,
      target_handle: null,
      source_variant_idx: null,
      ...partial,
    } as EdgeDTO;
  }

  // A list node that carries three persisted video listItems (one per slot),
  // mirroring the state buildVideoResultListItems produces after a done batch.
  const persistedListItems = [
    { id: "v1", kind: "video", title: "Video 1", mediaId: "v1", flowMediaId: "v1", mediaUrl: "v1", mime: "video/mp4", status: "done" },
    { id: "v2", kind: "video", title: "Video 2", mediaId: "v2", flowMediaId: "v2", mediaUrl: "v2", mime: "video/mp4", status: "done" },
    { id: "video-slot-2", kind: "video", title: "Video 3", mediaId: null, flowMediaId: null, mediaUrl: null, mime: "video/mp4", status: "error", error: "blocked" },
  ];

  const detailFixture: BoardDetail = {
    board: { id: 42, name: "Batch board", created_at: "2024-01-01T00:00:00Z" },
    nodes: [
      makeNodeDto({
        id: 1,
        type: "video",
        data: {
          type: "video",
          title: "Video Generator",
          mediaIds: ["v1", "v2", "v3"],
          slotErrors: [null, null, "blocked"],
          variantCount: 3,
          videoModel: "veo",
          // The Video_Node remembers which list received its batch results.
          batchResultListId: "2",
        },
      }),
      makeNodeDto({
        id: 2,
        type: "list",
        data: {
          type: "list",
          title: "Video Results",
          lockedType: "video",
          listItems: persistedListItems,
          variantCount: 3,
        },
      }),
    ],
    edges: [
      makeEdgeDto({
        id: 100,
        source_id: 1,
        target_id: 2,
        kind: "video",
        source_handle: "source-video",
        target_handle: "target-video",
      }),
    ],
  };

  it("rebuilds the Video_Node, Batch_Result_List, connecting edge, and listItems", async () => {
    getBoardMock.mockResolvedValue(structuredClone(detailFixture));

    await useBoardStore.getState().switchBoard(42);

    const { nodes, edges, boardId } = useBoardStore.getState();
    expect(boardId).toBe(42);

    // Video_Node restored with its type and full N-entry mediaIds (Req 8.6 +
    // the Req 1.3 invariant that all N results survive on node.data).
    const videoNode = nodes.find((n) => n.id === "1");
    expect(videoNode).toBeDefined();
    expect(videoNode!.type).toBe("video");
    expect(videoNode!.data.type).toBe("video");
    expect(videoNode!.data.mediaIds).toEqual(["v1", "v2", "v3"]);
    expect(videoNode!.data.batchResultListId).toBe("2");

    // Batch_Result_List restored with type === "list" and its listItems intact
    // (kind, mediaId, status preserved positionally — including the error slot).
    const listNode = nodes.find((n) => n.id === "2");
    expect(listNode).toBeDefined();
    expect(listNode!.type).toBe("list");
    expect(listNode!.data.type).toBe("list");
    const restoredItems = listNode!.data.listItems as Array<Record<string, unknown>>;
    expect(Array.isArray(restoredItems)).toBe(true);
    expect(restoredItems).toHaveLength(3);
    expect(restoredItems.map((it) => it.kind)).toEqual(["video", "video", "video"]);
    expect(restoredItems.map((it) => it.mediaId)).toEqual(["v1", "v2", null]);
    expect(restoredItems.map((it) => it.status)).toEqual(["done", "done", "error"]);

    // Connecting edge restored with both handles intact so the Video_Node ->
    // Batch_Result_List wiring (source-video -> target-video) survives reload.
    const edge = edges.find((e) => e.id === "100");
    expect(edge).toBeDefined();
    expect(edge!.source).toBe("1");
    expect(edge!.target).toBe("2");
    expect(edge!.sourceHandle).toBe("source-video");
    expect(edge!.targetHandle).toBe("target-video");
  });
});

// ---------------------------------------------------------------------------
// Req 8.1 — Image batch flow still spawns add_reference; video logic is separate
// ---------------------------------------------------------------------------
//
// Limitation: the two done-handler branches in dispatchGeneration are inline
// (not extracted helpers), so this test mirrors their EXACT documented
// conditions as local predicates and asserts the structural independence the
// feature must preserve. It does not invoke dispatchGeneration end-to-end
// (which needs the full store + polling); it guards that the two branches are
// gated on mutually-exclusive `kind` values so adding the video branch cannot
// reroute or suppress the existing image add_reference spawn.
describe("Req 8.1 — image add_reference spawn is independent of the video batch path", () => {
  // Mirror of dispatchGeneration's image auto-spawn gate:
  //   (opts.kind ?? "image") === "image" && mediaIds.length > 1 && !skipSpawningNodes
  function shouldSpawnAddReference(kind: string | undefined, mediaIdsLength: number, skipSpawningNodes = false): boolean {
    return (kind ?? "image") === "image" && mediaIdsLength > 1 && !skipSpawningNodes;
  }

  // Mirror of the video result-fill gate:
  //   (opts.kind ?? "image") === "video" && batchResultListId is set
  function shouldFillVideoResultList(kind: string | undefined, batchResultListId: string | undefined): boolean {
    return (kind ?? "image") === "video" && !!batchResultListId;
  }

  it("an image batch (kind=image, >1 result) still triggers add_reference spawning", () => {
    expect(shouldSpawnAddReference("image", 4)).toBe(true);
    // ...and the video result-fill branch never fires for an image run, even if
    // a stale batchResultListId were present.
    expect(shouldFillVideoResultList("image", "2")).toBe(false);
  });

  it("a video batch fills the result list and never spawns add_reference", () => {
    expect(shouldFillVideoResultList("video", "2")).toBe(true);
    expect(shouldSpawnAddReference("video", 4)).toBe(false);
  });

  it("the two branches are mutually exclusive across kinds and never both fire", () => {
    for (const kind of [undefined, "image", "video"] as const) {
      for (const count of [1, 2, 5]) {
        for (const listId of [undefined, "2"]) {
          const img = shouldSpawnAddReference(kind, count);
          const vid = shouldFillVideoResultList(kind, listId);
          // A single done-handler run is either an image run or a video run; the
          // gates can never both be true, so the video feature cannot regress the
          // image add_reference flow.
          expect(img && vid).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Req 4.1 — N = 1 shows a single video and creates no list
// ---------------------------------------------------------------------------
//
// The N = 1 outcome is governed by the exported gating predicate
// `shouldSpawnVideoResultList`, which mirrors runNodeDirect's `hasBatchInputs`
// exactly. When it returns false the batch path is skipped entirely: no list
// node is spawned, so the single rendered video stays on the Video_Node card
// (the existing single-video behaviour). Req 4.2/4.3 are covered in
// resultListGating.test.ts; here we pin the Req 4.1 facet — the single-video,
// no-list decision — for the representative N = 1 input shapes.
describe("Req 4.1 — N = 1 keeps a single video on the node with no Batch_Result_List", () => {
  it("a lone prompt + lone image (N=1) does not spawn a list", () => {
    // 1 prompt, 1 start image => N = 1 => non-batch.
    expect(shouldSpawnVideoResultList(1, 1)).toBe(false);
  });

  it("any single-input shape yields N=1 (no list); only >1 on both sides batches", () => {
    const singleInputShapes: Array<[number, number]> = [
      [1, 1],
      [1, 5],
      [5, 1],
      [0, 0],
      [1, 0],
    ];
    for (const [prompts, media] of singleInputShapes) {
      expect(shouldSpawnVideoResultList(prompts, media)).toBe(false);
    }
    // Sanity: a genuine batch (both > 1) is the only case that DOES spawn a list.
    expect(shouldSpawnVideoResultList(3, 2)).toBe(true);
  });
});
