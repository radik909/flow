import type { BucketRange } from "./bucket.js";
import { BUCKET_SPACE } from "../constants.js";

export class AllocationError extends Error {}

/**
 * Validates a full new allocation (proposed) against the currently-live one, enforcing
 * the invariant from DESIGN.md §2: at most ONE shared boundary between two adjacent
 * variants may move per call, and no variant may be added or removed. This is
 * deliberately stricter than "each range overlaps its old self" — that weaker check
 * would still permit multiple boundaries moving at once, which is a full reshuffle in
 * disguise (verified against the 2→3 variant example in DESIGN.md §2: naive overlap
 * checks pass it, this does not, because it changes two boundaries simultaneously).
 *
 * `current.length === 0` is the creation path: any valid partition is accepted, since
 * there's no prior stickiness to protect yet. Adding or removing a variant on a live
 * experiment is out of scope for this function — that's a new experiment (new salt),
 * per DESIGN.md §2, not a hot-swappable change.
 */
export function assertSafeReallocation(current: BucketRange[], proposed: BucketRange[]): void {
  assertCovers(proposed);
  assertNonOverlapping(proposed);

  if (current.length === 0) return;

  const currentById = new Map(current.map((r) => [r.variantId, r]));
  const proposedById = new Map(proposed.map((r) => [r.variantId, r]));

  for (const id of currentById.keys()) {
    if (!proposedById.has(id)) {
      throw new AllocationError(
        `variant "${id}" is missing from the new allocation — removing a live variant is not a hot-swappable change, create a new experiment (new salt) instead`,
      );
    }
  }
  for (const id of proposedById.keys()) {
    if (!currentById.has(id)) {
      throw new AllocationError(
        `variant "${id}" doesn't exist yet — adding a variant to a live experiment isn't a resize, create a new experiment (new salt) instead`,
      );
    }
  }

  const currentOrder = [...current].sort((a, b) => a.rangeStart - b.rangeStart).map((r) => r.variantId);
  const proposedOrder = [...proposed].sort((a, b) => a.rangeStart - b.rangeStart).map((r) => r.variantId);
  if (currentOrder.join(",") !== proposedOrder.join(",")) {
    throw new AllocationError(
      "the relative order of variants across the bucket space changed — that's a full reshuffle, not a boundary move; create a new experiment (new salt) instead",
    );
  }

  // Internal boundaries are the shared edges between consecutive variants in sorted
  // order (rangeEnd of one == rangeStart - 1 of the next, since ranges are contiguous
  // and cover the full space). Counting how many of these moved is what actually
  // catches "did two boundaries shift in the same call," which a per-variant overlap
  // check cannot.
  let movedBoundaries = 0;
  for (let i = 0; i < currentOrder.length - 1; i++) {
    const currentBoundary = currentById.get(currentOrder[i])!.rangeEnd;
    const proposedBoundary = proposedById.get(proposedOrder[i])!.rangeEnd;
    if (currentBoundary !== proposedBoundary) movedBoundaries++;
  }

  if (movedBoundaries > 1) {
    throw new AllocationError(
      `this change moves ${movedBoundaries} boundaries at once — only one adjacent pair's shared boundary may move per update, so that only visitors near that single boundary are reassigned; create a new experiment (new salt) for a full re-partition`,
    );
  }
}

function assertCovers(ranges: BucketRange[]): void {
  const sorted = [...ranges].sort((a, b) => a.rangeStart - b.rangeStart);
  let cursor = 0;
  for (const r of sorted) {
    if (r.rangeStart !== cursor) {
      throw new AllocationError(
        `allocation has a gap or misalignment at bucket ${cursor} (variant "${r.variantId}" starts at ${r.rangeStart}) — ranges must fully cover [0, ${BUCKET_SPACE - 1}] with no gaps`,
      );
    }
    cursor = r.rangeEnd + 1;
  }
  if (cursor !== BUCKET_SPACE) {
    throw new AllocationError(`allocation ends at bucket ${cursor - 1}, must cover through ${BUCKET_SPACE - 1}`);
  }
}

function assertNonOverlapping(ranges: BucketRange[]): void {
  const sorted = [...ranges].sort((a, b) => a.rangeStart - b.rangeStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].rangeStart <= sorted[i - 1].rangeEnd) {
      throw new AllocationError(
        `variants "${sorted[i - 1].variantId}" and "${sorted[i].variantId}" overlap`,
      );
    }
  }
}
