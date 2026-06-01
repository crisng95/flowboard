import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Module mocks -----------------------------------------------------------
// supabase must resolve to `null` so dispatchGeneration skips the auth
// session check (otherwise it would attempt a real auth.getSession()
// network call). A known paygate tier is still set in beforeEach.
vi.mock("../../cloud/supabase", () => ({
  supabase: null,
  cloudApiBaseUrl: "http://localhost",
  hasSupabaseConfig: false,
}));

// Mock the API client: keep every real export (board.ts imports many of
// them) but override createRequest/getRequest so we can capture the
// dispatched params without hitting the network.
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    createRequest: vi.fn(),
    getRequest: vi.fn(),
  };
});

import * as client from "../../api/client";
import { useGenerationStore } from "../generation";
import { useSettingsStore } from "../settings";
import { useBoardStore } from "../board";

const RF_ID = "100";

function mockedCreateRequest() {
  return vi.mocked(client.createRequest);
}

beforeEach(() => {
  vi.mocked(client.createRequest).mockResolvedValue({ id: 1 } as never);
  vi.mocked(client.getRequest).mockResolvedValue({
    status: "done",
    result: {},
  } as never);

  // Project already bootstrapped + a known tier so dispatch proceeds
  // straight to building the request.
  useGenerationStore.setState({ projectId: "proj-1", paygateTier: "PAYGATE_TIER_ONE", active: {} });
  // Force the Omni Flash branch.
  useSettingsStore.setState({ videoModel: "omni_flash", omniFlashDuration: 4 });
  // Empty board by default (batch case needs no upstream graph).
  useBoardStore.setState({ nodes: [], edges: [] } as never);
});

afterEach(() => {
  // Clear the scheduled poll timer so it doesn't leak across tests.
  useGenerationStore.getState().cancelGeneration(RF_ID);
  vi.clearAllMocks();
});

describe("dispatchGeneration — Omni Flash branch", () => {
  it("forwards start_media_ids + prompts when sourceMediaIds.length > 1 (batch)", async () => {
    await useGenerationStore.getState().dispatchGeneration(RF_ID, {
      prompt: "shared",
      kind: "video",
      aspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
      variantCount: 3,
      prompts: ["p1", "p2", "p3"],
      sourceMediaIds: ["a", "b", "c"],
    });

    const create = mockedCreateRequest();
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(arg.type).toBe("gen_video_omni");
    expect(arg.params.start_media_ids).toEqual(["a", "b", "c"]);
    expect(arg.params.prompts).toEqual(["p1", "p2", "p3"]);
  });

  it("omits start_media_ids for single-input (keeps ref_media_ids)", async () => {
    // Single-input Omni needs at least one ingredient; provide one via an
    // upstream image node connected on the references handle.
    useBoardStore.setState({
      nodes: [
        { id: RF_ID, type: "video", position: { x: 0, y: 0 }, data: { type: "video" } },
        {
          id: "200",
          type: "image",
          position: { x: 0, y: 0 },
          data: { type: "image", mediaId: "img-1" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "200",
          target: RF_ID,
          targetHandle: "target-references",
          sourceHandle: "source",
        },
      ],
    } as never);

    await useGenerationStore.getState().dispatchGeneration(RF_ID, {
      prompt: "single",
      kind: "video",
      aspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
      variantCount: 1,
      // No sourceMediaIds → not a batch.
    });

    const create = mockedCreateRequest();
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(arg.type).toBe("gen_video_omni");
    expect(arg.params.start_media_ids).toBeUndefined();
    expect(arg.params.ref_media_ids).toEqual(["img-1"]);
  });
});
