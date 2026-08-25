import assert from "node:assert/strict";
import test from "node:test";
import { BUCKET_SPACE } from "../constants.js";
import { bucketFor, pickVariant } from "./bucket.js";
import { srmCheck } from "./stats.js";

test("bucketFor is deterministic: same inputs always produce the same bucket", () => {
  const first = bucketFor("visitor-1", "exp-a", "salt-a");
  for (let i = 0; i < 50; i++) {
    assert.equal(bucketFor("visitor-1", "exp-a", "salt-a"), first);
  }
});

test("bucketFor stays within [0, BUCKET_SPACE)", () => {
  for (let i = 0; i < 5000; i++) {
    const bucket = bucketFor(`visitor-${i}`, "exp-a", "salt-a");
    assert.ok(bucket >= 0 && bucket < BUCKET_SPACE, `bucket ${bucket} out of range`);
  }
});

test("bucketFor changes with experiment id (salt independence across experiments)", () => {
  // Not a proof of independence, but catches the obvious bug: forgetting to mix the
  // experiment id/salt into the hash at all, which would make every experiment
  // perfectly correlated with every other for the same visitor.
  const visitor = "visitor-1";
  const bucketExpA = bucketFor(visitor, "exp-a", "exp-a");
  const bucketExpB = bucketFor(visitor, "exp-b", "exp-b");
  assert.notEqual(bucketExpA, bucketExpB);
});

test("bucketFor changes with salt for the same visitor+experiment (version bump works)", () => {
  const b1 = bucketFor("visitor-1", "exp-a", "salt-v1");
  const b2 = bucketFor("visitor-1", "exp-a", "salt-v2");
  assert.notEqual(b1, b2);
});

test("pickVariant resolves inclusive range boundaries correctly", () => {
  const ranges = [
    { variantId: "control", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "b", rangeStart: 5000, rangeEnd: 9999 },
  ];
  assert.equal(pickVariant(0, ranges), "control");
  assert.equal(pickVariant(4999, ranges), "control");
  assert.equal(pickVariant(5000, ranges), "b");
  assert.equal(pickVariant(9999, ranges), "b");
});

test("pickVariant returns null when no range covers the bucket (fail-open signal)", () => {
  const ranges = [{ variantId: "control", rangeStart: 0, rangeEnd: 4999 }]; // gap above 4999
  assert.equal(pickVariant(5000, ranges), null);
});

test("distribution is statistically uniform across 10,000 synthetic visitors (SRM check)", () => {
  const N = 10_000;
  const ranges = [
    { variantId: "control", rangeStart: 0, rangeEnd: 4999 },
    { variantId: "b", rangeStart: 5000, rangeEnd: 9999 },
  ];
  const counts = new Map<string, number>([["control", 0], ["b", 0]]);

  for (let i = 0; i < N; i++) {
    const bucket = bucketFor(`sim-visitor-${i}`, "uniformity-check", "uniformity-check");
    const variantId = pickVariant(bucket, ranges)!;
    counts.set(variantId, (counts.get(variantId) ?? 0) + 1);
  }

  // Reuses the exact SRM check the /results endpoint runs in production
  // (DESIGN.md §6) — the hash's own uniformity is validated with the same test that
  // would catch a biased hash in a live experiment.
  const result = srmCheck([
    { variantId: "control", exposures: counts.get("control")!, expectedShare: 0.5 },
    { variantId: "b", exposures: counts.get("b")!, expectedShare: 0.5 },
  ]);

  assert.ok(
    !result.flagged,
    `hash distribution deviates from the configured 50/50 split beyond chance (p=${result.pValue}, counts=${JSON.stringify(Object.fromEntries(counts))})`,
  );
});

test("uneven allocation (90/10) is honoured at scale", () => {
  const N = 10_000;
  const ranges = [
    { variantId: "control", rangeStart: 0, rangeEnd: 8999 },
    { variantId: "holdback", rangeStart: 9000, rangeEnd: 9999 },
  ];
  const counts = new Map<string, number>([["control", 0], ["holdback", 0]]);

  for (let i = 0; i < N; i++) {
    const bucket = bucketFor(`sim-visitor-${i}`, "uneven-split-check", "uneven-split-check");
    const variantId = pickVariant(bucket, ranges)!;
    counts.set(variantId, (counts.get(variantId) ?? 0) + 1);
  }

  const result = srmCheck([
    { variantId: "control", exposures: counts.get("control")!, expectedShare: 0.9 },
    { variantId: "holdback", exposures: counts.get("holdback")!, expectedShare: 0.1 },
  ]);

  assert.ok(!result.flagged, `90/10 split not honoured (p=${result.pValue}, counts=${JSON.stringify(Object.fromEntries(counts))})`);
});
