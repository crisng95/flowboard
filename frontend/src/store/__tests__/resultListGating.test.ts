import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { shouldSpawnVideoResultList } from "../generation";

/**
 * Property-based test for `shouldSpawnVideoResultList`, the pure gating
 * predicate that mirrors EXACTLY the `hasBatchInputs` condition used in the
 * video branch of `runNodeDirect`:
 *
 *     upstreamPrompts.length > 1 && startMediaIds.length > 1
 *
 * It is the single source of truth for deciding whether a Generate_Action
 * spawns a Batch_Result_List. A batch run (N > 1) requires BOTH more than one
 * upstream prompt AND more than one start media id; any single-input
 * configuration yields N = 1 and the predicate must return `false`, so no
 * node/edge is created and `batchResultListId` stays unset.
 *
 * The generators below intentionally cover the N = 1 (non-batch) input space:
 * either side having length ≤ 1 must produce "do not create". A separate
 * complement generator proves the predicate flips to `true` only when BOTH
 * sides exceed 1, so the test reflects real `runNodeDirect` behaviour rather
 * than an invented condition.
 */

// Models the I/O the caller would perform based on the gating decision. When
// the predicate says "do not create", the caller must make NO createNode/
// createEdge call and must leave `batchResultListId` unset (Req 4.2, 4.3).
function decide(upstreamPromptsLength: number, startMediaIdsLength: number) {
  const spawn = shouldSpawnVideoResultList(upstreamPromptsLength, startMediaIdsLength);
  return {
    spawn,
    createNodeCalls: spawn ? 1 : 0,
    createEdgeCalls: spawn ? 1 : 0,
    batchResultListId: spawn ? "list-1" : undefined,
  };
}

// A length that, on at least one side, fails the `> 1` check → N = 1 (or 0),
// i.e. NOT a batch. We pick the small side from {0, 1} and the other side from
// the full realistic range so every "single-input" shape is exercised.
const smallSide = fc.integer({ min: 0, max: 1 });
const anySide = fc.integer({ min: 0, max: 50 });

// Both sides strictly greater than 1 → genuine batch (N > 1).
const batchSide = fc.integer({ min: 2, max: 50 });

describe("shouldSpawnVideoResultList — batch gating", () => {
  // Feature: video-batch-result-list, Property 5: N = 1 không sinh ra Batch_Result_List
  // **Validates: Requirements 4.2, 4.3**
  it("P5: non-batch inputs (N=1) make no node/edge call and leave batchResultListId unset", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // upstreamPrompts ≤ 1, startMediaIds anything
          fc.record({ prompts: smallSide, media: anySide }),
          // startMediaIds ≤ 1, upstreamPrompts anything
          fc.record({ prompts: anySide, media: smallSide }),
        ),
        ({ prompts, media }) => {
          // Precondition: this configuration is genuinely non-batch.
          expect(prompts > 1 && media > 1).toBe(false);

          const decision = decide(prompts, media);
          expect(decision.spawn).toBe(false);
          expect(decision.createNodeCalls).toBe(0);
          expect(decision.createEdgeCalls).toBe(0);
          expect(decision.batchResultListId).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Complement: prove the predicate is EXACTLY the real `hasBatchInputs`
  // condition by checking it flips to "create" only when both sides exceed 1.
  it("P5 (complement): both sides > 1 (N>1) spawns exactly one list + edge", () => {
    fc.assert(
      fc.property(batchSide, batchSide, (prompts, media) => {
        const decision = decide(prompts, media);
        expect(decision.spawn).toBe(true);
        expect(decision.createNodeCalls).toBe(1);
        expect(decision.createEdgeCalls).toBe(1);
        expect(decision.batchResultListId).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  // Cross-check against the documented predicate over the full input space:
  // the helper must equal `prompts > 1 && media > 1` for ALL inputs.
  it("P5: predicate matches the runNodeDirect hasBatchInputs expression exactly", () => {
    fc.assert(
      fc.property(anySide, anySide, (prompts, media) => {
        expect(shouldSpawnVideoResultList(prompts, media)).toBe(prompts > 1 && media > 1);
      }),
      { numRuns: 100 },
    );
  });
});
