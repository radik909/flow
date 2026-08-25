import assert from "node:assert/strict";
import test from "node:test";
import { AllocationError, assertSafeReallocation } from "./allocation.js";

test("accepts any valid partition on creation (no prior allocation)", () => {
  assert.doesNotThrow(() =>
    assertSafeReallocation(
      [],
      [
        { variantId: "a", rangeStart: 0, rangeEnd: 3332 },
        { variantId: "b", rangeStart: 3333, rangeEnd: 6665 },
        { variantId: "c", rangeStart: 6666, rangeEnd: 9999 },
      ],
    ),
  );
});

test("rejects a proposed allocation with a gap", () => {
  assert.throws(
    () =>
      assertSafeReallocation(
        [],
        [
          { variantId: "a", rangeStart: 0, rangeEnd: 4000 },
          { variantId: "b", rangeStart: 5000, rangeEnd: 9999 }, // gap: 4001-4999
        ],
      ),
    AllocationError,
  );
});

test("accepts a single-boundary ramp between two adjacent variants", () => {
  const current = [
    { variantId: "control", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "b", rangeStart: 5000, rangeEnd: 9999 },
  ];
  const proposed = [
    { variantId: "control", rangeStart: 0, rangeEnd: 1999 }, // ramping b up from 50% to 80%
    { variantId: "b", rangeStart: 2000, rangeEnd: 9999 },
  ];
  assert.doesNotThrow(() => assertSafeReallocation(current, proposed));
});

test("rejects renumbering into a new variant count (the 2-to-3 reshuffle case)", () => {
  // Regression test: an earlier version of this check only verified each variant's
  // new range overlapped its old range, which incorrectly PASSED this exact case.
  const current = [
    { variantId: "control", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "b", rangeStart: 5000, rangeEnd: 9999 },
  ];
  const proposed = [
    { variantId: "control", rangeStart: 0, rangeEnd: 3332 },
    { variantId: "b", rangeStart: 3333, rangeEnd: 6665 },
    { variantId: "c", rangeStart: 6666, rangeEnd: 9999 }, // new variant, not a resize
  ];
  assert.throws(() => assertSafeReallocation(current, proposed), AllocationError);
});

test("rejects moving two boundaries in the same call", () => {
  const current = [
    { variantId: "a", rangeStart: 0, rangeEnd: 3332 },
    { variantId: "b", rangeStart: 3333, rangeEnd: 6665 },
    { variantId: "c", rangeStart: 6666, rangeEnd: 9999 },
  ];
  const proposed = [
    { variantId: "a", rangeStart: 0, rangeEnd: 1999 }, // a/b boundary moved
    { variantId: "b", rangeStart: 2000, rangeEnd: 7999 }, // b/c boundary also moved
    { variantId: "c", rangeStart: 8000, rangeEnd: 9999 },
  ];
  assert.throws(() => assertSafeReallocation(current, proposed), AllocationError);
});

test("rejects removing a live variant", () => {
  const current = [
    { variantId: "control", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "b", rangeStart: 5000, rangeEnd: 9999 },
  ];
  const proposed = [{ variantId: "control", rangeStart: 0, rangeEnd: 9999 }];
  assert.throws(() => assertSafeReallocation(current, proposed), AllocationError);
});

test("rejects reordering variants across the bucket space", () => {
  const current = [
    { variantId: "a", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "b", rangeStart: 5000, rangeEnd: 9999 },
  ];
  const proposed = [
    { variantId: "b", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "a", rangeStart: 5000, rangeEnd: 9999 },
  ];
  assert.throws(() => assertSafeReallocation(current, proposed), AllocationError);
});
