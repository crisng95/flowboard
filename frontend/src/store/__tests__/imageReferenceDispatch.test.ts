import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../cloud/supabase", () => ({
  supabase: null,
  cloudApiBaseUrl: "http://localhost",
  hasSupabaseConfig: false,
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    createRequest: vi.fn(),
    getRequest: vi.fn(),
  };
});

import * as client from "../../api/client";
import { useBoardStore } from "../board";
import { useGenerationStore } from "../generation";
import { useSettingsStore } from "../settings";

const IMAGE_RF_ID = "100";

beforeEach(() => {
  vi.mocked(client.createRequest).mockResolvedValue({ id: 1 } as never);
  vi.mocked(client.getRequest).mockResolvedValue({
    id: 1,
    status: "queued",
    result: {},
  } as never);

  useGenerationStore.setState({
    projectId: "proj-1",
    paygateTier: "PAYGATE_TIER_ONE",
    active: {},
    error: null,
  });
  useSettingsStore.setState({ imageModel: "NANO_BANANA_PRO" });
});

afterEach(() => {
  useGenerationStore.getState().cancelGeneration(IMAGE_RF_ID);
  vi.clearAllMocks();
});

describe("Image Generator dispatch with upload + text inputs", () => {
  it("keeps a single uploaded image as a gen_image reference input", async () => {
    useBoardStore.setState({
      nodes: [
        {
          id: IMAGE_RF_ID,
          type: "reference",
          position: { x: 0, y: 0 },
          data: {
            type: "reference",
            aspectKey: "1:1",
            imageCount: 1,
          },
        },
        {
          id: "upload-1",
          type: "upload",
          position: { x: -320, y: 0 },
          data: {
            type: "upload",
            status: "done",
            mediaId: "uploaded-media-id",
          },
        },
        {
          id: "text-1",
          type: "text",
          position: { x: -320, y: 220 },
          data: {
            type: "text",
            prompt: "make a polished product photo",
          },
        },
      ],
      edges: [
        {
          id: "edge-image",
          source: "upload-1",
          target: IMAGE_RF_ID,
          sourceHandle: "source",
          targetHandle: "target-image",
        },
        {
          id: "edge-text",
          source: "text-1",
          target: IMAGE_RF_ID,
          sourceHandle: "source",
          targetHandle: "target-text",
        },
      ],
    } as never);

    await useGenerationStore.getState().runNodeGraph(IMAGE_RF_ID);

    const create = vi.mocked(client.createRequest);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(arg.type).toBe("gen_image");
    expect(arg.params.prompt).toBe("make a polished product photo");
    expect(arg.params.ref_media_ids).toEqual(["uploaded-media-id"]);
    expect(arg.params.source_media_id).toBeUndefined();
  });

  it("fans out a single upstream image across every prompt in a prompt list", async () => {
    useBoardStore.setState({
      nodes: [
        {
          id: IMAGE_RF_ID,
          type: "reference",
          position: { x: 0, y: 0 },
          data: {
            type: "reference",
            aspectKey: "1:1",
            imageCount: 1,
            batchMode: "zip",
          },
        },
        {
          id: "upload-1",
          type: "upload",
          position: { x: -320, y: 0 },
          data: {
            type: "upload",
            status: "done",
            mediaId: "uploaded-media-id",
          },
        },
        {
          id: "list-1",
          type: "list",
          position: { x: -320, y: 220 },
          data: {
            type: "list",
            listItems: [
              { id: "p1", kind: "text", text: "prompt one" },
              { id: "p2", kind: "text", text: "prompt two" },
            ],
          },
        },
      ],
      edges: [
        {
          id: "edge-image",
          source: "upload-1",
          target: IMAGE_RF_ID,
          sourceHandle: "source",
          targetHandle: "target-image",
        },
        {
          id: "edge-text",
          source: "list-1",
          target: IMAGE_RF_ID,
          sourceHandle: "source-text",
          targetHandle: "target-text",
        },
      ],
    } as never);

    await useGenerationStore.getState().runNodeGraph(IMAGE_RF_ID);

    const create = vi.mocked(client.createRequest);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(arg.type).toBe("gen_image");
    expect(arg.params.variant_count).toBe(2);
    expect(arg.params.prompts).toEqual(["prompt one", "prompt two"]);
    expect(arg.params.ref_media_ids).toEqual(["uploaded-media-id", "uploaded-media-id"]);
  });
});
