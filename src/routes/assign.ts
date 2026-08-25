import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { bucketFor, pickVariant } from "../lib/bucket.js";
import { configCache } from "../lib/config-cache.js";

interface AssignQuery {
  visitorId?: string;
  siteKey?: string;
  experiments?: string; // comma-separated experiment ids; omit for "all active on this site"
}

/**
 * The hot path (DESIGN.md §1, §2, §4). No DB read, no LLM call, no required
 * downstream dependency — a pure function over whatever's currently in the in-memory
 * config cache. Never throws for reasons a customer's page should see: unknown site,
 * unknown experiment, or a stale/cold cache all resolve to "no experiments" rather
 * than an error, so the snippet always gets a 200 and can render a default.
 */
export function registerAssignRoute(app: FastifyInstance): void {
  app.get<{ Querystring: AssignQuery }>("/assign", async (request, reply) => {
    const { visitorId, siteKey } = request.query;

    if (!visitorId || !siteKey) {
      // Missing required params is a caller bug, not a downstream failure — still
      // fail open with an empty result rather than a 4xx, since a broken snippet
      // integration should degrade to "no experiments," never a page error.
      return reply.send({ visitorId: visitorId ?? null, experiments: {}, stale: false });
    }

    const stale = configCache.isStale(config.configMaxStaleMs);
    const requestedIds = request.query.experiments
      ? new Set(request.query.experiments.split(",").map((s) => s.trim()).filter(Boolean))
      : null;

    const active = configCache
      .getExperiments(siteKey)
      .filter((exp) => !requestedIds || requestedIds.has(exp.id));

    const result: Record<string, { variantId: string; isControl: boolean; content: unknown }> = {};

    for (const exp of active) {
      const bucket = bucketFor(visitorId, exp.id, exp.salt);
      const variantId = pickVariant(
        bucket,
        exp.variants.map((v) => ({ variantId: v.id, rangeStart: v.rangeStart, rangeEnd: v.rangeEnd })),
      );

      // No range covered this bucket (a config bug) or no variants at all — fall back
      // to whichever variant is marked control, if any; otherwise skip the experiment
      // entirely rather than guess. Either way, never throw (DESIGN.md §4).
      const resolved = exp.variants.find((v) => v.id === variantId) ?? exp.variants.find((v) => v.isControl);
      if (!resolved) continue;

      result[exp.id] = { variantId: resolved.id, isControl: resolved.isControl, content: resolved.content };
    }

    return reply.send({ visitorId, experiments: result, stale });
  });
}
