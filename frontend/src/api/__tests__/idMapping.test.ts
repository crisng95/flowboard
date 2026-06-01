// @vitest-environment jsdom
//
// Unit + property tests for the UUID <-> numeric id mapping adapter in
// client.ts (Phase 1, item 1.3). jsdom gives us a real localStorage so the
// persistence path is exercised too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("../../cloud/supabase", () => ({
  supabase: null,
  cloudApiBaseUrl: "http://localhost",
  hasSupabaseConfig: false,
}));

import {
  uuidToNumericId,
  resolveToUuid,
  registerIdMapping,
  getUuidFromNumericId,
} from "../client";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A UUID-shaped string (contains dashes so resolveToUuid treats it as a UUID).
const uuidArb = fc
  .tuple(
    fc.hexaString({ minLength: 8, maxLength: 8 }),
    fc.hexaString({ minLength: 4, maxLength: 4 }),
    fc.hexaString({ minLength: 4, maxLength: 4 }),
    fc.hexaString({ minLength: 4, maxLength: 4 }),
    fc.hexaString({ minLength: 12, maxLength: 12 }),
  )
  .map((parts) => parts.join("-"));

describe("id mapping adapter — round-trip", () => {
  it("uuidToNumericId then resolveToUuid returns the original UUID", () => {
    const uuid = "788ab31d-ebff-4913-81d9-f8274160c263";
    const num = uuidToNumericId(uuid);
    expect(typeof num).toBe("number");
    expect(resolveToUuid(num)).toBe(uuid);
    // Numeric-string form resolves identically.
    expect(resolveToUuid(String(num))).toBe(uuid);
  });

  it("is stable: the same UUID always maps to the same number", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(uuidToNumericId(uuid)).toBe(uuidToNumericId(uuid));
  });

  // Property: for any set of distinct UUIDs, the assigned numeric ids are
  // unique (no silent collision/overwrite) and every one round-trips back.
  it("P: distinct UUIDs get distinct numbers and all round-trip", () => {
    fc.assert(
      fc.property(fc.uniqueArray(uuidArb, { minLength: 1, maxLength: 60 }), (uuids) => {
        localStorage.clear();
        // NOTE: maps are module-level; clearing localStorage doesn't reset the
        // in-memory maps, so derive uniqueness within this single assignment
        // batch by using fresh UUIDs each run (fast-check varies them).
        const nums = uuids.map((u) => uuidToNumericId(u));
        // Each UUID round-trips to itself.
        uuids.forEach((u, i) => {
          expect(resolveToUuid(nums[i])).toBe(u);
        });
        // No two DISTINCT uuids in this batch share a number.
        const seen = new Map<number, string>();
        uuids.forEach((u, i) => {
          const n = nums[i];
          const prev = seen.get(n);
          expect(prev === undefined || prev === u).toBe(true);
          seen.set(n, u);
        });
      }),
      { numRuns: 100 },
    );
  });
});

describe("id mapping adapter — collision handling", () => {
  it("two UUIDs sharing a 12-hex prefix get different numbers (no overwrite)", () => {
    // Same first 12 hex chars ("aaaaaaaabbbb"), different tail.
    const a = "aaaaaaaa-bbbb-0000-0000-000000000001";
    const b = "aaaaaaaa-bbbb-0000-0000-000000000002";
    const na = uuidToNumericId(a);
    const nb = uuidToNumericId(b);
    expect(na).not.toBe(nb);
    // Both still resolve back to their own UUID.
    expect(resolveToUuid(na)).toBe(a);
    expect(resolveToUuid(nb)).toBe(b);
  });
});

describe("id mapping adapter — missing mapping throws", () => {
  it("resolveToUuid throws for an unknown numeric id instead of faking a UUID", () => {
    expect(() => resolveToUuid(999999999999)).toThrow(/no UUID mapping/i);
    expect(() => resolveToUuid("888888888888")).toThrow(/no UUID mapping/i);
  });

  it("passes through an already-UUID string unchanged", () => {
    const uuid = "deadbeef-0000-1111-2222-333344445555";
    expect(resolveToUuid(uuid)).toBe(uuid);
  });
});

describe("id mapping adapter — persistence", () => {
  it("registerIdMapping is retrievable via getUuidFromNumericId", () => {
    registerIdMapping(424242, "cafebabe-0000-0000-0000-000000000000");
    expect(getUuidFromNumericId(424242)).toBe("cafebabe-0000-0000-0000-000000000000");
  });
});
