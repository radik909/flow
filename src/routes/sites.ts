import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { db } from "../db/client.js";
import { sites } from "../db/schema.js";
import { requireConfigAuth } from "../plugins/config-auth.js";

interface CreateSiteBody {
  name: string;
}

/** Config API: register a customer site and mint its public key (DESIGN.md §5). */
export function registerSiteRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateSiteBody }>(
    "/sites",
    { preHandler: requireConfigAuth },
    async (request, reply) => {
      const { name } = request.body ?? {};
      if (!name) return reply.code(400).send({ error: "name is required" });

      const key = randomBytes(16).toString("hex");
      await db.insert(sites).values({ key, name });

      return reply.code(201).send({ key, name });
    },
  );
}
