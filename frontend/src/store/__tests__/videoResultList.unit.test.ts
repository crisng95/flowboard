import { describe, it, expect } from "vitest";
import {
  buildPlaceholderListItems,
  buildVideoResultListItems,
} from "../generation";

/**
 * Example-based unit tests for the pure Batch_Result_List builder helpers in
 * `store/generation.ts`. These pin down concrete examples and edge cases that
 * complement the property-based suite in `videoResultList.test.ts`:
 *
 *   - buildVideoResultListItems: an all-success batch (N=3).
 *   - buildVideoResultListItems: a middle-slot error keeps surrounding slots
 *     in their original positions (Req 3.3, 3.4).
 *   - buildPlaceholderListItems: every slot is an empty `pending` placeholder.
 *
 * _Requirements: 3.3, 3.4, 3.5_
 */

describe("buildVideoResultListItems — all-success example (N=3)", () => {
  it("emits 3 done video items aligned positionally with their media ids", () => {
    const result = buildVideoResultListItems({
      mediaIds: ["id0", "id1", "id2"],
      flowMediaIds: ["flow0", "flow1", "flow2"],
      assetIds: ["asset0", "asset1", "asset2"],
      slotErrors: [null, null, null],
      prompts: ["prompt 0", "prompt 1", "prompt 2"],
    });

    // Req 3.5: exactly N items and variantCount === N.
    expect(result.listItems).toHaveLength(3);
    expect(result.variantCount).toBe(3);

    // Every slot succeeded: kind video + done + mediaId aligned to its index.
    result.listItems.forEach((item, i) => {
      expect(item.kind).toBe("video");
      expect(item.status).toBe("done");
      expect(item.mediaId).toBe(`id${i}`);
      expect(item.flowMediaId).toBe(`flow${i}`);
      expect(item.mediaUrl).toBe(`id${i}`);
      expect(item.mime).toBe("video/mp4");
      expect(item.title).toBe(`Video ${i + 1}`);
      expect(item.error).toBeUndefined();
    });

    // Unique ids prefer the flow media id.
    expect(result.listItems.map((it) => it.id)).toEqual([
      "flow0",
      "flow1",
      "flow2",
    ]);

    // Downstream arrays contain only successful slots, in order.
    expect(result.mediaIds).toEqual(["id0", "id1", "id2"]);
    expect(result.flowMediaIds).toEqual(["flow0", "flow1", "flow2"]);
    expect(result.listSelectedIndexes).toEqual([]);
  });
});

describe("buildVideoResultListItems — middle slot error", () => {
  it("keeps the error at index 1 without shifting slots 0 and 2", () => {
    const result = buildVideoResultListItems({
      mediaIds: ["id0", null, "id2"],
      flowMediaIds: ["flow0", null, "flow2"],
      assetIds: ["asset0", null, "asset2"],
      slotErrors: [null, "blocked", null],
      prompts: ["prompt 0", "prompt 1", "prompt 2"],
    });

    // Req 3.3: length stays N — the error slot is preserved, not dropped.
    expect(result.listItems).toHaveLength(3);
    expect(result.variantCount).toBe(3);

    // Req 3.4: middle slot is an error carrying the worker's slot_errors text.
    const errored = result.listItems[1];
    expect(errored.status).toBe("error");
    expect(errored.kind).toBe("video");
    expect(errored.mediaId).toBeNull();
    expect(errored.flowMediaId).toBeNull();
    expect(errored.mediaUrl).toBeNull();
    expect(errored.error).toBe("blocked");
    expect(errored.title).toBe("Video 2");

    // Req 3.3: surrounding successful slots stay at their original indices.
    const first = result.listItems[0];
    expect(first.status).toBe("done");
    expect(first.mediaId).toBe("id0");
    expect(first.flowMediaId).toBe("flow0");
    expect(first.title).toBe("Video 1");

    const third = result.listItems[2];
    expect(third.status).toBe("done");
    expect(third.mediaId).toBe("id2");
    expect(third.flowMediaId).toBe("flow2");
    expect(third.title).toBe("Video 3");

    // Downstream arrays exclude the failed slot but keep the rest in order.
    expect(result.mediaIds).toEqual(["id0", "id2"]);
    expect(result.flowMediaIds).toEqual(["flow0", "flow2"]);
  });
});

describe("buildPlaceholderListItems — pending placeholders", () => {
  it("produces N pending video placeholders with no media", () => {
    const titles = ["Video 1", "Video 2", "Video 3"];
    const result = buildPlaceholderListItems(3, titles);

    expect(result.listItems).toHaveLength(3);
    expect(result.variantCount).toBe(3);

    result.listItems.forEach((item, i) => {
      expect(item.kind).toBe("video");
      expect(item.status).toBe("pending");
      expect(item.mediaId).toBeNull();
      expect(item.flowMediaId).toBeNull();
      expect(item.mediaUrl).toBeNull();
      expect(item.imageUrl).toBeNull();
      expect(item.mime).toBe("video/mp4");
      expect(item.id).toBe(`video-slot-${i}`);
      expect(item.title).toBe(titles[i]);
    });

    // No result media yet while slots are still placeholders.
    expect(result.mediaIds).toEqual([]);
    expect(result.flowMediaIds).toEqual([]);
    expect(result.listSelectedIndexes).toEqual([]);
  });

  it("falls back to a default title when titles[i] is missing", () => {
    const result = buildPlaceholderListItems(2, []);

    expect(result.listItems).toHaveLength(2);
    expect(result.listItems[0].title).toBe("Video 1");
    expect(result.listItems[1].title).toBe("Video 2");
    result.listItems.forEach((item) => {
      expect(item.status).toBe("pending");
      expect(item.mediaId).toBeNull();
    });
  });
});
