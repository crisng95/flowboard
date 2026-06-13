// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { Type } from "lucide-react";

let mockEdges: Array<Record<string, unknown>> = [];
let mockConnection: { inProgress: boolean; fromNode: { id: string } | null } = {
  inProgress: false,
  fromNode: null,
};

vi.mock("@xyflow/react", async (importActual) => {
  const actual = await importActual<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: (props: {
      id?: string;
      type?: string;
      className?: string;
      children?: React.ReactNode;
    }) => (
      <div
        data-testid={`handle-${props.id}`}
        data-handle-id={props.id}
        data-handle-type={props.type}
        className={props.className}
      >
        {props.children}
      </div>
    ),
    NodeToolbar: ({ children, isVisible }: { children: React.ReactNode; isVisible?: boolean }) =>
      isVisible ? <div data-testid="node-toolbar">{children}</div> : null,
    useConnection: () => mockConnection,
    useEdges: () => mockEdges,
    useReactFlow: () => ({ getZoom: () => 1 }),
  };
});

vi.mock("../shared/ResizeHandle", () => ({
  ResizeHandle: () => null,
}));

vi.mock("../shared/useFloatingDropdownPosition", () => ({
  useFloatingDropdownPosition: (anchorRef: React.RefObject<HTMLElement>, isOpen: boolean, options: {
    minWidth?: number;
    estimatedHeight?: number;
  }) => {
    if (!isOpen || !anchorRef.current) return null;
    return {
      left: 0,
      top: 0,
      minWidth: options.minWidth ?? 136,
      maxHeight: options.estimatedHeight ?? 212,
      placement: "bottom",
    };
  },
}));

vi.mock("../shared/persistNodeData", () => ({
  persistNodeData: vi.fn(),
}));

import { ImageGeneratorNode } from "../ImageGeneratorNode";
import { AssistantNode } from "../AssistantNode";
import { ListNode } from "../ListNode";
import { NodeShell } from "../NodeShell";
import { NoteNode } from "../NoteNode";
import { VideoGeneratorNode } from "../VideoGeneratorNode";
import { persistNodeData } from "../shared/persistNodeData";
import type { FlowNode } from "../../../store/board";
import { useBoardStore } from "../../../store/board";
import { useGenerationStore } from "../../../store/generation";

const persistNodeDataMock = vi.mocked(persistNodeData);
const clipboardWriteText = vi.fn();

function makeNodeProps(data: Record<string, unknown>, selected = false, id = "1"): NodeProps<FlowNode> {
  return {
    id,
    data: {
      shortId: `${data.type ?? "node"}-1`,
      title: String(data.title ?? data.type ?? "Node"),
      ...data,
    },
    selected,
  } as unknown as NodeProps<FlowNode>;
}

function expectClassTokens(className: string, present: string[], absent: string[] = []) {
  for (const token of present) {
    expect(className.includes(token), `expected ${token} in ${className}`).toBe(true);
  }
  for (const token of absent) {
    expect(className.includes(token), `did not expect ${token} in ${className}`).toBe(false);
  }
}

beforeEach(() => {
  cleanup();
  mockEdges = [];
  mockConnection = { inProgress: false, fromNode: null };
  persistNodeDataMock.mockReset();
  clipboardWriteText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
  useBoardStore.setState((state) => ({ ...state, nodes: [], edges: [] }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("canvas-v2 design conformance", () => {
  it("applies the drag override to every VideoGeneratorNode target handle during a connection drag", () => {
    mockConnection = { inProgress: true, fromNode: { id: "upstream" } };

    render(
      <VideoGeneratorNode
        {...makeNodeProps({ type: "video", status: "idle", prompt: "hello" }, false)}
      />,
    );

    const targetIds = ["target-text", "target-start-image", "target-end-image", "target-references"];
    for (const id of targetIds) {
      const handle = screen.getByTestId(`handle-${id}`);
      expectClassTokens(handle.className, ["!opacity-100", "!pointer-events-auto", "!z-50"]);
    }

    const sourceHandle = screen.getByTestId("handle-source-video");
    expectClassTokens(sourceHandle.className, [], ["!z-50", "!pointer-events-auto"]);
  });

  it("applies the exact drag override to the NodeShell target handle only", () => {
    mockConnection = { inProgress: true, fromNode: { id: "other" } };

    render(
      <NodeShell
        id="node-1"
        Icon={Type}
        title="Text"
        selected={false}
        targetHandle={{ id: "target", icon: Type, label: "Input" }}
        sourceHandle={{ id: "source", icon: Type, label: "Output" }}
      >
        <div>content</div>
      </NodeShell>,
    );

    const targetHandle = screen.getByTestId("handle-target");
    expectClassTokens(targetHandle.className, ["!opacity-100", "!pointer-events-auto", "!z-50"]);

    const sourceHandle = screen.getByTestId("handle-source");
    expectClassTokens(sourceHandle.className, [], ["!pointer-events-auto", "!z-50"]);
  });

  it("keeps ListNode and NoteNode selected rings on ring-2 accent/50", () => {
    const listView = render(
      <ListNode
        {...makeNodeProps(
          {
            type: "list",
            title: "List",
            status: "idle",
            listItems: [{ id: "t1", kind: "text", text: "hello", title: "hello" }],
            listSelectedIndexes: [],
          },
          true,
        )}
      />,
    );
    const listCard = listView.container.querySelector('[data-selected="true"]') as HTMLElement;
    expectClassTokens(listCard.className, ["ring-2", "ring-accent/50"], ["ring-1", "ring-accent/30"]);
    listView.unmount();

    const noteView = render(
      <NoteNode
        {...makeNodeProps(
          {
            type: "note",
            title: "Note",
            prompt: "hello",
          },
          true,
        )}
      />,
    );
    const noteEditor = noteView.container.querySelector(".note-editor-content") as HTMLElement;
    const noteCard = noteEditor.parentElement as HTMLElement;
    expectClassTokens(noteCard.className, ["ring-2", "ring-accent/50"], ["ring-accent/60"]);
  });

  it("renders the ListNode intake dropdown through the shared portal and persists selection", async () => {
    const updateNodeDataSpy = vi.spyOn(useBoardStore.getState(), "updateNodeData").mockImplementation(() => {});

    const view = render(
      <ListNode
        {...makeNodeProps(
          {
            type: "list",
            title: "List",
            status: "idle",
            listItems: [{ id: "t1", kind: "text", text: "hello", title: "hello" }],
            listSelectedIndexes: [],
            listIntakeMode: "replace",
          },
          true,
        )}
      />,
    );

    const card = view.container.querySelector('[data-selected="true"]') as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: /replace items/i }));

    const keepOption = await screen.findByRole("button", { name: /keep items/i });
    expect(document.body.contains(keepOption)).toBe(true);
    expect(card.contains(keepOption)).toBe(false);

    const portal = keepOption.closest(".fixed") as HTMLElement;
    expect(portal).toBeTruthy();
    expect(portal.className.includes("nowheel")).toBe(true);
    expect(portal.className.includes("z-[9999]")).toBe(true);

    fireEvent.click(keepOption);
    expect(updateNodeDataSpy).toHaveBeenCalledWith("1", { listIntakeMode: "keep" });
    expect(persistNodeDataMock).toHaveBeenCalledWith("1", { listIntakeMode: "keep" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /keep items/i })).toBe(null);
    });

    fireEvent.click(screen.getByRole("button", { name: /replace items/i }));
    await screen.findByRole("button", { name: /keep items/i });
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /keep items/i })).toBe(null);
    });
  });

  it("keeps the audited node cards on 16px outer radius without forbidden 20/24px values", () => {
    const imageView = render(
      <ImageGeneratorNode
        {...makeNodeProps({ type: "image", title: "Image Generator", status: "idle", prompt: "cat" }, true)}
      />,
    );
    const imageCard = imageView.container.querySelector('[data-selected="true"]') as HTMLElement;
    expect(imageCard.style.borderRadius).toBe("16px");
    expect(imageView.container.innerHTML.includes("border-radius: 20px")).toBe(false);
    expect(imageView.container.innerHTML.includes("border-radius: 24px")).toBe(false);
    imageView.unmount();

    const videoView = render(
      <VideoGeneratorNode
        {...makeNodeProps({ type: "video", title: "Video Generator", status: "idle", prompt: "cat" }, true)}
      />,
    );
    const videoCard = videoView.container.querySelector('[data-selected="true"]') as HTMLElement;
    expect(videoCard.style.borderRadius).toBe("16px");
    expect(videoView.container.innerHTML.includes("border-radius: 20px")).toBe(false);
    expect(videoView.container.innerHTML.includes("border-radius: 24px")).toBe(false);
    videoView.unmount();

    const listView = render(
      <ListNode
        {...makeNodeProps(
          {
            type: "list",
            title: "List",
            status: "idle",
            listItems: [{ id: "t1", kind: "text", text: "hello", title: "hello" }],
            listSelectedIndexes: [],
          },
          true,
        )}
      />,
    );
    const listCard = listView.container.querySelector('[data-selected="true"]') as HTMLElement;
    expect(listCard.style.borderRadius).toBe("16px");
    expect(listView.container.innerHTML.includes("border-radius: 20px")).toBe(false);
    expect(listView.container.innerHTML.includes("border-radius: 24px")).toBe(false);
    listView.unmount();

    const noteView = render(
      <NoteNode
        {...makeNodeProps({ type: "note", title: "Note", prompt: "hello" }, true)}
      />,
    );
    const noteEditor = noteView.container.querySelector(".note-editor-content") as HTMLElement;
    const noteCard = noteEditor.parentElement as HTMLElement;
    expect(noteCard.style.borderRadius).toBe("16px");
    expect(noteView.container.innerHTML.includes("border-radius: 20px")).toBe(false);
    expect(noteView.container.innerHTML.includes("border-radius: 24px")).toBe(false);
  });

  it("locks ImageGeneratorNode batch count to prompt fanout when one image is paired with assistant list output", () => {
    mockEdges = [
      {
        id: "edge-image",
        source: "upload-1",
        target: "1",
        sourceHandle: "source",
        targetHandle: "target-image",
      },
      {
        id: "edge-text",
        source: "assistant-1",
        target: "1",
        sourceHandle: "source",
        targetHandle: "target-text",
      },
    ];

    useBoardStore.setState((state) => ({
      ...state,
      nodes: [
        {
          id: "1",
          type: "reference",
          position: { x: 0, y: 0 },
          data: { type: "reference", title: "Image Generator", imageCount: 1 },
        } as unknown as FlowNode,
        {
          id: "upload-1",
          type: "upload",
          position: { x: -320, y: 0 },
          data: { type: "upload", title: "Upload", mediaId: "media-1", status: "done" },
        } as unknown as FlowNode,
        {
          id: "assistant-1",
          type: "assistant",
          position: { x: -320, y: 220 },
          data: {
            type: "assistant",
            title: "Assistant",
            assistantStatus: "done",
            assistantExportMode: "list",
            assistantOutput: "- prompt one\n\n- prompt two",
          },
        } as unknown as FlowNode,
      ],
      edges: mockEdges as never,
    }));

    render(
      <ImageGeneratorNode
        {...makeNodeProps(
          {
            type: "reference",
            title: "Image Generator",
            imageCount: 1,
          },
          false,
        )}
      />,
    );

    expect(screen.getByText("x2")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Count" })).toBe(null);
  });

  it("keeps AssistantNode on the v2 card system and default result view when output exists", () => {
    const view = render(
      <AssistantNode
        {...makeNodeProps(
          {
            type: "assistant",
            title: "Assistant",
            assistantOutput: "Synthesized answer",
            assistantStatus: "done",
          },
          true,
        )}
      />,
    );

    const assistantCard = view.container.querySelector('[data-selected="true"]') as HTMLElement;
    expect(assistantCard).toBeTruthy();
    expect(assistantCard.className.includes("border-[3px]")).toBe(true);
    expect(assistantCard.className.includes("border-white/[0.14]")).toBe(true);
    expect(assistantCard.style.borderRadius).toBe("16px");

    const panels = view.container.querySelectorAll(".rounded-2xl");
    expect(view.container.innerHTML.includes("rounded-[24px]")).toBe(false);
    expect(panels.length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Result" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Synthesized answer")).toBeTruthy();
  });

  it("keeps AssistantNode handles visible during a connection drag and uses the v2 run button treatment", () => {
    mockConnection = { inProgress: true, fromNode: { id: "upstream" } };

    const view = render(
      <AssistantNode
        {...makeNodeProps(
          {
            type: "assistant",
            title: "Assistant",
            assistantStatus: "running",
          },
          false,
        )}
      />,
    );

    const targetIds = ["target-text", "target-image", "target-video"];
    for (const id of targetIds) {
      const handle = screen.getByTestId(`handle-${id}`);
      expectClassTokens(handle.className, ["!opacity-100", "!pointer-events-auto", "!z-50"]);
    }

    const sourceHandle = screen.getByTestId("handle-source");
    expectClassTokens(sourceHandle.className, [], ["!pointer-events-auto", "!z-50"]);

    const runButton = screen.getByRole("button", { name: /running/i });
    expect(runButton.className.includes("h-10")).toBe(true);
    expect(runButton.className.includes("rounded-full")).toBe(true);
    expect(view.container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("keeps AssistantNode prompt view as the default when no output exists and copies output when available", () => {
    const runNodeGraphSpy = vi.spyOn(useGenerationStore.getState(), "runNodeGraph").mockImplementation(async () => {});

    const noOutputView = render(
      <AssistantNode
        {...makeNodeProps(
          {
            type: "assistant",
            title: "Assistant",
            assistantPrompt: "Rewrite the brief",
            assistantStatus: "idle",
          },
          false,
        )}
      />,
    );

    expect(screen.getByRole("tab", { name: "Prompt" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByDisplayValue("Rewrite the brief")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /run assistant/i }));
    expect(runNodeGraphSpy).toHaveBeenCalledWith("1");
    noOutputView.unmount();

    render(
      <AssistantNode
        {...makeNodeProps(
          {
            type: "assistant",
            title: "Assistant",
            assistantOutput: "Ready to paste",
            assistantStatus: "done",
          },
          false,
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy output/i }));
    expect(clipboardWriteText).toHaveBeenCalledWith("Ready to paste");
  });

  it("defaults AssistantNode export mode to list for upstream prompt lists and persists manual export changes", () => {
    mockEdges = [
      {
        id: "edge-brand",
        source: "text-1",
        target: "1",
        sourceHandle: "source",
        targetHandle: "target-text",
      },
      {
        id: "edge-text",
        source: "list-1",
        target: "1",
        sourceHandle: "source-text",
        targetHandle: "target-text",
      },
    ];
    useBoardStore.setState((state) => ({
      ...state,
      nodes: [
        {
          id: "1",
          type: "assistant",
          position: { x: 0, y: 0 },
          data: { type: "assistant", title: "Assistant" },
        } as unknown as FlowNode,
        {
          id: "text-1",
          type: "text",
          position: { x: -420, y: 0 },
          data: { type: "text", title: "Brand", prompt: "Brand" },
        } as unknown as FlowNode,
        {
          id: "list-1",
          type: "list",
          position: { x: -320, y: 0 },
          data: {
            type: "list",
            listItems: [{ id: "t1", kind: "text", text: "prompt one", title: "prompt one" }],
            listSelectedIndexes: [],
          },
        } as unknown as FlowNode,
      ],
      edges: mockEdges as never,
    }));

    render(
      <AssistantNode
        {...makeNodeProps(
          {
            type: "assistant",
            title: "Assistant",
          },
          false,
        )}
      />,
    );

    expect(screen.getByRole("button", { name: /export as list/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /export as list/i }));
    fireEvent.click(screen.getByRole("button", { name: /Export As Text/ }));

    expect(persistNodeDataMock).toHaveBeenCalledWith("1", { assistantExportMode: "text" });
  });
});
