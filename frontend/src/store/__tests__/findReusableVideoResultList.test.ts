import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Edge } from "@xyflow/react";
import { findReusableVideoResultList } from "../generation";
import type { FlowNode } from "../board";

/**
 * Property-based test for `findReusableVideoResultList`, the pure reuse-detection
 * helper that decides whether a batch-video Generate should TÁI DÙNG an existing
 * Batch_Result_List (a `list` node wired from the Video_Node via the
 * `source-video` handle) or CREATE a new one.
 *
 * The helper matches edges where `source === videoRfId` AND
 * `sourceHandle === "source-video"` whose `target` resolves to a node whose
 * type (read via `node.data.type`, falling back to `node.type`) is `"list"`.
 * It returns that list node's rfId, or `null` when no qualifying edge exists.
 *
 * Generators below build random node sets (mix of `list` and non-`list` types,
 * exercising BOTH the `data.type` path and the `node.type` fallback) and random
 * edge sets (mix of sources, handles and targets) so that over many runs both
 * the "reuse" and "create-new" branches are exercised.
 */

const VIDEO_RF_ID = "video-node";

// How a node's type is surfaced: on `data.type` (primary) or only on
// `node.type` (fallback, with `data.type` left undefined).
type Placement = "data" | "nodeType";
type NodeSpec = { resolvedType: string; placement: Placement };

// Mirror of the helper's type resolution so the test stays independent of
// where the type is stored on the node.
function primaryType(node: FlowNode): string | undefined {
  return (node.data as { type?: string } | undefined)?.type ?? node.type;
}

function buildNode(id: string, spec: NodeSpec): FlowNode {
  if (spec.placement === "data") {
    // `data.type` wins over `node.type`; use a deliberately different
    // `node.type` to prove `data.type` takes precedence.
    return {
      id,
      type: "note",
      position: { x: 0, y: 0 },
      data: { type: spec.resolvedType, shortId: id, title: id },
    } as unknown as FlowNode;
  }
  // Fallback path: `data.type` absent, so the helper must read `node.type`.
  return {
    id,
    type: spec.resolvedType,
    position: { x: 0, y: 0 },
    data: { shortId: id, title: id },
  } as unknown as FlowNode;
}

type EdgeSpec = {
  sourceIsVideo: boolean;
  sourceIdx: number;
  handle: string | undefined;
  targetIdx: number;
};

function buildEdge(id: string, spec: EdgeSpec, nodeIds: string[]): Edge {
  const source = spec.sourceIsVideo
    ? VIDEO_RF_ID
    : nodeIds[spec.sourceIdx % nodeIds.length];
  const target = nodeIds[spec.targetIdx % nodeIds.length];
  return {
    id,
    source,
    target,
    sourceHandle: spec.handle,
    targetHandle: "target-video",
  } as Edge;
}

// Independent existence predicate (a simpler statement than the helper, which
// returns the FIRST match) used to verify the iff relationship.
function qualifyingEdgeExists(edges: Edge[], nodes: FlowNode[]): boolean {
  return edges.some(
    (e) =>
      e.source === VIDEO_RF_ID &&
      e.sourceHandle === "source-video" &&
      nodes.some((n) => n.id === e.target && primaryType(n) === "list"),
  );
}

// Type pool weighted toward "list" so positive cases occur frequently.
const typeArb = fc.constantFrom("list", "list", "video", "text", "reference", "variant");
const placementArb = fc.constantFrom<Placement>("data", "nodeType");
const nodeSpecArb: fc.Arbitrary<NodeSpec> = fc.record({
  resolvedType: typeArb,
  placement: placementArb,
});

// Handle pool weighted toward "source-video" so qualifying edges occur often.
const handleArb = fc.constantFrom<string | undefined>(
  "source-video",
  "source-video",
  "source",
  "source-image",
  "source-start-image",
  undefined,
);
const edgeSpecArb: fc.Arbitrary<EdgeSpec> = fc.record({
  sourceIsVideo: fc.boolean(),
  sourceIdx: fc.nat(),
  handle: handleArb,
  targetIdx: fc.nat(),
});

const boardArb = fc.record({
  nodeSpecs: fc.array(nodeSpecArb, { minLength: 1, maxLength: 6 }),
  edgeSpecs: fc.array(edgeSpecArb, { minLength: 0, maxLength: 8 }),
});

describe("findReusableVideoResultList", () => {
  // Feature: video-batch-result-list, Property 6: For all tập edge của board,
  // hàm dò reuse trả về đúng một list node hiện có khi (và chỉ khi) tồn tại edge
  // từ Video_Node qua handle `source-video` tới một node `list`; khi tồn tại,
  // logic chọn "tái dùng" (không tạo node mới), ngược lại chọn "tạo mới".
  // **Validates: Requirements 6.1, 6.3**
  it("P6: returns a list rfId iff a source-video edge from the Video_Node reaches a list node", () => {
    fc.assert(
      fc.property(boardArb, ({ nodeSpecs, edgeSpecs }) => {
        const nodeIds = nodeSpecs.map((_, i) => `node-${i}`);
        const nodes = nodeSpecs.map((spec, i) => buildNode(nodeIds[i], spec));
        const edges = edgeSpecs.map((spec, i) =>
          buildEdge(`edge-${i}`, spec, nodeIds),
        );

        const result = findReusableVideoResultList(edges, VIDEO_RF_ID, nodes);
        const exists = qualifyingEdgeExists(edges, nodes);

        // iff: a non-null result is returned exactly when a qualifying edge exists.
        expect(result !== null).toBe(exists);

        if (result !== null) {
          // The returned rfId must be a real `list` node...
          const target = nodes.find((n) => n.id === result);
          expect(target).toBeDefined();
          expect(primaryType(target as FlowNode)).toBe("list");
          // ...reachable from the Video_Node via a `source-video` edge.
          const reachable = edges.some(
            (e) =>
              e.source === VIDEO_RF_ID &&
              e.sourceHandle === "source-video" &&
              e.target === result,
          );
          expect(reachable).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
