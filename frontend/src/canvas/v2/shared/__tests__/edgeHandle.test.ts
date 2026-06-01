import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  edgeHandleClass,
  EDGE_HANDLE_TOP_OFFSET,
  EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET,
} from "../edgeHandle";
import { targetHandleDropState } from "../handleClassParts";

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

describe("edgeHandleClass", () => {
  it("// Feature: canvas-v2-design-conformance, Property 1: Target-handle drop-state invariant", () => {
    fc.assert(
      fc.property(
        fc.record({
          inProgress: fc.boolean(),
          hovered: fc.boolean(),
          selected: fc.boolean(),
          hasEdge: fc.boolean(),
        }),
        fc.constantFrom<"left" | "right">("left", "right"),
        (state, side) => {
          const decision = targetHandleDropState(state);
          const className = edgeHandleClass({
            side,
            visible: decision !== "idle-hidden",
            dragActive: decision === "droppable",
          });
          const tokens = tokenSet(className);

          if (state.inProgress) {
            expect(tokens.has("!opacity-100")).toBe(true);
            expect(tokens.has("!pointer-events-auto")).toBe(true);
            expect(tokens.has("!z-50")).toBe(true);
            expect(tokens.has("!opacity-0")).toBe(false);
            expect(tokens.has("!pointer-events-none")).toBe(false);
            expect(decision).toBe("droppable");
            return;
          }

          if (!state.hovered && !state.selected && !state.hasEdge) {
            expect(tokens.has("!opacity-0")).toBe(true);
            expect(tokens.has("!pointer-events-none")).toBe(true);
            expect(tokens.has("!pointer-events-auto")).toBe(false);
            expect(tokens.has("!z-50")).toBe(false);
            expect(decision).toBe("idle-hidden");
            return;
          }

          expect(tokens.has("!opacity-100")).toBe(true);
          expect(tokens.has("!opacity-0")).toBe(false);
          expect(tokens.has("!pointer-events-none")).toBe(false);
          expect(tokens.has("!pointer-events-auto")).toBe(false);
          expect(tokens.has("!z-50")).toBe(false);
          expect(decision).toBe("visible-idle");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("adds the drag override tokens only when dragActive is true", () => {
    const dragActive = tokenSet(edgeHandleClass({ side: "left", visible: false, dragActive: true }));
    expect(dragActive.has("!opacity-100")).toBe(true);
    expect(dragActive.has("!pointer-events-auto")).toBe(true);
    expect(dragActive.has("!z-50")).toBe(true);

    expect(edgeHandleClass({ side: "left", visible: false })).toBe(
      "!absolute !h-7 !w-7 !border-0 !bg-transparent group/handle !-left-0 transition-opacity duration-300 ease-out !opacity-0 !pointer-events-none",
    );
  });

  it("keeps the shared handle offsets unchanged", () => {
    expect(EDGE_HANDLE_TOP_OFFSET).toBe(48);
    expect(EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET).toBe(72);
  });
});
