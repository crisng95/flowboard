// @vitest-environment jsdom
//
// Regression test for Req 8.2: the Video_Node SHALL keep ALL of its existing
// handles — `source-video`, `source-start-image`, `source-end-image`,
// `source-audio`, `target-text`, `target-start-image`, `target-end-image`.
//
// Approach (chosen: RENDERING test): we render the real VideoGeneratorNode in
// jsdom and capture every <Handle id="..."> it emits. This is the most robust
// regression because it asserts on the component's actual rendered output, not
// a source-text scrape. The ReactFlow primitives that need a provider (Handle,
// useEdges, useConnection) are mocked: the Handle stub records each id and the
// `type` (source/target) so we can snapshot the exact handle set the node
// exposes. ResizeHandle is stubbed because it internally calls useReactFlow().
//
// Note: the node also renders a `target-references` handle (not part of the
// Req 8.2 list). We assert the seven required handles are a subset of what the
// node renders, and additionally snapshot the full rendered set so any
// accidental REMOVAL or rename of a handle fails this test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";

// Records every handle the component renders, in render order.
const renderedHandles: Array<{ id: string | undefined; type: string | undefined }> = [];

vi.mock("@xyflow/react", async (importActual) => {
  const actual = await importActual<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: (props: { id?: string; type?: string; children?: React.ReactNode }) => {
      renderedHandles.push({ id: props.id, type: props.type });
      // Render children so HandleBadge (and its internals) still mount, keeping
      // the render path realistic.
      return <div data-handle-id={props.id} data-handle-type={props.type}>{props.children}</div>;
    },
    useEdges: () => [],
    useConnection: () => ({ inProgress: false, fromNode: null }),
  };
});

// ResizeHandle -> useReactFlow() needs the provider; not relevant to handles.
vi.mock("../shared/ResizeHandle", () => ({
  ResizeHandle: () => null,
}));

import { VideoGeneratorNode } from "../VideoGeneratorNode";
import type { FlowNode } from "../../../store/board";

const REQUIRED_HANDLE_IDS = [
  "source-video",
  "source-start-image",
  "source-end-image",
  "source-audio",
  "target-text",
  "target-start-image",
  "target-end-image",
] as const;

function makeProps(): NodeProps<FlowNode> {
  return {
    id: "1",
    data: {
      type: "video",
      shortId: "vid-1",
      title: "Video Generator",
      status: "idle",
      prompt: "a cat",
    },
    selected: false,
  } as unknown as NodeProps<FlowNode>;
}

beforeEach(() => {
  renderedHandles.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("Req 8.2 — Video_Node preserves all existing handles", () => {
  it("renders every required handle id", () => {
    render(<VideoGeneratorNode {...makeProps()} />);

    const ids = new Set(renderedHandles.map((h) => h.id));
    for (const required of REQUIRED_HANDLE_IDS) {
      expect(ids.has(required), `missing handle "${required}"`).toBe(true);
    }
  });

  it("assigns the correct source/target role to each required handle", () => {
    render(<VideoGeneratorNode {...makeProps()} />);

    const byId = new Map(renderedHandles.map((h) => [h.id, h.type]));
    // Output (source) handles.
    expect(byId.get("source-video")).toBe("source");
    expect(byId.get("source-start-image")).toBe("source");
    expect(byId.get("source-end-image")).toBe("source");
    expect(byId.get("source-audio")).toBe("source");
    // Input (target) handles.
    expect(byId.get("target-text")).toBe("target");
    expect(byId.get("target-start-image")).toBe("target");
    expect(byId.get("target-end-image")).toBe("target");
  });

  it("snapshots the full set of rendered handle ids (guards against removals)", () => {
    render(<VideoGeneratorNode {...makeProps()} />);

    const ids = renderedHandles
      .map((h) => h.id)
      .filter((id): id is string => typeof id === "string")
      .sort();

    // The node currently renders the seven required handles plus the extra
    // `target-references` input. Pinning the exact set makes any removal or
    // rename of a handle fail loudly.
    expect(ids).toEqual(
      [
        "source-audio",
        "source-end-image",
        "source-start-image",
        "source-video",
        "target-end-image",
        "target-references",
        "target-start-image",
        "target-text",
      ].sort(),
    );
  });
});
