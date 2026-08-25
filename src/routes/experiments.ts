import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { experiments, variants } from "../db/schema.js";
import { requireConfigAuth } from "../plugins/config-auth.js";
import { AllocationError, assertSafeReallocation } from "../lib/allocation.js";
import { LlmGenerationError, generateVariantContent } from "../lib/llm.js";

interface VariantInput {
  id: string;
  name: string;
  rangeStart: number;
  rangeEnd: number;
  isControl?: boolean;
  content?: unknown;
  generate?: { prompt: string }; // if present, content is produced by the LLM instead
}

interface CreateExperimentBody {
  id: string;
  siteKey: string;
  name: string;
  salt?: string;
  variants: VariantInput[];
}

interface UpdateAllocationBody {
  variants: { id: string; rangeStart: number; rangeEnd: number }[];
}

/**
 * Config API: create/update experiments (DESIGN.md §5, §7). Never called from the
 * browser snippet, always bearer-authed, rate-limiting is a named next step (§5).
 */
export function registerExperimentRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateExperimentBody }>(
    "/experiments",
    { preHandler: requireConfigAuth },
    async (request, reply) => {
      const body = request.body ?? ({} as CreateExperimentBody);
      if (!body.id || !body.siteKey || !body.name || !body.variants?.length) {
        return reply.code(400).send({ error: "id, siteKey, name, and at least one variant are required" });
      }

      try {
        assertSafeReallocation(
          [],
          body.variants.map((v) => ({ variantId: v.id, rangeStart: v.rangeStart, rangeEnd: v.rangeEnd })),
        );
      } catch (err) {
        if (err instanceof AllocationError) return reply.code(422).send({ error: err.message });
        throw err;
      }

      // Resolve LLM-generated content up front, before writing anything. Blocking, per
      // DESIGN.md §7: this is an admin request, not a page render. If generation fails,
      // the whole create fails rather than going live with broken variant content.
      const resolvedVariants: (VariantInput & { content: unknown })[] = [];
      for (const v of body.variants) {
        if (v.generate) {
          try {
            const text = await generateVariantContent(v.generate.prompt);
            resolvedVariants.push({ ...v, content: { text, source: "llm", prompt: v.generate.prompt } });
          } catch (err) {
            if (err instanceof LlmGenerationError) {
              return reply.code(502).send({
                error: `variant "${v.id}" generation failed: ${err.message}`,
                hint: "retry the request, or supply `content` directly instead of `generate` for this variant",
              });
            }
            throw err;
          }
        } else if (v.content !== undefined) {
          resolvedVariants.push({ ...v, content: v.content });
        } else {
          return reply.code(400).send({ error: `variant "${v.id}" needs either content or generate` });
        }
      }

      const salt = body.salt ?? body.id;

      await db.transaction(async (tx) => {
        await tx.insert(experiments).values({ id: body.id, siteKey: body.siteKey, name: body.name, salt });
        await tx.insert(variants).values(
          resolvedVariants.map((v) => ({
            id: v.id,
            experimentId: body.id,
            name: v.name,
            rangeStart: v.rangeStart,
            rangeEnd: v.rangeEnd,
            isControl: v.isControl ?? false,
            content: v.content,
          })),
        );
      });

      return reply.code(201).send({ id: body.id, salt, variants: resolvedVariants.map((v) => v.id) });
    },
  );

  // Edge-resize-only allocation change (DESIGN.md §2). Anything that would renumber an
  // existing variant's range is rejected — the operator must create a new experiment
  // (new salt) instead, which is a clean version bump rather than a silent reshuffle.
  app.patch<{ Params: { id: string }; Body: UpdateAllocationBody }>(
    "/experiments/:id/allocation",
    { preHandler: requireConfigAuth },
    async (request, reply) => {
      const { id } = request.params;
      const proposed = request.body?.variants ?? [];

      const currentRows = await db.select().from(variants).where(eq(variants.experimentId, id));
      if (currentRows.length === 0) return reply.code(404).send({ error: "experiment not found" });

      try {
        assertSafeReallocation(
          currentRows.map((v) => ({ variantId: v.id, rangeStart: v.rangeStart, rangeEnd: v.rangeEnd })),
          proposed.map((v) => ({ variantId: v.id, rangeStart: v.rangeStart, rangeEnd: v.rangeEnd })),
        );
      } catch (err) {
        if (err instanceof AllocationError) return reply.code(422).send({ error: err.message });
        throw err;
      }

      await db.transaction(async (tx) => {
        for (const v of proposed) {
          const existing = currentRows.find((c) => c.id === v.id);
          if (existing) {
            await tx
              .update(variants)
              .set({ rangeStart: v.rangeStart, rangeEnd: v.rangeEnd })
              .where(and(eq(variants.experimentId, id), eq(variants.id, v.id)));
          }
          // New variants (present in proposed, absent from currentRows) need full
          // content/name via a separate "add variant" call — this endpoint only
          // resizes ranges for variants that already exist, to keep the one operation
          // doing one thing.
        }
      });

      return reply.send({ id, updated: proposed.map((v) => v.id) });
    },
  );

  app.get("/experiments", { preHandler: requireConfigAuth }, async (request, reply) => {
    const rows = await db.select().from(experiments);
    return reply.send(rows);
  });
}
