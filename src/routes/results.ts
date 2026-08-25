import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { experiments, variants } from "../db/schema.js";
import { BUCKET_SPACE, MIN_SAMPLE_SIZE, SIGNIFICANCE_THRESHOLD } from "../constants.js";
import { srmCheck, twoProportionZTest } from "../lib/stats.js";

/**
 * Results endpoint (DESIGN.md §3, §6): per-variant exposures/conversions/rate, a
 * significance indicator against control, a minimum-sample-size warning, and the SRM
 * integrity check. Plain aggregate query over the deduped tables — no rollup table.
 * DESIGN.md §3 names the rollup as the step to take once the event table is large;
 * not built preemptively here.
 */
export function registerResultsRoute(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/results/:id", async (request, reply) => {
    const experimentId = request.params.id;

    const [experiment] = await db.select().from(experiments).where(eq(experiments.id, experimentId));
    if (!experiment) return reply.code(404).send({ error: "experiment not found" });

    const variantRows = await db.select().from(variants).where(eq(variants.experimentId, experimentId));

    const exposureCounts = await db.execute<{ variant_id: string; count: string }>(sql`
      select variant_id, count(*) as count
      from exposures
      where experiment_id = ${experimentId}
      group by variant_id
    `);

    // Conversion rate's numerator is intentionally scoped to visitors who also have a
    // matching exposure row (DESIGN.md §6, "orphaned conversions") — a conversion event
    // for a visitor with no recorded exposure is real but excluded from the rate.
    const conversionCounts = await db.execute<{ variant_id: string; count: string }>(sql`
      select e.variant_id, count(distinct c.visitor_id) as count
      from conversions c
      join exposures e on e.visitor_id = c.visitor_id and e.experiment_id = c.experiment_id
      where c.experiment_id = ${experimentId}
      group by e.variant_id
    `);

    const exposureByVariant = new Map(exposureCounts.rows.map((r) => [r.variant_id, Number(r.count)]));
    const conversionByVariant = new Map(conversionCounts.rows.map((r) => [r.variant_id, Number(r.count)]));

    const control = variantRows.find((v) => v.isControl);
    const controlExposures = control ? exposureByVariant.get(control.id) ?? 0 : 0;
    const controlConversions = control ? conversionByVariant.get(control.id) ?? 0 : 0;

    const perVariant = variantRows.map((v) => {
      const exposuresCount = exposureByVariant.get(v.id) ?? 0;
      const conversionsCount = conversionByVariant.get(v.id) ?? 0;
      const rate = exposuresCount > 0 ? conversionsCount / exposuresCount : null;

      const belowMinSample = exposuresCount < MIN_SAMPLE_SIZE;
      const zTest =
        !v.isControl && control
          ? twoProportionZTest(controlConversions, controlExposures, conversionsCount, exposuresCount)
          : null;

      return {
        variantId: v.id,
        name: v.name,
        isControl: v.isControl,
        exposures: exposuresCount,
        conversions: conversionsCount,
        conversionRate: rate,
        belowMinSampleSize: belowMinSample,
        vsControl: zTest ? { z: zTest.z, pValue: zTest.pValue, significant: zTest.pValue < SIGNIFICANCE_THRESHOLD } : null,
      };
    });

    const multipleComparisonsWarning =
      perVariant.filter((v) => !v.isControl).length > 1
        ? "More than one variant is being compared to control — reported p-values are not corrected for multiple comparisons (DESIGN.md §6)."
        : null;

    const srm = srmCheck(
      variantRows.map((v) => ({
        variantId: v.id,
        exposures: exposureByVariant.get(v.id) ?? 0,
        expectedShare: (v.rangeEnd - v.rangeStart + 1) / BUCKET_SPACE,
      })),
    );

    return reply.send({
      experimentId,
      name: experiment.name,
      variants: perVariant,
      srm: { ...srm, note: "p < 0.001 flags a mismatch between observed traffic and configured allocation — treat results from a flagged experiment as untrustworthy regardless of significance (DESIGN.md §6)." },
      multipleComparisonsWarning,
    });
  });
}
