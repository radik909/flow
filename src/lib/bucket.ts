import { createHash } from "node:crypto";
import { BUCKET_SPACE } from "../constants.js";

export interface BucketRange {
  variantId: string;
  rangeStart: number;
  rangeEnd: number;
}

/**
 * Deterministic, uniform bucket for a (visitor, experiment) pair. Same inputs always
 * produce the same output — no state, no I/O, no DB. This is what makes assignment
 * fast and restart-proof (DESIGN.md §1, §2).
 */
export function bucketFor(visitorId: string, experimentId: string, salt: string): number {
  const digest = createHash("sha256").update(`${visitorId}:${experimentId}:${salt}`).digest();
  return digest.readUInt32BE(0) % BUCKET_SPACE;
}

/**
 * Resolve a bucket to the variant whose range contains it. Ranges are expected to be
 * non-overlapping and to fully cover [0, BUCKET_SPACE); if they don't (a config bug),
 * this returns null and the caller falls back to control per the fail-open principle
 * in DESIGN.md §4 — it must never throw on the assignment path.
 */
export function pickVariant(bucket: number, ranges: BucketRange[]): string | null {
  for (const r of ranges) {
    if (bucket >= r.rangeStart && bucket <= r.rangeEnd) return r.variantId;
  }
  return null;
}
