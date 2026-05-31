import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildVideoBatchPairs } from "../generation";

/**
 * Property-based tests for the Video-node batch fan-out pairing logic
 * (`buildVideoBatchPairs`). This is the pure logic that `runNodeDirect`
 * uses to turn an upstream list of prompts (P) and a list of source images
 * (M) into per-variant (prompt, ref) pairs according to `batchMode`.
 *
 * Generators constrain to the realistic input space: P, M ∈ [1..6] and
 * mode ∈ {zip, cross}, matching the design's PBT input spec.
 */

// Distinct, position-encoded values so we can assert exact pairing.
function promptsOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `prompt-${i}`);
}
function refsOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `ref-${i}`);
}

const sizeArb = fc.integer({ min: 1, max: 6 });
const modeArb = fc.constantFrom<"zip" | "cross">("zip", "cross");

describe("buildVideoBatchPairs", () => {
  // Property 1: fan-out count is correct.
  // len = min(P, M) for zip, P * M for cross.
  // **Validates: Requirements 1.1, 1.4**
  it("P1: produces the correct number of pairs", () => {
    fc.assert(
      fc.property(sizeArb, sizeArb, modeArb, (p, m, mode) => {
        const { prompts, refs } = buildVideoBatchPairs(promptsOf(p), refsOf(m), mode);
        const expected = mode === "zip" ? Math.min(p, m) : p * m;
        expect(prompts.length).toBe(expected);
        expect(refs.length).toBe(expected);
      }),
    );
  });

  // Property 2: prompt↔ref pairing follows the mode rule exactly.
  //   - cross: pair at index i*M + j == (prompts[i], refs[j])
  //   - zip:   pair at index k     == (prompts[k], refs[k])
  // **Validates: Requirements 1.2, 1.4**
  it("P2: pairs prompts and refs at the correct positions", () => {
    fc.assert(
      fc.property(sizeArb, sizeArb, modeArb, (p, m, mode) => {
        const inPrompts = promptsOf(p);
        const inRefs = refsOf(m);
        const { prompts, refs } = buildVideoBatchPairs(inPrompts, inRefs, mode);

        if (mode === "zip") {
          const minLength = Math.min(p, m);
          for (let k = 0; k < minLength; k++) {
            expect(prompts[k]).toBe(inPrompts[k]);
            expect(refs[k]).toBe(inRefs[k]);
          }
        } else {
          for (let i = 0; i < p; i++) {
            for (let j = 0; j < m; j++) {
              const idx = i * m + j;
              expect(prompts[idx]).toBe(inPrompts[i]);
              expect(refs[idx]).toBe(inRefs[j]);
            }
          }
        }
      }),
    );
  });

  // The two output arrays must always be aligned (equal length) so
  // downstream dispatch can zip prompts[i] ↔ sourceMediaIds[i].
  it("P1/P2: prompts and refs arrays stay length-aligned", () => {
    fc.assert(
      fc.property(sizeArb, sizeArb, modeArb, (p, m, mode) => {
        const { prompts, refs } = buildVideoBatchPairs(promptsOf(p), refsOf(m), mode);
        expect(prompts.length).toBe(refs.length);
      }),
    );
  });

  // Concrete examples that pin the documented behaviour.
  it("zip example: 3 prompts × 3 refs → 3 positional pairs", () => {
    const { prompts, refs } = buildVideoBatchPairs(
      ["p0", "p1", "p2"],
      ["r0", "r1", "r2"],
      "zip",
    );
    expect(prompts).toEqual(["p0", "p1", "p2"]);
    expect(refs).toEqual(["r0", "r1", "r2"]);
  });

  it("zip example: uneven lengths truncate to the shorter (min)", () => {
    const { prompts, refs } = buildVideoBatchPairs(
      ["p0", "p1", "p2"],
      ["r0", "r1"],
      "zip",
    );
    expect(prompts).toEqual(["p0", "p1"]);
    expect(refs).toEqual(["r0", "r1"]);
  });

  it("cross example: 2 prompts × 3 refs → 6 pairs (prompt-outer, ref-inner)", () => {
    const { prompts, refs } = buildVideoBatchPairs(
      ["p0", "p1"],
      ["r0", "r1", "r2"],
      "cross",
    );
    expect(prompts).toEqual(["p0", "p0", "p0", "p1", "p1", "p1"]);
    expect(refs).toEqual(["r0", "r1", "r2", "r0", "r1", "r2"]);
  });
});
