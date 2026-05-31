// @vitest-environment jsdom
//
// Component tests for the ListNode video item (Requirements 5.1-5.7).
//
// Two layers are exercised:
//  1. The exported `VideoListThumb` component directly, which encapsulates the
//     poster/preload rendering (5.1, 5.2) and the hover-play / leave-pause
//     behaviour (5.3, 5.4, 5.5).
//  2. The full `ListNode` rendering a single `kind:"video"` listItem to verify
//     the <Video> badge overlay (5.6) and the double-click -> openResultViewer
//     wiring (5.7). The ReactFlow primitives that require a provider context
//     (Handle, NodeToolbar, useEdges, useConnection) are mocked so the node can
//     render standalone in jsdom.
//
// jsdom does not implement HTMLMediaElement play/pause/currentTime, so those are
// polyfilled with spies below.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";

import { VideoListThumb, ListNode } from "../ListNode";
import { useGenerationStore } from "../../../store/generation";
import type { FlowNode } from "../../../store/board";

// Mock the ReactFlow primitives that need a provider/context. Everything else
// (Position, etc.) is kept from the real module so types/enums stay intact.
vi.mock("@xyflow/react", async (importActual) => {
  const actual = await importActual<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeToolbar: ({ children, isVisible }: { children?: React.ReactNode; isVisible?: boolean }) =>
      isVisible ? <div data-testid="node-toolbar">{children}</div> : null,
    useConnection: () => ({ inProgress: false, fromNode: null }),
    useEdges: () => [],
  };
});

// ResizeHandle internally calls useReactFlow() which requires the ReactFlow
// provider. The video-item rendering under test doesn't depend on it, so render
// nothing.
vi.mock("../shared/ResizeHandle", () => ({
  ResizeHandle: () => null,
}));

// --- HTMLMediaElement polyfills (jsdom doesn't implement media playback) ----
const playMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
const pauseMock = vi.fn<() => void>();
const currentTimeStore = new WeakMap<HTMLMediaElement, number>();

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: playMock,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: pauseMock,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return currentTimeStore.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, v: number) {
      currentTimeStore.set(this, v);
    },
  });
});

beforeEach(() => {
  playMock.mockClear();
  pauseMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VideoListThumb (Req 5.1-5.5)", () => {
  it("renders a <video> element (not <img>) with poster + preload metadata (Req 5.1, 5.2)", () => {
    const { container } = render(
      <VideoListThumb src="/media/m1" poster="http://example.com/poster.jpg" fit="cover" />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(video!.getAttribute("poster")).toBe("http://example.com/poster.jpg");
    expect(video!.getAttribute("preload")).toBe("metadata");
    expect(video!.getAttribute("src")).toBe("/media/m1");
  });

  it("calls play() on mouseEnter (Req 5.3)", async () => {
    const { container } = render(<VideoListThumb src="/media/m1" fit="cover" />);
    const video = container.querySelector("video")!;

    await act(async () => {
      fireEvent.mouseEnter(video);
    });

    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("pauses and resets currentTime on mouseLeave WHILE playing (Req 5.4)", async () => {
    const { container } = render(<VideoListThumb src="/media/m1" fit="cover" />);
    const video = container.querySelector("video") as HTMLVideoElement;

    // Enter -> play() resolves -> internal `playing` becomes true.
    await act(async () => {
      fireEvent.mouseEnter(video);
    });
    // Simulate the video having advanced.
    video.currentTime = 5;
    expect(video.currentTime).toBe(5);

    fireEvent.mouseLeave(video);

    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
  });

  it("is a no-op on mouseLeave while NOT playing (does not call pause) (Req 5.5)", () => {
    const { container } = render(<VideoListThumb src="/media/m1" fit="cover" />);
    const video = container.querySelector("video") as HTMLVideoElement;

    // No mouseEnter, so the component is not playing.
    video.currentTime = 5;
    fireEvent.mouseLeave(video);

    expect(pauseMock).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(5); // state untouched
  });
});

describe("ListNode video item (Req 5.6, 5.7)", () => {
  function makeProps(): NodeProps<FlowNode> {
    const data = {
      type: "list",
      shortId: "list-1",
      title: "Results",
      status: "done",
      listViewMode: "grid",
      listItems: [
        {
          id: "m1",
          kind: "video",
          title: "Video 1",
          text: null,
          mediaId: "m1",
          flowMediaId: "m1",
          mediaUrl: null,
          imageUrl: null,
          mime: "video/mp4",
          status: "done",
        },
      ],
    };
    return {
      id: "10",
      data,
      selected: false,
    } as unknown as NodeProps<FlowNode>;
  }

  it("renders the video item as <video> (not <img>) with a <Video> badge overlay (Req 5.1, 5.6)", () => {
    const { container } = render(<ListNode {...makeProps()} />);

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();

    // The tile is the direct parent of the <video>; the badge (lucide <Video>
    // icon inside a black overlay) lives in the same tile.
    const tile = video!.parentElement as HTMLElement;
    const badge = tile.querySelector(".bg-black\\/60");
    expect(badge).not.toBeNull();
    expect(badge!.querySelector("svg")).not.toBeNull();
  });

  it("calls openResultViewer(rfId, idx) on double-click (Req 5.7)", () => {
    const spy = vi
      .spyOn(useGenerationStore.getState(), "openResultViewer")
      .mockImplementation(() => {});

    const { container } = render(<ListNode {...makeProps()} />);
    const video = container.querySelector("video")!;

    fireEvent.doubleClick(video);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("10", 0);
  });
});
