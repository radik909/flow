// Simulates N visitors hitting the hashing algorithm directly (no DB, no server, no
// .env required — bucketFor/pickVariant are pure functions, see src/lib/bucket.ts).
// Writes a CSV of every visitor's bucket/variant to reports/, and prints a summary
// including the same SRM check the /results endpoint uses in production.
//
// Usage:
//   npx tsx scripts/simulate-assignments.ts [visitorCount] [controlSharePercent]
//   npx tsx scripts/simulate-assignments.ts 100        # your original ask
//   npx tsx scripts/simulate-assignments.ts 10000 90   # 10k visitors, 90/10 split

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUCKET_SPACE } from "../src/constants.js";
import { bucketFor, pickVariant } from "../src/lib/bucket.js";
import { srmCheck } from "../src/lib/stats.js";

const visitorCount = Number(process.argv[2] ?? 100);
const controlSharePercent = Number(process.argv[3] ?? 50);

const controlEnd = Math.round((BUCKET_SPACE * controlSharePercent) / 100) - 1;
const ranges = [
  { variantId: "control", rangeStart: 0, rangeEnd: controlEnd },
  { variantId: "b", rangeStart: controlEnd + 1, rangeEnd: BUCKET_SPACE - 1 },
];

const experimentId = "simulation";
const salt = "simulation";

const rows: { visitorId: string; bucket: number; variantId: string }[] = [];
const counts = new Map<string, number>([["control", 0], ["b", 0]]);

for (let i = 0; i < visitorCount; i++) {
  const visitorId = `sim-visitor-${i}`;
  const bucket = bucketFor(visitorId, experimentId, salt);
  const variantId = pickVariant(bucket, ranges)!;
  rows.push({ visitorId, bucket, variantId });
  counts.set(variantId, (counts.get(variantId) ?? 0) + 1);
}

// Stickiness spot-check: re-hash the same visitors and confirm nothing changed.
const mismatches = rows.filter((r) => bucketFor(r.visitorId, experimentId, salt) !== r.bucket);

const srm = srmCheck([
  { variantId: "control", exposures: counts.get("control")!, expectedShare: controlSharePercent / 100 },
  { variantId: "b", exposures: counts.get("b")!, expectedShare: (100 - controlSharePercent) / 100 },
]);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "reports");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `assignment-simulation-${visitorCount}.csv`);

const csv = ["visitor_id,bucket,variant_id", ...rows.map((r) => `${r.visitorId},${r.bucket},${r.variantId}`)].join("\n");
writeFileSync(outFile, csv);

console.log(`Simulated ${visitorCount} visitors at a ${controlSharePercent}/${100 - controlSharePercent} split.`);
console.log(`Wrote input/output to: ${outFile}`);
console.log(`Counts:`, Object.fromEntries(counts));
console.log(`Re-hash stickiness check: ${mismatches.length === 0 ? "PASS (all visitors got the same bucket on re-hash)" : `FAIL (${mismatches.length} mismatches)`}`);
console.log(
  `SRM check vs. configured allocation: p=${srm.pValue.toFixed(4)} — ${srm.flagged ? "FLAGGED (distribution deviates beyond chance)" : "OK (no significant deviation)"}`,
);
if (visitorCount < 1000) {
  console.log(
    `Note: at n=${visitorCount}, expected noise around a 50/50 split alone is roughly ±${Math.round(3 * Math.sqrt(visitorCount * 0.25))} visitors (3 std. dev.) — small samples can look "close enough" even if biased. Re-run with a larger count (e.g. 10000) for a statistically meaningful check.`,
  );
}
