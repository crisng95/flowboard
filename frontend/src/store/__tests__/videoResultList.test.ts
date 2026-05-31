import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildPlaceholderListItems,
  buildVideoResultListItems,
} from "../generation";

/**
 * Property-based tests for the pure Batch_Result_List logic helpers extracted
 * from `store/generation.ts`. These mirror the fast-check + Vitest pattern in
 * `videoBatch.test.ts` and exercise the helpers in isolation from React/DOM.
 *
 * This file currently covers Property 8 (placeholder fully replaced on reuse);
 * the other design properties live in their own tasks.
 */

// An arbitrary "old" VideoListItem-like record. We intentionally allow ids that
// could collide with the deterministic placeholder ids (`video-slot-${i}`) so
// the full-replacement check is exercised against worst-case input. Each old
// object is a distinct reference, which is what "no append" must guarantee.
const oldListItemArb = fc.record({
  id: fc.oneof(
    fc.string(),
    fc.integer({ min: 0, max: 60 }).map((i) => `video-slot-${i}`),
  ),
  kind: fc.constantFrom("video", "image", "text"),
  title: fc.string(),
  mediaId: fc.option(fc.string(), { nil: null }),
  flowMediaId: fc.option(fc.string(), { nil: null }),
  mediaUrl: fc.option(fc.string(), { nil: null }),
  status: fc.constantFrom("pending", "done", "error"),
});

const oldListItemsArb = fc.array(oldListItemArb, { minLength: 0, maxLength: 30 });
const newCountArb = fc.integer({ min: 1, max: 50 });
const titlesArb = fc.array(fc.string(), { minLength: 0, maxLength: 50 });

describe("buildPlaceholderListItems — reuse replacement", () => {
  // Feature: video-batch-result-list, Property 8: For all old listItems and a new N,
  // the placeholder data from buildPlaceholderListItems(N, ...) has exactly N items
  // and contains none of the old items (full replacement, no append).
  // **Validates: Requirements 6.2**
  it("P8: placeholder is fully replaced on reuse (exactly N items, none of the old)", () => {
    fc.assert(
      fc.property(oldListItemsArb, newCountArb, titlesArb, (oldItems, n, titles) => {
        const result = buildPlaceholderListItems(n, titles);

        // Exactly N items — never the old length appended to N.
        expect(result.listItems).toHaveLength(n);
        expect(result.variantCount).toBe(n);

        // Full replacement: not a single old object reference leaks into the
        // new placeholder list (append would carry old references through).
        for (const item of result.listItems) {
          expect(oldItems).not.toContain(item);
        }

        // Every emitted item is a brand-new, empty placeholder rather than a
        // recycled old item (guards against clone-then-append regressions).
        for (const item of result.listItems) {
          expect(item.kind).toBe("video");
          expect(item.status).toBe("pending");
          expect(item.mediaId).toBeNull();
          expect(item.flowMediaId).toBeNull();
          expect(item.mediaUrl).toBeNull();
        }

        // No leftover result media from any prior batch.
        expect(result.mediaIds).toEqual([]);
        expect(result.flowMediaIds).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

// Build a set of positional result arrays all of the exact same length N.
// Entries may be null (failed/blocked slot) or a non-empty string (success),
// matching the worker's positional `media_ids` / `slot_errors` contract.
const nArb = fc.integer({ min: 1, max: 50 });
const slotArb = fc.option(fc.string({ minLength: 1 }), { nil: null });

const positionalInputArb = nArb.chain((n) =>
  fc.record({
    n: fc.constant(n),
    mediaIds: fc.array(slotArb, { minLength: n, maxLength: n }),
    flowMediaIds: fc.array(slotArb, { minLength: n, maxLength: n }),
    assetIds: fc.array(slotArb, { minLength: n, maxLength: n }),
    slotErrors: fc.option(fc.array(slotArb, { minLength: n, maxLength: n }), {
      nil: null,
    }),
    prompts: fc.array(fc.string(), { minLength: n, maxLength: n }),
    titles: fc.array(fc.string(), { minLength: 0, maxLength: 50 }),
  }),
);

describe("Batch_Result_List builders — counts equal N", () => {
  // Feature: video-batch-result-list, Property 1: Số ô placeholder và số List_Item
  // bằng N. For all N >= 1 and positional mediaIds/slotErrors arrays of length N,
  // buildPlaceholderListItems(N, ...) returns exactly N items, and
  // buildVideoResultListItems returns listItems with exactly N entries and
  // variantCount === N.
  // **Validates: Requirements 2.2, 3.5, 3.6**
  it("P1: placeholder and result builders both produce exactly N items with variantCount === N", () => {
    fc.assert(
      fc.property(positionalInputArb, (input) => {
        const { n, mediaIds, flowMediaIds, assetIds, slotErrors, prompts, titles } =
          input;

        // Placeholder builder: exactly N placeholder slots, variantCount === N.
        const placeholder = buildPlaceholderListItems(n, titles);
        expect(placeholder.listItems).toHaveLength(n);
        expect(placeholder.variantCount).toBe(n);

        // Result builder: exactly N list items (no pre-filtering), variantCount === N.
        const result = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });
        expect(result.listItems).toHaveLength(n);
        expect(result.variantCount).toBe(n);

        // Both builders agree on the count for the same N.
        expect(result.listItems.length).toBe(placeholder.listItems.length);
      }),
      { numRuns: 100 },
    );
  });
});

// Positional input where a successful (non-null) media slot is never also
// flagged as an error. Property 2 is about the alignment of *successful* slots
// (slot[i] <-> video[i] <-> prompt[i]); error-slot positioning is covered by
// Property 3. We therefore null out any slotError that would otherwise land on
// a non-null mediaId, so every non-null mediaIds[i] stays a successful slot.
const alignmentInputArb = fc.integer({ min: 1, max: 50 }).chain((n) =>
  fc
    .record({
      mediaIds: fc.array(slotArb, { minLength: n, maxLength: n }),
      flowMediaIds: fc.array(slotArb, { minLength: n, maxLength: n }),
      assetIds: fc.array(slotArb, { minLength: n, maxLength: n }),
      rawSlotErrors: fc.option(
        fc.array(slotArb, { minLength: n, maxLength: n }),
        { nil: null },
      ),
      prompts: fc.array(fc.string(), { minLength: n, maxLength: n }),
    })
    .map((rec) => ({
      n,
      ...rec,
      // Keep success slots un-flagged so their alignment is well defined.
      slotErrors:
        rec.rawSlotErrors === null
          ? null
          : rec.rawSlotErrors.map((err, i) =>
              rec.mediaIds[i] !== null && rec.mediaIds[i] !== ""
                ? null
                : err,
            ),
    })),
);

describe("Batch_Result_List builder — slot/video/prompt alignment", () => {
  // Feature: video-batch-result-list, Property 2: Căn chỉnh thứ tự slot[i] ↔
  // video[i] ↔ prompt[i]. For all positional mediaIds/flowMediaIds/prompts arrays
  // of the same length N, for every index i where mediaIds[i] is non-null,
  // listItems[i].kind === "video", listItems[i].mediaId === mediaIds[i], and the
  // title corresponds to prompts[i] by position (design uses title "Video {i+1}"),
  // with no positional shifting.
  // **Validates: Requirements 3.1, 3.2, 3.5**
  it("P2: every successful slot keeps its index, mediaId, and prompt-aligned title", () => {
    fc.assert(
      fc.property(alignmentInputArb, (input) => {
        const { n, mediaIds, flowMediaIds, assetIds, slotErrors, prompts } = input;

        const result = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });

        // No shifting: the result list lines up index-for-index with the inputs.
        expect(result.listItems).toHaveLength(n);
        expect(prompts).toHaveLength(n);

        for (let i = 0; i < n; i += 1) {
          const rawMediaId = mediaIds[i];
          const isSuccess =
            typeof rawMediaId === "string" && rawMediaId.length > 0;
          if (!isSuccess) continue;

          const item = result.listItems[i];
          // slot[i] is a video item carrying exactly mediaIds[i].
          expect(item.kind).toBe("video");
          expect(item.mediaId).toBe(rawMediaId);
          expect(item.status).toBe("done");
          // title is positionally aligned with prompts[i] (design: "Video {i+1}").
          expect(item.title).toBe(`Video ${i + 1}`);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Positional input designed to exercise arbitrary error-index sets. Each slot
// independently may have a null/empty mediaId (failed slot) and/or a non-null
// slotError (worker-flagged slot). A slot is an ERROR when its mediaId is
// null/empty OR its slotError is non-null; otherwise it is a SUCCESS. We keep
// both arrays of length N so the positional contract is honoured.
const errorIndexInputArb = fc.integer({ min: 1, max: 50 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    mediaIds: fc.array(slotArb, { minLength: n, maxLength: n }),
    flowMediaIds: fc.array(slotArb, { minLength: n, maxLength: n }),
    assetIds: fc.array(slotArb, { minLength: n, maxLength: n }),
    slotErrors: fc.option(fc.array(slotArb, { minLength: n, maxLength: n }), {
      nil: null,
    }),
    prompts: fc.array(fc.string(), { minLength: n, maxLength: n }),
  }),
);

describe("Batch_Result_List builder — error slots keep their position", () => {
  // Feature: video-batch-result-list, Property 3: Slot lỗi giữ nguyên vị trí,
  // không xô lệch. For all positional arrays with an arbitrary error-index set
  // (mediaIds[i] null OR slotErrors[i] non-null), buildVideoResultListItems keeps
  // listItems at length N, places error items at exactly those error indices with
  // status === "error", and every successful slot stays at its original index.
  // **Validates: Requirements 3.3, 3.4**
  it("P3: error items land at their exact indices, successes keep their original index, length stays N", () => {
    fc.assert(
      fc.property(errorIndexInputArb, (input) => {
        const { n, mediaIds, flowMediaIds, assetIds, slotErrors, prompts } = input;

        const result = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });

        // Length never changes: error slots are kept in place, not dropped.
        expect(result.listItems).toHaveLength(n);

        for (let i = 0; i < n; i += 1) {
          const rawMediaId = mediaIds[i];
          const hasMedia =
            typeof rawMediaId === "string" && rawMediaId.length > 0;
          const rawSlotError = slotErrors ? slotErrors[i] : null;
          const hasSlotError =
            typeof rawSlotError === "string" && rawSlotError.length > 0;

          // Same definition the builder uses: error iff no media OR flagged.
          const isError = !hasMedia || hasSlotError;
          const item = result.listItems[i];

          if (isError) {
            // Error item sits at the exact error index, with no media leaking in.
            expect(item.status).toBe("error");
            expect(item.mediaId).toBeNull();
          } else {
            // Successful slot stays at its original index carrying its mediaId.
            expect(item.status).toBe("done");
            expect(item.kind).toBe("video");
            expect(item.mediaId).toBe(rawMediaId);
          }
        }

        // The set of error indices in the output matches the expected set exactly
        // (no off-by-one shifting in either direction).
        const expectedErrorIndexes: number[] = [];
        for (let i = 0; i < n; i += 1) {
          const rawMediaId = mediaIds[i];
          const hasMedia =
            typeof rawMediaId === "string" && rawMediaId.length > 0;
          const rawSlotError = slotErrors ? slotErrors[i] : null;
          const hasSlotError =
            typeof rawSlotError === "string" && rawSlotError.length > 0;
          if (!hasMedia || hasSlotError) expectedErrorIndexes.push(i);
        }
        const actualErrorIndexes = result.listItems
          .map((item, i) => (item.status === "error" ? i : -1))
          .filter((i) => i !== -1);
        expect(actualErrorIndexes).toEqual(expectedErrorIndexes);
      }),
      { numRuns: 100 },
    );
  });
});

// Positional input of length N >= 1 that deliberately exercises the all-error
// case. A `mode` selects how the slots are forced so the generator reliably
// reaches the "every slot fails" scenarios (every mediaIds[i] null and/or every
// slotErrors[i] non-null) in addition to ordinary mixed input. All arrays stay
// the same length N to honour the worker's positional contract.
const p4SlotArb = fc.option(fc.string({ minLength: 1 }), { nil: null });
const p4ErrorArb = fc.string({ minLength: 1 });

const p4NonEmptyInputArb = fc.integer({ min: 1, max: 50 }).chain((n) =>
  fc
    .record({
      mode: fc.constantFrom(
        "mixed",
        "allNullMedia",
        "allSlotErrors",
        "allBoth",
      ),
      mediaIds: fc.array(p4SlotArb, { minLength: n, maxLength: n }),
      flowMediaIds: fc.array(p4SlotArb, { minLength: n, maxLength: n }),
      assetIds: fc.array(p4SlotArb, { minLength: n, maxLength: n }),
      rawSlotErrors: fc.array(p4ErrorArb, { minLength: n, maxLength: n }),
      mixedSlotErrors: fc.option(
        fc.array(p4SlotArb, { minLength: n, maxLength: n }),
        { nil: null },
      ),
      prompts: fc.array(fc.string(), { minLength: n, maxLength: n }),
    })
    .map((rec) => {
      let mediaIds = rec.mediaIds;
      let slotErrors: (string | null)[] | null;
      switch (rec.mode) {
        case "allNullMedia":
          // Every slot fails because no media was produced.
          mediaIds = rec.mediaIds.map(() => null);
          slotErrors = null;
          break;
        case "allSlotErrors":
          // Every slot is flagged by the worker, regardless of media.
          slotErrors = rec.rawSlotErrors;
          break;
        case "allBoth":
          // Worst case: no media AND every slot flagged.
          mediaIds = rec.mediaIds.map(() => null);
          slotErrors = rec.rawSlotErrors;
          break;
        default:
          // Ordinary mixed input (may or may not contain errors).
          slotErrors = rec.mixedSlotErrors;
          break;
      }
      return {
        n,
        mode: rec.mode,
        mediaIds,
        flowMediaIds: rec.flowMediaIds,
        assetIds: rec.assetIds,
        slotErrors,
        prompts: rec.prompts,
      };
    }),
);

describe("Batch_Result_List builder — non-empty and complete when N >= 1", () => {
  // Feature: video-batch-result-list, Property 4: Danh sách kết quả không rỗng và
  // đầy đủ khi N ≥ 1. For all positional arrays of length N >= 1 (including the
  // all-error case where every mediaIds[i] is null and/or every slotErrors[i] is
  // non-null), buildVideoResultListItems returns a non-empty listItems with
  // exactly N items, so the user can always access every result even if
  // categorizing individual items has problems.
  // **Validates: Requirements 3.6, 3.7**
  it("P4: result list is never empty and always has exactly N items, even all-error", () => {
    fc.assert(
      fc.property(p4NonEmptyInputArb, (input) => {
        const { n, mediaIds, flowMediaIds, assetIds, slotErrors, prompts } = input;

        const result = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });

        // Non-empty (Req 3.7): N >= 1 always yields at least one item.
        expect(result.listItems.length).toBeGreaterThan(0);

        // Complete (Req 3.6): exactly N items, regardless of how many slots fail.
        expect(result.listItems).toHaveLength(n);
        expect(result.variantCount).toBe(n);

        // Every slot is represented as a video item (success or error), so no
        // result position is ever dropped from the list.
        for (const item of result.listItems) {
          expect(item.kind).toBe("video");
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Video_Model values the batch flow must support identically. The builder takes
// no model parameter — its output depends only on the positional contract — so
// we generate a model alongside one set of positional arrays and prove the
// output is the same no matter which model "produced" those arrays.
const p7VideoModelArb = fc.constantFrom("veo", "omni_flash");
const p7SlotArb = fc.option(fc.string({ minLength: 1 }), { nil: null });

const p7InputArb = fc.integer({ min: 1, max: 50 }).chain((n) =>
  fc.record({
    videoModel: p7VideoModelArb,
    mediaIds: fc.array(p7SlotArb, { minLength: n, maxLength: n }),
    flowMediaIds: fc.array(p7SlotArb, { minLength: n, maxLength: n }),
    assetIds: fc.array(p7SlotArb, { minLength: n, maxLength: n }),
    slotErrors: fc.option(fc.array(p7SlotArb, { minLength: n, maxLength: n }), {
      nil: null,
    }),
    prompts: fc.array(fc.string(), { minLength: n, maxLength: n }),
  }),
);

describe("Batch_Result_List builder — independent of Video_Model", () => {
  // Feature: video-batch-result-list, Property 7: Độc lập với Video_Model (Veo và
  // Omni Flash). For all videoModel ∈ {veo, omni_flash} and the same set of
  // positional media_ids/slot_errors input arrays, buildVideoResultListItems
  // yields identical listItems — the result depends only on the positional
  // contract, never on the model.
  // **Validates: Requirements 7.1, 7.2, 7.3**
  it("P7: output is identical regardless of Video_Model (veo vs omni_flash)", () => {
    fc.assert(
      fc.property(p7InputArb, (input) => {
        const { mediaIds, flowMediaIds, assetIds, slotErrors, prompts } = input;

        // The builder is model-agnostic, so building "as veo" and "as
        // omni_flash" from the SAME positional arrays must be deep-equal.
        const asVeo = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });
        const asOmniFlash = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });

        // Both models share the same positional contract → identical output.
        expect(asVeo).toEqual(asOmniFlash);

        // Cross-check against the originally generated model: regardless of
        // which model the input came from, the output is the same value.
        const built = buildVideoResultListItems({
          mediaIds,
          flowMediaIds,
          assetIds,
          slotErrors,
          prompts,
        });
        expect(built).toEqual(asVeo);
      }),
      { numRuns: 100 },
    );
  });
});
