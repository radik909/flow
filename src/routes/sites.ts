import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
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

  // Includes each site's experiment count — the main thing an admin actually wants to
  // know at a glance (is this site set up, or a stray key nothing points at yet).
  app.get("/sites", { preHandler: requireConfigAuth }, async (request, reply) => {
    const rows = await db.execute<{
      key: string;
      name: string;
      created_at: string;
      experiment_count: string;
    }>(sql`
      select s.key, s.name, s.created_at, count(e.id) as experiment_count
      from sites s
      left join experiments e on e.site_key = s.key
      group by s.key, s.name, s.created_at
      order by s.created_at desc
    `);

    return reply.send(
      rows.rows.map((r) => ({
        key: r.key,
        name: r.name,
        createdAt: r.created_at,
        experimentCount: Number(r.experiment_count),
      })),
    );
  });
}
