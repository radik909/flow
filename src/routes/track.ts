import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { conversions, exposures, rawEvents } from "../db/schema.js";

interface ExposureBody {
  visitorId: string;
  siteKey: string;
  experimentId: string;
  variantId: string;
}

interface ConversionBody {
  visitorId: string;
  siteKey: string;
  experimentId: string;
  goalId: string;
}

/**
 * Tracking endpoints (DESIGN.md §1, §4, §6). Fire-and-forget from the browser, so
 * these return fast and never block on anything beyond a single insert. Idempotency
 * is enforced by the DB's composite primary key via ON CONFLICT DO NOTHING, not by
 * application logic — that's deliberate, so a retried/duplicated batch can't bypass it.
 *
 * What's explicitly not here (DESIGN.md, Out of scope): a bounded in-memory buffer for
 * Postgres-down resilience, and server-side batching. Both are named next steps; this
 * writes directly, and a failed write is simply lost rather than retried.
 */
export function registerTrackRoutes(app: FastifyInstance): void {
  app.post<{ Body: ExposureBody }>("/track/exposure", async (request, reply) => {
    const { visitorId, siteKey, experimentId, variantId } = request.body ?? {};
    if (!visitorId || !siteKey || !experimentId || !variantId) {
      return reply.code(400).send({ error: "visitorId, siteKey, experimentId, variantId are required" });
    }

    try {
      await db.insert(rawEvents).values({
        kind: "exposure",
        visitorId,
        experimentId,
        payload: { siteKey, variantId },
      });
      await db
        .insert(exposures)
        .values({ visitorId, experimentId, variantId, siteKey })
        .onConflictDoNothing();
    } catch (err) {
      // Tracking is fire-and-forget: log and still 200, so a DB hiccup never surfaces
      // as an error to the page (DESIGN.md §4).
      request.log.error({ err }, "exposure write failed");
    }

    return reply.code(202).send({ ok: true });
  });

  app.post<{ Body: ConversionBody }>("/track/conversion", async (request, reply) => {
    const { visitorId, siteKey, experimentId, goalId } = request.body ?? {};
    if (!visitorId || !siteKey || !experimentId || !goalId) {
      return reply.code(400).send({ error: "visitorId, siteKey, experimentId, goalId are required" });
    }

    try {
      await db.insert(rawEvents).values({
        kind: "conversion",
        visitorId,
        experimentId,
        payload: { siteKey, goalId },
      });
      await db
        .insert(conversions)
        .values({ visitorId, experimentId, goalId, siteKey })
        .onConflictDoNothing();
    } catch (err) {
      request.log.error({ err }, "conversion write failed");
    }

    return reply.code(202).send({ ok: true });
  });
}
